/**
 * PortfolioBacktester — realistic multi-coin backtest with a single shared balance.
 *
 * Why this exists
 * ───────────────
 * The original Backtester runs each symbol in isolation (its own BacktestSimulator,
 * its own balance).  Aggregating results by summing per-coin returns is misleading:
 *   • Capital is never actually shared — a coin that is "in cash" can't fund a trade
 *     on another coin.
 *   • Position sizing is computed against a per-coin budget, so with 34 coins and
 *     $100 each position is comically small.
 *   • There is no slot limit — in theory all 34 coins could be in a position at once.
 *
 * This class mirrors what the live PaperTrader + RiskManager already do:
 *   • One shared balance
 *   • Max N concurrent open positions (configurable)
 *   • Candles are processed in chronological order across all symbols simultaneously
 *   • Each position is sized as (balance / maxOpenPositions) so capital is deployed
 *     evenly when all slots are filled
 *   • Optional hot-swap: if all slots are full but a high-confidence BUY signal fires,
 *     the worst losing position is closed to make room
 *
 * Anti-overfitting principles
 * ───────────────────────────
 * Every decision at candle i uses ONLY candles[0..i].  No future data leaks in.
 *   • ATR position sizing uses ATR computed from the slice up to candle i
 *   • ADX regime filter uses ADX from the same past slice
 *   • Rolling Kelly uses only trades that were CLOSED before step i
 *   • swapMinHoldBars is a structural anti-churn rule, not a fitted parameter
 */

import SignalAggregator from '../engine/signalAggregator.js';
import { BacktestSimulator } from './backtestSimulator.js';
import { calculateMetrics } from './metrics.js';
import { calculateADX, isBullTrend } from '../utils/indicators.js';
import { getFearGreedValue } from '../data/fearGreed.js';
import { buildMtfIndex, mtfAlignScore, buildMtf4hIndex, mtf4hMomentumScore } from '../utils/mtfAlignment.js';
import signalBus from '../signals/signalBus.js';

const MIN_WARMUP = 50;
const ADX_LOOKBACK = 50;

export class PortfolioBacktester {
  constructor(symbolStrategies, config = {}) {
    this.symbolStrategies = symbolStrategies;
    this.config = config;
    this.maxOpenPositions = Number(config.maxOpenPositions ?? 5);
    this.swapEnabled = Boolean(config.swapEnabled ?? false);
    this.swapMinConfidence = Number(config.swapMinConfidence ?? 0.75);
    this.swapMinHoldBars = Number(config.swapMinHoldBars ?? 3);
    this.regimeFilter = Boolean(config.regimeFilter ?? false);
    this.regimeADXThreshold = Number(config.regimeADXThreshold ?? 20);
    this.atrPositionSizing = Boolean(config.atrPositionSizing ?? false);
    this.atrPeriod = Number(config.atrPeriod ?? 14);
    this.kellyEnabled = Boolean(config.kellyEnabled ?? false);
    this.kellyWindow = Number(config.kellyWindow ?? 20);
    this.kellyFraction = Number(config.kellyFraction ?? 0.25);
    this.breakEvenTriggerPct = Number(config.breakEvenTriggerPct ?? 0);
    this.volumeFilter = Boolean(config.volumeFilter ?? false);
    this.volumePeriod = Number(config.volumePeriod ?? 20);
    this.volumeMultiplier = Number(config.volumeMultiplier ?? 1.5);
    this.atrSLTP = Boolean(config.atrSLTP ?? false);
    this.atrSLMultiplier = Number(config.atrSLMultiplier ?? 1.5);
    this.atrTPMultiplier = Number(config.atrTPMultiplier ?? 3.0);
    this.correlationFilter = Boolean(config.correlationFilter ?? false);
    this.correlationThreshold = Number(config.correlationThreshold ?? 0.8);
    this.fearGreedFilter = Boolean(config.fearGreedFilter ?? false);
    this.fearGreedThreshold = Number(config.fearGreedThreshold ?? 50);
    this.fearGreedData = Array.isArray(config.fearGreedData) ? config.fearGreedData : null;
    this.macroFilter = Boolean(config.macroFilter ?? false);
    this.macroEMAPeriod = Number(config.macroEMAPeriod ?? 200);
    this.macroSizeReduceFactor = Number(config.macroSizeReduceFactor ?? 0.5);
    // MTF (multi-timeframe) entry alignment filter.
    // When enabled, a 12h BUY entry is skipped when the last `mtfAlignBars` x 15m
    // candles are predominantly bearish (green fraction < mtfMinScore).
    // mtfSymbolCandles: { 'BTC/USDT': [...15m candles], ... } — symbols without
    // 15m data are silently passed through (filter not applied for them).
    this.mtfFilter = Boolean(config.mtfFilter ?? false);
    this.mtfSymbolCandles = config.mtfSymbolCandles ?? {};
    this.mtfAlignBars = Number(config.mtfAlignBars ?? 16); // 16 × 15m = 4h
    this.mtfMinScore = Number(config.mtfMinScore ?? 0.5);  // 50% green = bullish
    this.mtfReduceFactor = Number(config.mtfReduceFactor ?? 0); // 0 = skip; >0 = reduce
    // Confidence-proportional position sizing.
    // Position size is scaled by signal confidence relative to a neutral midpoint.
    // conf=1.0 → confSizingMax×, conf=confSizingMid → 1.0×, low conf → confSizingMin×.
    this.confSizing = Boolean(config.confSizing ?? false);
    this.confSizingMid = Number(config.confSizingMid ?? 0.65);
    this.confSizingMax = Number(config.confSizingMax ?? 1.5);
    this.confSizingMin = Number(config.confSizingMin ?? 0.6);
    // MTF early exit — use 15m candles to exit a losing position early when the
    // short-term trend turns strongly bearish, freeing the slot for a better entry.
    // Only fires when: unrealizedPnl < -mtfEarlyExitMinLoss AND 15m score < mtfEarlyExitScore.
    this.mtfEarlyExit = Boolean(config.mtfEarlyExit ?? false);
    this.mtfEarlyExitScore = Number(config.mtfEarlyExitScore ?? 0.35);
    this.mtfEarlyExitMinLoss = Number(config.mtfEarlyExitMinLoss ?? 0.02);
    // 4h momentum filter — stronger than 15m green-candle counting.
    // Uses EMA(8)/EMA(21) crossover + RSI direction on 4h candles.
    this.mtf4hFilter = Boolean(config.mtf4hFilter ?? false);
    this.mtf4hSymbolCandles = config.mtf4hSymbolCandles ?? {};
    this.mtf4hMinScore = Number(config.mtf4hMinScore ?? 0.55);
    this.mtf4hLookback = Number(config.mtf4hLookback ?? 21);
    // Regime-aware sizing: scale position size by ADX strength.
    // ADX > regimeBoostThresh → multiply by regimeBoostFactor (up to 1.3×)
    // ADX < regimePenaltyThresh → multiply by regimePenaltyFactor (down to 0.5×)
    this.regimeSizing = Boolean(config.regimeSizing ?? false);
    this.regimeBoostThresh = Number(config.regimeBoostThresh ?? 25);
    this.regimePenaltyThresh = Number(config.regimePenaltyThresh ?? 15);
    this.regimeBoostFactor = Number(config.regimeBoostFactor ?? 1.3);
    this.regimePenaltyFactor = Number(config.regimePenaltyFactor ?? 0.5);
    // Cap candle slice length fed to strategies — avoids O(N²) on large datasets.
    // 0 = no cap (default, safe for 12h). Set to e.g. 300 for 15m performance.
    this.maxLookback = Number(config.maxLookback ?? 0);
    // Per-symbol slippage overrides — higher for low-liquidity alts.
    // Defined as a Map: symbol → slippagePct (e.g. 'ACH/USDC' → 0.003).
    // Falls back to the global risk.slippagePct when not set.
    this.symbolSlippage = config.symbolSlippage ?? {};

    const symbolCount = Object.keys(symbolStrategies).length;
    signalBus.setMaxListeners(Math.max(signalBus.getMaxListeners(), symbolCount + 5));

    this.aggregators = Object.fromEntries(
      Object.entries(symbolStrategies).map(([sym, strats]) => [
        sym,
        new SignalAggregator(strats, config.signals ?? {}),
      ]),
    );
  }

  run(symbolCandles) {
    const symbols = Object.keys(symbolCandles);
    if (!symbols.length) throw new Error('No candles provided');

    const initialBalance = Number(this.config.risk?.initialBalance ?? 1000);
    const basePct = 1 / this.maxOpenPositions;

    const simulator = new BacktestSimulator({
      ...this.config.risk,
      initialBalance,
      maxPositionPct: basePct,
      breakEvenTriggerPct: this.breakEvenTriggerPct,
    });

    const allData = this.#precomputeData(symbolCandles, symbols);
    const correlationMatrix = this.correlationFilter
      ? this.#computeCorrelationMatrix(symbolCandles, symbols)
      : null;

    // Build per-symbol 12h→15m index for MTF alignment filter AND early exit
    const mtfIndex = {};
    if (this.mtfFilter || this.mtfEarlyExit) {
      for (const sym of symbols) {
        const c15m = this.mtfSymbolCandles[sym];
        if (c15m?.length) {
          mtfIndex[sym] = buildMtfIndex(symbolCandles[sym], c15m);
        }
      }
    }

    // Build per-symbol 12h→4h index for 4h momentum filter
    const mtf4hIndex = {};
    if (this.mtf4hFilter) {
      for (const sym of symbols) {
        const c4h = this.mtf4hSymbolCandles[sym];
        if (c4h?.length) {
          mtf4hIndex[sym] = buildMtf4hIndex(symbolCandles[sym], c4h);
        }
      }
    }

    const maxLen = Math.max(...symbols.map((s) => symbolCandles[s].length));
    const positionOpenedStep = {};
    const filtersApplied = {
      regime: 0,
      volume: 0,
      fearGreed: 0,
      correlation: 0,
      mtfEarlyExit: 0,
    };

    for (let step = 0; step < maxLen - MIN_WARMUP; step++) {
      const stepSignals = {};
      const buyQueue = [];

      let medianATR = null;
      if (this.atrPositionSizing) {
        const vals = symbols.map((s) => allData[s]?.[step]?.atrPct).filter((v) => v > 0);
        if (vals.length) medianATR = this.#median(vals);
      }

      // Macro bear filter: check BTC vs EMA(emaPeriod) using candles up to this step
      let macroBull = true;
      if (this.macroFilter && (symbolCandles['BTC/USDC'] ?? symbolCandles['BTC/USDT'])) {
        const btcCandles = (symbolCandles['BTC/USDC'] ?? symbolCandles['BTC/USDT']).slice(0, step + MIN_WARMUP + 1);
        macroBull = isBullTrend(btcCandles, this.macroEMAPeriod);
      }

      // MTF early exit: for each open losing position, check if 15m trend is strongly
      // bearish. If so, close immediately to free the slot for a better opportunity.
      if (this.mtfEarlyExit) {
        const openPositions = simulator.getStatus().positions;
        for (const pos of openPositions) {
          const sym = pos.symbol;
          const c15m = this.mtfSymbolCandles[sym];
          if (!c15m?.length || !mtfIndex[sym]) continue;

          const candle12hIdx = step + MIN_WARMUP;
          const last15mIdx = mtfIndex[sym][candle12hIdx];
          if (last15mIdx < 0) continue;

          const score = mtfAlignScore(c15m, last15mIdx, this.mtfAlignBars);
          if (score >= this.mtfEarlyExitScore) continue; // trend ok, hold

          const d = allData[sym]?.[step];
          if (!d) continue;
          const unrealizedPct = (d.price - pos.entryPrice) / pos.entryPrice;
          if (unrealizedPct > -this.mtfEarlyExitMinLoss) continue; // not losing enough yet

          // Both conditions met: losing position + strongly bearish 15m → early exit
          simulator.setTimestamp(d.timestamp);
          simulator.execute(sym, 'SELL', d.price);
          delete positionOpenedStep[sym];
          filtersApplied.mtfEarlyExit++;
        }
      }

      for (const sym of symbols) {
        const d = allData[sym]?.[step];
        if (!d) continue;

        stepSignals[sym] = d;
        simulator.setTimestamp(d.timestamp);

        if (d.decision === 'BUY') {
          simulator.execute(sym, 'HOLD', d.price);
          buyQueue.push({ sym, d });
        } else {
          simulator.execute(sym, d.decision, d.price);
        }
      }

      const openSymbols = new Set(simulator.getStatus().positions.map((p) => p.symbol));
      for (const sym of Object.keys(positionOpenedStep)) {
        if (!openSymbols.has(sym)) delete positionOpenedStep[sym];
      }

      buyQueue.sort((a, b) => b.d.confidence - a.d.confidence);

      for (const { sym, d } of buyQueue) {
        if (this.regimeFilter && !d.isTrending) {
          filtersApplied.regime++;
          continue;
        }

        if (this.volumeFilter && !d.volumeOk) {
          filtersApplied.volume++;
          continue;
        }

        if (this.fearGreedFilter) {
          const fearGreedValue = getFearGreedValue(this.fearGreedData, d.timestamp);
          if (fearGreedValue >= this.fearGreedThreshold) {
            filtersApplied.fearGreed++;
            continue;
          }
        }

        const status = simulator.getStatus();
        if (status.positions.some((p) => p.symbol === sym)) continue;

        if (this.correlationFilter) {
          const isBlocked = status.positions.some((p) => {
            const correlation = correlationMatrix?.[sym]?.[p.symbol];
            return Number.isFinite(correlation) && correlation > this.correlationThreshold;
          });
          if (isBlocked) {
            filtersApplied.correlation++;
            continue;
          }
        }

        const openCount = status.positions.length;
        let positionPct = this.#computePositionPct(
          d,
          basePct,
          medianATR,
          simulator.getTrades(),
        );
        // Macro bear filter: halve position size when BTC is below its EMA
        if (this.macroFilter && !macroBull) {
          positionPct *= this.macroSizeReduceFactor;
        }

        // Regime-aware sizing: boost in trends, reduce in chop
        if (this.regimeSizing && d.adxValue != null) {
          if (d.adxValue >= this.regimeBoostThresh) {
            positionPct *= this.regimeBoostFactor;
          } else if (d.adxValue < this.regimePenaltyThresh) {
            positionPct *= this.regimePenaltyFactor;
          }
        }

        // MTF alignment filter: check if last 4h of 15m candles are constructive
        if (this.mtfFilter && mtfIndex[sym]) {
          const candle12hIdx = step + MIN_WARMUP;
          const last15mIdx = mtfIndex[sym][candle12hIdx];
          const score = mtfAlignScore(
            this.mtfSymbolCandles[sym],
            last15mIdx,
            this.mtfAlignBars,
          );
          if (score < this.mtfMinScore) {
            if (this.mtfReduceFactor > 0) {
              positionPct *= this.mtfReduceFactor;
            } else {
              filtersApplied.mtf = (filtersApplied.mtf ?? 0) + 1;
              continue;
            }
          }
        }

        // 4h momentum filter: EMA crossover + RSI on 4h candles
        if (this.mtf4hFilter && mtf4hIndex[sym]) {
          const candle12hIdx = step + MIN_WARMUP;
          const last4hIdx = mtf4hIndex[sym][candle12hIdx];
          const score = mtf4hMomentumScore(
            this.mtf4hSymbolCandles[sym],
            last4hIdx,
            this.mtf4hLookback,
          );
          if (score < this.mtf4hMinScore) {
            filtersApplied.mtf4h = (filtersApplied.mtf4h ?? 0) + 1;
            continue;
          }
        }
        const entryOpts = {
          positionPct,
          // Fill new BUY orders at the next candle's open (not the signal close)
          // to eliminate execution lookahead.
          fillPrice: d.nextOpen,
          // Per-symbol slippage: higher for low-liquidity alts.
          slippagePct: this.symbolSlippage[sym],
        };

        if (this.atrSLTP && d.atrPct > 0) {
          const atrValue = d.atrPct * d.nextOpen;
          entryOpts.stopLossPrice = d.nextOpen - this.atrSLMultiplier * atrValue;
          entryOpts.takeProfitPrice = d.nextOpen + this.atrTPMultiplier * atrValue;
        }

        simulator.setTimestamp(d.timestamp);

        if (openCount < this.maxOpenPositions) {
          const result = simulator.execute(sym, 'BUY', d.price, entryOpts);
          if (result) positionOpenedStep[sym] = step;
        } else if (this.swapEnabled && d.confidence >= this.swapMinConfidence) {
          const candidate = this.#findSwapCandidate(
            simulator,
            stepSignals,
            positionOpenedStep,
            step,
          );
          if (candidate) {
            const cSig = stepSignals[candidate.symbol];
            simulator.setTimestamp(cSig?.timestamp ?? d.timestamp);
            simulator.execute(candidate.symbol, 'SELL', cSig?.price ?? candidate.entryPrice);
            delete positionOpenedStep[candidate.symbol];

            simulator.setTimestamp(d.timestamp);
            const result = simulator.execute(sym, 'BUY', d.price, entryOpts);
            if (result) positionOpenedStep[sym] = step;
          }
        }
      }
    }

    const trades = simulator.getTrades();
    const equityCurve = simulator.getEquityCurve();
    const finalBalance = equityCurve.at(-1)?.balance ?? initialBalance;

    const symbolStats = {};
    for (const sym of symbols) {
      const symTrades = trades.filter((t) => t.symbol === sym);
      symbolStats[sym] = {
        trades: symTrades.length,
        pnl: Number(symTrades.reduce((s, t) => s + Number(t.pnl ?? 0), 0).toFixed(2)),
        wins: symTrades.filter((t) => Number(t.pnl) > 0).length,
      };
    }

    return {
      trades,
      equityCurve,
      finalBalance,
      initialBalance,
      metrics: calculateMetrics(trades, equityCurve, initialBalance),
      symbolStats,
      regimeFilteredCount: filtersApplied.regime,
      filtersApplied,
      config: {
        maxOpenPositions: this.maxOpenPositions,
        basePct,
        swapEnabled: this.swapEnabled,
        swapMinConfidence: this.swapMinConfidence,
        swapMinHoldBars: this.swapMinHoldBars,
        regimeFilter: this.regimeFilter,
        regimeADXThreshold: this.regimeADXThreshold,
        atrPositionSizing: this.atrPositionSizing,
        kellyEnabled: this.kellyEnabled,
        kellyFraction: this.kellyFraction,
        breakEvenTriggerPct: this.breakEvenTriggerPct,
        volumeFilter: this.volumeFilter,
        volumePeriod: this.volumePeriod,
        volumeMultiplier: this.volumeMultiplier,
        atrSLTP: this.atrSLTP,
        atrSLMultiplier: this.atrSLMultiplier,
        atrTPMultiplier: this.atrTPMultiplier,
        correlationFilter: this.correlationFilter,
        correlationThreshold: this.correlationThreshold,
        fearGreedFilter: this.fearGreedFilter,
        fearGreedThreshold: this.fearGreedThreshold,
        symbols: symbols.length,
      },
    };
  }

  #precomputeData(symbolCandles, symbols) {
    const allData = {};

    for (const sym of symbols) {
      const candles = symbolCandles[sym];
      allData[sym] = [];

      for (let i = MIN_WARMUP; i < candles.length; i++) {
        const start = this.maxLookback > 0 ? Math.max(0, i - this.maxLookback) : 0;
        const slice = candles.slice(start, i + 1);
        const candle = slice.at(-1);
        const result = this.aggregators[sym].aggregate(slice, sym, this.config.signals ?? {});

        allData[sym].push({
          decision: result.decision,
          confidence: result.confidence,
          price: Number(candle.close),
          // nextOpen: realistic entry fill — next candle's open price.
          // If we're at the last candle, fall back to the current close.
          nextOpen: candles[i + 1] != null ? Number(candles[i + 1].open) : Number(candle.close),
          timestamp: Number(candle.timestamp),
          atrPct: this.#computeATRpct(slice),
          isTrending: this.#computeIsTrending(slice),
          adxValue: this.#computeADX(slice),
          volumeOk: this.#computeVolumeOk(slice),
        });
      }
    }

    return allData;
  }

  #computeATRpct(candles) {
    const period = this.atrPeriod;
    if (candles.length < period + 2) return null;

    const recent = candles.slice(-(period + 1));
    let sum = 0;
    let count = 0;
    for (let i = 1; i < recent.length; i++) {
      const h = Number(recent[i].high);
      const l = Number(recent[i].low);
      const pc = Number(recent[i - 1].close);
      sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
      count++;
    }
    if (!count) return null;
    const close = Number(candles.at(-1).close);
    return close > 0 ? (sum / count) / close : null;
  }

  #computeIsTrending(candles) {
    if (!this.regimeFilter) return true;
    if (candles.length < 30) return true;

    const recent = candles.slice(-ADX_LOOKBACK);
    const highs = recent.map((c) => Number(c.high));
    const lows = recent.map((c) => Number(c.low));
    const closes = recent.map((c) => Number(c.close));

    const adxValues = calculateADX(highs, lows, closes, 14);
    const lastADX = adxValues.at(-1)?.adx;
    return Number.isFinite(lastADX) ? lastADX >= this.regimeADXThreshold : true;
  }

  #computeADX(candles) {
    if (candles.length < 30) return null;
    const recent = candles.slice(-ADX_LOOKBACK);
    const highs = recent.map((c) => Number(c.high));
    const lows = recent.map((c) => Number(c.low));
    const closes = recent.map((c) => Number(c.close));
    const adxValues = calculateADX(highs, lows, closes, 14);
    const lastADX = adxValues.at(-1)?.adx;
    return Number.isFinite(lastADX) ? lastADX : null;
  }

  #computeVolumeOk(candles) {
    if (candles.length < this.volumePeriod + 1) return true;
    const previousCandles = candles.slice(-(this.volumePeriod + 1), -1);
    if (!previousCandles.length) return true;

    const avgVolume = previousCandles.reduce((sum, candle) => sum + Number(candle.volume ?? 0), 0) / previousCandles.length;
    const currentVolume = Number(candles.at(-1)?.volume ?? 0);
    return currentVolume >= avgVolume * this.volumeMultiplier;
  }

  #computeCorrelationMatrix(symbolCandles, symbols) {
    const returnsBySymbol = Object.fromEntries(
      symbols.map((sym) => {
        const candles = symbolCandles[sym] ?? [];
        const firstHalf = candles.slice(0, Math.max(2, Math.floor(candles.length / 2)));
        return [sym, this.#computeReturns(firstHalf)];
      }),
    );

    const matrix = Object.fromEntries(symbols.map((sym) => [sym, { [sym]: 1 }]));
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const a = symbols[i];
        const b = symbols[j];
        const correlation = this.#pearsonCorrelation(returnsBySymbol[a], returnsBySymbol[b]);
        matrix[a][b] = correlation;
        matrix[b] = matrix[b] ?? { [b]: 1 };
        matrix[b][a] = correlation;
      }
    }
    return matrix;
  }

  #computeReturns(candles) {
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      const prevClose = Number(candles[i - 1]?.close);
      const close = Number(candles[i]?.close);
      if (prevClose > 0 && close > 0) {
        returns.push(Math.log(close / prevClose));
      }
    }
    return returns;
  }

  #pearsonCorrelation(x, y) {
    const length = Math.min(x.length, y.length);
    if (length < 2) return 0;

    const xs = x.slice(-length);
    const ys = y.slice(-length);
    const xMean = xs.reduce((sum, value) => sum + value, 0) / length;
    const yMean = ys.reduce((sum, value) => sum + value, 0) / length;

    let numerator = 0;
    let xVariance = 0;
    let yVariance = 0;

    for (let i = 0; i < length; i++) {
      const dx = xs[i] - xMean;
      const dy = ys[i] - yMean;
      numerator += dx * dy;
      xVariance += dx * dx;
      yVariance += dy * dy;
    }

    const denominator = Math.sqrt(xVariance * yVariance);
    return denominator > 0 ? numerator / denominator : 0;
  }

  #computePositionPct(d, basePct, medianATR, closedTrades) {
    let pct = basePct;

    if (this.atrPositionSizing && medianATR != null && d.atrPct > 0) {
      const scale = medianATR / d.atrPct;
      pct = basePct * Math.max(0.5, Math.min(2.0, scale));
    }

    if (this.kellyEnabled && closedTrades.length >= this.kellyWindow) {
      const recent = closedTrades.slice(-this.kellyWindow);
      const wins = recent.filter((t) => t.pnl > 0);
      const losses = recent.filter((t) => t.pnl <= 0);

      if (wins.length > 0 && losses.length > 0) {
        const p = wins.length / recent.length;
        const avgWin = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
        const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
        const b = avgWin / avgLoss;
        const kelly = Math.max(0, (p * b - (1 - p)) / b);
        const adj = kelly * this.kellyFraction;

        if (adj > 0) {
          pct = Math.max(pct * 0.5, Math.min(pct * 2.0, adj));
        }
      }
    }

    // Confidence-proportional sizing: scale position size linearly with signal strength.
    // At confidence = confSizingMid → 1.0× (no change); above → up to confSizingMax×;
    // below → down to confSizingMin×. Uses linear interpolation through the midpoint.
    if (this.confSizing && Number.isFinite(d.confidence) && d.confidence > 0) {
      const conf = d.confidence;
      const mid  = this.confSizingMid;
      let scale;
      if (conf >= mid) {
        scale = 1 + (conf - mid) / (1 - mid) * (this.confSizingMax - 1);
      } else {
        scale = this.confSizingMin + (conf / mid) * (1 - this.confSizingMin);
      }
      pct *= Math.max(this.confSizingMin, Math.min(this.confSizingMax, scale));
    }

    return pct;
  }

  #findSwapCandidate(simulator, stepSignals, positionOpenedStep, currentStep) {
    const { positions } = simulator.getStatus();
    if (!positions.length) return null;

    let worstPnl = 0;
    let candidate = null;

    for (const pos of positions) {
      const openedAt = positionOpenedStep[pos.symbol] ?? currentStep;
      if (currentStep - openedAt < this.swapMinHoldBars) continue;

      const currentPrice = stepSignals[pos.symbol]?.price ?? pos.entryPrice;
      const unrealizedPnl = (currentPrice - pos.entryPrice) * pos.qty;

      if (unrealizedPnl < worstPnl) {
        worstPnl = unrealizedPnl;
        candidate = pos;
      }
    }

    return candidate;
  }

  #median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}

export default PortfolioBacktester;

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
import { trailingReturn } from '../utils/momentum.js';
import signalBus from '../signals/signalBus.js';
import {
  calcCorrelationCap,
  calcWeeklyDDBreaker,
  calcPositionAgingExit,
} from '../risk/portfolioRisk.js';
import { getContextAsOf } from '../data/marketContext.js';
import { calcFearGreedAdjustedThreshold } from '../core/filters.js';
import { classifySeries, REGIME_LABELS } from '../engine/regimeClassifier.js';
import { computeBearPolicy } from '../engine/regimeRouter.js';

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
    // Phase 3: BTC dominance gate (block alt entries when BTC.D 7d SMA rising)
    this.btcDominanceGate = Boolean(config.btcDominance?.enabled ?? false);
    this.btcDominanceThresholdPp = Number(config.btcDominance?.blockThresholdPp ?? 1.0);
    // Phase 3: Fear & Greed entry-threshold modulator
    this.fearGreedModulator = Boolean(config.fearGreed?.enabled ?? false);
    this.fearGreedCfg = config.fearGreed ?? null;
    // Phase 7: portfolio risk gates — all opt-in via config.risk.*
    // weeklyDDBreaker: pause new entries after 7-day rolling P&L breaches threshold
    this.weeklyDDBreaker = Boolean(config.risk?.weeklyDDBreaker?.enabled ?? false);
    this.weeklyDDLossThreshold = Number(config.risk?.weeklyDDBreaker?.lossThreshold ?? 0.10);
    this.weeklyDDCooldownHours = Number(config.risk?.weeklyDDBreaker?.cooldownHours ?? 72);
    // positionAgingExit: close positions that hit `maxAgeBars` without TP/SL
    this.positionAgingExit = Boolean(config.risk?.positionAgingExit?.enabled ?? false);
    this.positionAgingMaxBars = Number(config.risk?.positionAgingExit?.maxAgeBars ?? 14);
    this.candleIntervalMs = Number(config.candleIntervalMs ?? 12 * 60 * 60 * 1000);
    // Phase 6a: bear policy — block new entries + cash-exit on regime transition
    this.bearPolicyEnabled = Boolean(config.bearPolicy?.enabled ?? false);
    this.skipBearTrendEntries = Boolean(config.skipBearTrendEntries ?? false); // loss-avoidance: block steady-state BEAR_TREND entries
    // Momentum-leader selection: prefer/require strong trailing-return coins.
    this.momentumLookback = Number(config.momentumLookback ?? 20);      // bars for the relative-strength window
    this.momentumMinPct = Number.isFinite(config.momentumMinPct) ? Number(config.momentumMinPct) : null; // filter: skip BUY if mom < this
    this.momentumRank = Boolean(config.momentumRank ?? false);          // fill slots by momentum instead of confidence
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
    this.regimeSizeMult = config.regimeSizeMult ?? null; // optional per-regime-label size multiplier (exposure tilt)
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
    // Per-symbol risk overrides — { 'BTC/USDC': { stopLossPct, takeProfitPct }, ... }
    // When present, each BUY uses the symbol's SL/TP instead of the global risk
    // config, matching how the live bot resolves perSymbol overrides.
    this.symbolRisk = config.symbolRisk ?? {};
    // Per-symbol minConfidence overrides — { 'BTC/USDC': 0.55, ... }
    // Applied to each symbol's SignalAggregator so the vote threshold matches
    // the live bot's perSymbol.minConfidence.
    const rawSymbolMinConfidence = config.symbolMinConfidence ?? {};
    // Phase 1 transition: scale every minConfidence by this factor (default 1.0).
    // The Phase 1 aggregator counts HOLDs in the denominator (a more honest formula)
    // which made the old per-symbol thresholds too strict. This single knob keeps
    // the bot tradeable until Phase 4 walk-forward retunes per-symbol values from
    // scratch — set back to 1.0 then. MUST match config.risk.confidenceThresholdScale
    // applied by getSignalConfigForSymbol() so live ≡ backtest.
    this.confidenceThresholdScale = Number.isFinite(config.confidenceThresholdScale)
      ? config.confidenceThresholdScale
      : 1;
    const scaleMinConf = (mc) => {
      if (!Number.isFinite(mc)) return mc;
      return Math.max(0, Math.min(1, mc * this.confidenceThresholdScale));
    };
    // Store the SCALED values so every read (constructor + per-candle aggregate
    // override path on line ~485) picks up the same scaled threshold. Without
    // this, the per-candle override would re-apply the raw value and undo the
    // construction-time scaling.
    this.symbolMinConfidence = Object.fromEntries(
      Object.entries(rawSymbolMinConfidence).map(([sym, mc]) => [sym, scaleMinConf(mc)]),
    );
    const scaledGlobalMinConf = (() => {
      const base = Number(config.signals?.minConfidence);
      return Number.isFinite(base) ? scaleMinConf(base) : base;
    })();
    // Also scale the global signals.minConfidence stored on this.config so that
    // the per-candle `symSignals` spread (which reads this.config.signals) sees
    // the scaled value too.
    if (Number.isFinite(scaledGlobalMinConf)) {
      this.config = {
        ...this.config,
        signals: {
          ...(this.config.signals ?? {}),
          minConfidence: scaledGlobalMinConf,
        },
      };
    }

    const symbolCount = Object.keys(symbolStrategies).length;
    signalBus.setMaxListeners(Math.max(signalBus.getMaxListeners(), symbolCount + 5));

    this.aggregators = Object.fromEntries(
      Object.entries(symbolStrategies).map(([sym, strats]) => {
        const aggSignalConfig = {
          ...(config.signals ?? {}),
          ...(Number.isFinite(scaledGlobalMinConf) && { minConfidence: scaledGlobalMinConf }),
          ...(this.symbolMinConfidence[sym] != null && {
            minConfidence: this.symbolMinConfidence[sym],
          }),
        };
        return [sym, new SignalAggregator(strats, aggSignalConfig)];
      }),
    );
  }

  run(symbolCandles) {
    const symbols = Object.keys(symbolCandles);
    if (!symbols.length) throw new Error('No candles provided');

    const initialBalance = Number(this.config.risk?.initialBalance ?? 1000);
    // Per-position base size. Default = 1/maxOpenPositions (full deployment when all
    // slots fill). `basePctOverride` lets tooling model a specific per-position size
    // (e.g. live's maxPositionPct=0.15 = 60% max deployment) — additive, off by default.
    const basePct = Number(this.config.risk?.basePctOverride) > 0
      ? Number(this.config.risk.basePctOverride)
      : 1 / this.maxOpenPositions;

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

    // ── Regime series (Phase 4) ────────────────────────────────────────────
    // Pre-compute BTC regime at every bar so per-step logic can branch on it
    // deterministically. classifySeries handles all warm-up + hysteresis.
    const btcKey = symbolCandles['BTC/USDC'] ? 'BTC/USDC' : (symbolCandles['BTC/USDT'] ? 'BTC/USDT' : null);
    const regimeSeries = btcKey
      ? classifySeries(symbolCandles[btcKey], this.config.regimeClassifier ?? {})
      : [];
    // Index regimeSeries by timestamp for fast per-step lookup.
    const regimeByTs = new Map();
    for (const r of regimeSeries) regimeByTs.set(r.ts, r.regime);

    const maxLen = Math.max(...symbols.map((s) => symbolCandles[s].length));
    const positionOpenedStep = {};
    const filtersApplied = {
      regime: 0,
      volume: 0,
      fearGreed: 0,
      correlation: 0,
      mtfEarlyExit: 0,
      positionAging: 0,
      weeklyDDBreaker: 0,
      btcDominance: 0,
      bearPolicy: 0,
      bearCashExit: 0,
    };

    // Phase 6a: track the regime label as of the previous step so we can
    // detect transitions WITHIN the backtest's evolving timeline.
    let prevRegimeLabel = null;

    for (let step = 0; step < maxLen - MIN_WARMUP; step++) {
      const stepSignals = {};
      const buyQueue = [];

      // Resolve current regime at this step from the precomputed series.
      // The series ts must match the BTC candle ts at this step index.
      let currentRegimeLabel = null;
      if (btcKey) {
        const btcSlice = symbolCandles[btcKey].slice(0, step + MIN_WARMUP + 1);
        const tsAtStep = btcSlice.at(-1)?.timestamp;
        if (tsAtStep != null) {
          currentRegimeLabel = regimeByTs.get(tsAtStep) ?? null;
        }
      }
      const regimeChanged = currentRegimeLabel != null
        && prevRegimeLabel != null
        && currentRegimeLabel !== prevRegimeLabel;
      const bearPolicy = computeBearPolicy({
        regime: currentRegimeLabel,
        regimeChanged,
        policy: { enabled: this.bearPolicyEnabled },
      });

      // Phase 6a cash-exit-on-bear: on the BAR regime transitions into BEAR,
      // close every open position. Subsequent BEAR bars only block new
      // entries (handled in the buy-queue filter below) — open positions
      // continue under normal SL/TP/break-even management.
      if (bearPolicy.shouldCashExitOpen) {
        const openPositions = simulator.getStatus().positions;
        for (const pos of openPositions) {
          const sym = pos.symbol;
          const d = allData[sym]?.[step];
          if (!d) continue;
          simulator.setTimestamp(d.timestamp);
          simulator.execute(sym, 'SELL', d.price);
          delete positionOpenedStep[sym];
          filtersApplied.bearCashExit += 1;
        }
      }
      prevRegimeLabel = currentRegimeLabel;

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

      // ── Position aging exit (Phase 7) ───────────────────────────────────
      // Close positions open more than maxAgeBars without hitting TP/SL.
      // Frees capital sitting in sluggish trades; non-adaptive rule (no
      // overfit risk).
      if (this.positionAgingExit) {
        const openPositions = simulator.getStatus().positions;
        for (const pos of openPositions) {
          const sym = pos.symbol;
          const d = allData[sym]?.[step];
          if (!d) continue;
          const positionEntryTs = simulator.positions.get(sym)?.entryTime;
          if (positionEntryTs == null) continue;
          const aging = calcPositionAgingExit({
            entryTs: positionEntryTs,
            nowTs: d.timestamp,
            candleIntervalMs: this.candleIntervalMs,
            maxAgeBars: this.positionAgingMaxBars,
          });
          if (aging.shouldExit) {
            simulator.setTimestamp(d.timestamp);
            simulator.execute(sym, 'SELL', d.price);
            delete positionOpenedStep[sym];
            filtersApplied.positionAging = (filtersApplied.positionAging ?? 0) + 1;
          }
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

      // Slot allocation: by default highest-confidence first. Momentum-leader mode
      // fills the limited slots with the strongest trailing-return coins instead.
      if (this.momentumRank) {
        buyQueue.sort((a, b) => (Number(b.d.mom ?? 0)) - (Number(a.d.mom ?? 0)));
      } else {
        buyQueue.sort((a, b) => b.d.confidence - a.d.confidence);
      }

      // ── Weekly DD circuit breaker (Phase 7) ─────────────────────────────
      // Check ONCE per step (not per candidate) so all queued buys see the
      // same gate decision. When triggered, every BUY at this step is
      // rejected; existing positions are still managed normally.
      let weeklyDDBlock = null;
      if (this.weeklyDDBreaker && buyQueue.length > 0) {
        const nowTs = buyQueue[0]?.d?.timestamp ?? Date.now();
        const breaker = calcWeeklyDDBreaker({
          recentTrades: simulator.getTrades(),
          initialBalance,
          lossThreshold: this.weeklyDDLossThreshold,
          cooldownHours: this.weeklyDDCooldownHours,
          nowMs: nowTs,
        });
        if (breaker.blocked) weeklyDDBlock = breaker;
      }

      for (const { sym, d } of buyQueue) {
        if (weeklyDDBlock) {
          filtersApplied.weeklyDDBreaker = (filtersApplied.weeklyDDBreaker ?? 0) + 1;
          continue;
        }

        // Phase 6a: bear policy hard block on new entries
        if (bearPolicy.shouldBlockEntries) {
          filtersApplied.bearPolicy = (filtersApplied.bearPolicy ?? 0) + 1;
          continue;
        }

        // Loss-avoidance: skip new entries while the regime is BEAR_TREND (the
        // autopsy's only net-negative bucket — WR 38%). Unlike bearPolicy (which
        // only fires on transition INTO bear), this blocks steady-state bear too,
        // and frees the slot for a non-bear candidate. Off by default.
        if (this.skipBearTrendEntries && currentRegimeLabel === 'BEAR_TREND') {
          filtersApplied.bearTrendSkip = (filtersApplied.bearTrendSkip ?? 0) + 1;
          continue;
        }

        // Momentum-leader filter: skip BUYs in relative-strength laggards (weak
        // trailing return) even if they signalled — concentrate on the leaders.
        if (this.momentumMinPct != null && Number(d.mom ?? 0) < this.momentumMinPct) {
          filtersApplied.momentum = (filtersApplied.momentum ?? 0) + 1;
          continue;
        }

        // BTC Dominance gate (Phase 3) — block alt BUYs when BTC.D rising
        if (this.btcDominanceGate && !sym.startsWith('BTC/')) {
          const ctx = getContextAsOf(d.timestamp);
          if (ctx?.btcDominance?.sma7d != null) {
            const delta = ctx.btcDominance.value - ctx.btcDominance.sma7d;
            if (delta >= this.btcDominanceThresholdPp) {
              filtersApplied.btcDominance = (filtersApplied.btcDominance ?? 0) + 1;
              continue;
            }
          }
        }

        // Fear & Greed modulator (Phase 3): tighten conf in greed, loosen in fear.
        // The aggregator already evaluated against the base minConfidence; we
        // re-check with the adjusted value here. Skips silently when no F&G data.
        if (this.fearGreedModulator && this.fearGreedData) {
          const fgValue = getFearGreedValue(this.fearGreedData, d.timestamp);
          const baseMinConf = this.symbolMinConfidence[sym]
            ?? this.config.signals?.minConfidence
            ?? 0.5;
          const adjusted = calcFearGreedAdjustedThreshold(baseMinConf, fgValue, this.fearGreedCfg);
          if (adjusted.regime === 'greed' && d.confidence < adjusted.minConfidence) {
            filtersApplied.fearGreed = (filtersApplied.fearGreed ?? 0) + 1;
            continue;
          }
        }

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
          const cap = calcCorrelationCap({
            candidateSymbol: sym,
            openPositions: status.positions,
            correlationMatrix,
            threshold: this.correlationThreshold,
          });
          if (cap.blocked) {
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

        // Regime-LABEL exposure tilt (concentrate deployment where the edge lives:
        // attribution shows BULL_TREND carries P&L, bears bleed). Off unless configured.
        if (this.regimeSizeMult && currentRegimeLabel && this.regimeSizeMult[currentRegimeLabel] != null) {
          positionPct *= Number(this.regimeSizeMult[currentRegimeLabel]);
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
          // Pass atrPct so the simulator's ATR-stop path can compute SL/TP
          // when risk.atrStops.enabled is true. No-op when ATR stops disabled.
          atrPct: Number.isFinite(d.atrPct) ? d.atrPct : undefined,
        };

        // Per-symbol SL/TP overrides — match the live bot's perSymbol config.
        // Computed off the actual fill price so percentages line up with live.
        // Skipped when ATR stops are enabled (ATR overrides percent-based stops).
        const symRisk = this.symbolRisk[sym];
        const atrStopsActive = this.config.risk?.atrStops?.enabled
          && Number.isFinite(d.atrPct) && d.atrPct > 0;
        if (!atrStopsActive && symRisk?.stopLossPct != null) {
          entryOpts.stopLossPrice = d.nextOpen * (1 - Number(symRisk.stopLossPct));
        }
        if (!atrStopsActive && symRisk?.takeProfitPct != null) {
          entryOpts.takeProfitPrice = d.nextOpen * (1 + Number(symRisk.takeProfitPct));
        }

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
      // Phase 4: regime distribution across the run for diagnostics
      regimeDistribution: (() => {
        const dist = {};
        for (const r of regimeSeries) {
          if (r.regime) dist[r.regime] = (dist[r.regime] ?? 0) + 1;
        }
        return dist;
      })(),
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
        // Pass a per-symbol-aware signals config so updateConfig() inside
        // aggregate() doesn't overwrite the symbol's minConfidence with the global.
        const symSignals = {
          ...(this.config.signals ?? {}),
          ...(this.symbolMinConfidence[sym] != null && { minConfidence: this.symbolMinConfidence[sym] }),
        };
        const result = this.aggregators[sym].aggregate(slice, sym, symSignals);

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
          mom: this.#computeMomentum(slice), // trailing-return relative strength (no lookahead)
        });
      }
    }

    return allData;
  }

  // Trailing N-bar return = relative-strength / momentum proxy. Delegates to the
  // shared helper so live (`core/filters.js`) and backtest compute it identically.
  #computeMomentum(candles) {
    return trailingReturn(candles, this.momentumLookback);
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

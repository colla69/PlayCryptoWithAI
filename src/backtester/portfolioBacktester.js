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
import { applySizeFloor, computePositionSize } from '../core/positionSizing.js';
import { evaluateEntryGates, resolveDecision, byEntryPriority } from '../core/decisionCore.js';
import { BacktestSimulator } from './backtestSimulator.js';
import { calculateMetrics } from './metrics.js';
import { calculateADX, isBullTrend, computeATRPct } from '../utils/indicators.js';
import { getFearGreedValue } from '../data/fearGreed.js';
import { buildMtfIndex, mtfAlignScore, buildMtf4hIndex } from '../utils/mtfAlignment.js';
import { trailingReturn } from '../utils/momentum.js';
import { buildCorrelationMatrix } from '../utils/correlation.js';
import signalBus from '../signals/signalBus.js';
import {
  calcPositionAgingExit,
  calcEquityFromStatus,
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
    // Trailing window of the live matrix (config.correlation.period). The matrix is
    // rebuilt as of every step, the way main.js rebuilds it every cycle.
    this.correlationPeriod = Number(config.correlationPeriod ?? 60);
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
    // Live replay (runReconciliation.mjs): steps before tradeFromTs only warm up
    // the indicators, the regime series and the aggregator's multi-bar memory, the
    // way live had years of history behind its first cycle; slicing the candles
    // instead would restart every indicator. deposits: [{ ts, amount }] adds cash
    // on its date. Both off by default.
    this.tradeFromTs = Number.isFinite(config.tradeFromTs) ? config.tradeFromTs : -Infinity;
    // A deposit before tradeFromTs is already part of the starting balance.
    this.deposits = (Array.isArray(config.deposits) ? config.deposits : [])
      .filter((d) => d.ts >= this.tradeFromTs)
      .sort((a, b) => a.ts - b.ts);
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

  /**
   * @param {object} symbolCandles
   * @param {{rows?: object}} [opts] — rows from computeSignalRows() on the same
   *   candles and signal config. Stop, target and sizing settings do not change the
   *   rows, so a sweep over them computes the signals once (runStopSweep.mjs).
   */
  run(symbolCandles, { rows: precomputed = null } = {}) {
    const symbols = Object.keys(symbolCandles);
    if (!symbols.length) throw new Error('No candles provided');

    const initialBalance = Number(this.config.risk?.initialBalance ?? 1000);
    // Per-position base size. Default = 1/maxOpenPositions (full deployment when all
    // slots fill). `basePctOverride` lets tooling model a specific per-position size
    // (e.g. live's maxPositionPct=0.15 = 60% max deployment) — additive, off by default.
    const basePct = Number(this.config.risk?.basePctOverride) > 0
      ? Number(this.config.risk.basePctOverride)
      : 1 / this.maxOpenPositions;
    // Brake-product floor — parity with live's computePositionSize(). Default 0 = off.
    this.minSizeMultiplier = Number(this.config.risk?.minSizeMultiplier) || 0;

    // The backtester's knobs, in the config shape live's shared functions read.
    const gateConfig = {
      risk: {
        weeklyDDBreaker: {
          enabled: this.weeklyDDBreaker,
          lossThreshold: this.weeklyDDLossThreshold,
          cooldownHours: this.weeklyDDCooldownHours,
        },
      },
      btcDominance: { enabled: this.btcDominanceGate, blockThresholdPp: this.btcDominanceThresholdPp },
      regime: { enabled: this.regimeFilter, adxPeriod: 14, adxThreshold: this.regimeADXThreshold },
      correlation: { enabled: this.correlationFilter, threshold: this.correlationThreshold },
      mtfFilter: {
        enabled: this.mtfFilter, alignBars: this.mtfAlignBars,
        minAlignScore: this.mtfMinScore, reduceFactor: this.mtfReduceFactor,
      },
      mtf4hFilter: { enabled: this.mtf4hFilter, minScore: this.mtf4hMinScore, lookback: this.mtf4hLookback },
      momentumFilter: {
        enabled: this.momentumMinPct != null, minPct: this.momentumMinPct, lookback: this.momentumLookback,
      },
    };
    const sizingConfig = {
      atr: { enabled: this.atrPositionSizing, period: this.atrPeriod },
      macroFilter: { enabled: this.macroFilter, sizeReduceFactor: this.macroSizeReduceFactor },
      regimeSizing: {
        enabled: this.regimeSizing, adxPeriod: 14,
        boostThresh: this.regimeBoostThresh, boostFactor: this.regimeBoostFactor,
        penaltyThresh: this.regimePenaltyThresh, penaltyFactor: this.regimePenaltyFactor,
      },
      confSizing: { enabled: this.confSizing, mid: this.confSizingMid, max: this.confSizingMax, min: this.confSizingMin },
      risk: { minSizeMultiplier: this.minSizeMultiplier },
    };

    const simulator = new BacktestSimulator({
      ...this.config.risk,
      initialBalance,
      maxPositionPct: basePct,
      breakEvenTriggerPct: this.breakEvenTriggerPct,
      recordEquityOnExecute: false,
    });

    const allData = precomputed ?? this.#precomputeData(symbolCandles, symbols);

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

    // ── One clock for every symbol ─────────────────────────────────────────
    // Live evaluates every symbol at the same candle close, so a step is one
    // wall-clock bar and each symbol's row is looked up by timestamp. Stepping
    // by array index matched a late-listed or gapped symbol's k-th bar with
    // BTC's k-th bar — a different date — so slots, regime, macro and the
    // weekly DD gate all mixed bars from different times (34 of 37 symbols
    // were misaligned on the 2020 → 2026 deep data).
    const timeline = [...new Set(symbols.flatMap((s) => allData[s].map((d) => d.timestamp)))]
      .sort((a, b) => a - b);
    const rowIndexBySym = Object.fromEntries(
      symbols.map((s) => [s, new Map(allData[s].map((d, i) => [d.timestamp, i]))]),
    );
    const btcCandles = btcKey ? symbolCandles[btcKey] : null;
    // Latest bar at or before the current step, per symbol: BTC's feeds regime and
    // macro, every symbol's feeds the as-of correlation window.
    const asOfIdx = Object.fromEntries(symbols.map((s) => [s, -1]));
    // Live decides at the cycle on T from bars CLOSED by T (follow-ups item 1): the
    // regime, macro, correlation and MTF gates read those, not bar T's close.
    const closedIdx = (s, ts) => {
      const k = asOfIdx[s];
      if (k < 0) return -1;
      return Number(symbolCandles[s][k].timestamp) + this.candleIntervalMs <= ts ? k : k - 1;
    };
    // Intrabar stops (item 4): before each cycle, every open position meets the
    // 15m bars of the period that just ended, as live's 2-minute risk loop did.
    const replayPtr = Object.fromEntries(symbols.map((s) => [s, 0]));
    const lastPrice = {};
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
      // BUYs the exchange would have rejected as below min notional. Reported so
      // a small-budget run can't quietly look better than it would trade.
      minNotional: 0,
    };

    // Phase 6a: track the regime label as of the previous step so we can
    // detect transitions WITHIN the backtest's evolving timeline.
    let prevRegimeLabel = null;
    let nextDeposit = 0;

    for (let step = 0; step < timeline.length; step++) {
      const stepTs = timeline[step];
      const stepSignals = {};
      const buyQueue = [];

      // This step's row per symbol. A symbol with no bar at this time (not yet
      // listed, delisted, or a hole in its history) has no signal this step.
      const rows = {};
      const rowIdx = {};
      for (const sym of symbols) {
        const i = rowIndexBySym[sym].get(stepTs);
        if (i === undefined) continue;
        rows[sym] = allData[sym][i];
        rowIdx[sym] = i;
      }

      for (const sym of symbols) {
        const c = symbolCandles[sym];
        while (asOfIdx[sym] + 1 < c.length && Number(c[asOfIdx[sym] + 1].timestamp) <= stepTs) asOfIdx[sym]++;
      }

      // Stops between the previous cycle and this one, on 15m bars (or the 12h bar
      // itself when a symbol has no 15m data). A held symbol with no bar at this
      // step still gets its stops (item 3).
      for (const pos of simulator.getStatus().positions) {
        const sym = pos.symbol;
        const entryTs = simulator.positions.get(sym)?.entryTime ?? -Infinity;
        const fine = this.mtfSymbolCandles[sym];
        const bars = fine?.length ? fine : symbolCandles[sym];
        let k = replayPtr[sym];
        while (k < bars.length && Number(bars[k].timestamp) < entryTs) k++;
        const span = fine?.length ? 15 * 60 * 1000 : this.candleIntervalMs;
        while (k < bars.length && Number(bars[k].timestamp) + span <= stepTs) {
          lastPrice[sym] = Number(bars[k].close);
          if (simulator.replayBar(sym, bars[k])) { delete positionOpenedStep[sym]; k++; break; }
          k++;
        }
        replayPtr[sym] = k;
      }
      const btcIdx = btcKey ? closedIdx(btcKey, stepTs) : -1;

      // Resolve current regime at this step from the precomputed series, read
      // at the latest BTC bar at or before this step's time.
      let currentRegimeLabel = null;
      if (btcIdx >= 0) {
        currentRegimeLabel = regimeByTs.get(btcCandles[btcIdx].timestamp) ?? null;
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
          // Live closes every scalper position on the transition, bar or no bar
          // (item 3): a gapped symbol exits at its last known price.
          const price = rows[sym]?.price ?? lastPrice[sym] ?? pos.entryPrice;
          simulator.setTimestamp(stepTs);
          simulator.execute(sym, 'SELL', price);
          delete positionOpenedStep[sym];
          filtersApplied.bearCashExit += 1;
        }
      }
      prevRegimeLabel = currentRegimeLabel;

      if (stepTs < this.tradeFromTs) continue;
      while (nextDeposit < this.deposits.length && this.deposits[nextDeposit].ts <= stepTs) {
        simulator.deposit(this.deposits[nextDeposit].amount);
        nextDeposit++;
      }

      let medianATR = null;
      if (this.atrPositionSizing) {
        // Live's median runs over every fresh symbol, including one listed fewer
        // than MIN_WARMUP bars ago (it has no row yet): LSK, listed 2025-11-18, moved
        // BTC's 2025-12-10 size by 1.8% (engine replay vs this backtester).
        const vals = symbols.map((s) => rows[s]?.atrPct ?? this.#atrBeforeWarmup(symbolCandles[s], asOfIdx[s], stepTs))
          .filter((v) => v > 0);
        if (vals.length) medianATR = this.#median(vals);
      }

      // Macro bear filter: check BTC vs EMA(emaPeriod) using BTC bars up to this step's time
      let macroBull = true;
      if (this.macroFilter && btcCandles) {
        macroBull = isBullTrend(btcCandles.slice(0, btcIdx + 1), this.macroEMAPeriod);
      }

      // MTF early exit: for each open losing position, check if 15m trend is strongly
      // bearish. If so, close immediately to free the slot for a better opportunity.
      if (this.mtfEarlyExit) {
        const openPositions = simulator.getStatus().positions;
        for (const pos of openPositions) {
          const sym = pos.symbol;
          const c15m = this.mtfSymbolCandles[sym];
          if (!c15m?.length || !mtfIndex[sym]) continue;
          const d = rows[sym];
          if (!d) continue;

          // The last 15m bar inside the period that closed at T (closed by T).
          const candle12hIdx = rowIdx[sym] + MIN_WARMUP - 1;
          const last15mIdx = candle12hIdx >= 0 ? mtfIndex[sym][candle12hIdx] : -1;
          if (last15mIdx < 0) continue;

          const score = mtfAlignScore(c15m, last15mIdx, this.mtfAlignBars);
          if (score >= this.mtfEarlyExitScore) continue; // trend ok, hold

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
          const d = rows[sym];
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
        const d = rows[sym];
        if (!d) continue;

        stepSignals[sym] = d;
        simulator.setTimestamp(d.timestamp);

        // Asymmetric exit, shared with live (decisionCore.resolveDecision): a held
        // symbol with a SELL majority exits at 0.7× its entry threshold.
        const resolved = resolveDecision({
          decision: d.decision,
          confidence: d.confidence,
          sellVotes: d.sellVotes,
          totalVotes: d.totalVotes,
          held: simulator.positions.has(sym),
          minConfidence: this.symbolMinConfidence[sym] ?? this.config.signals?.minConfidence,
        });
        const { decision } = resolved;
        if (resolved.asymmetricExit) filtersApplied.asymmetricExit = (filtersApplied.asymmetricExit ?? 0) + 1;

        if (decision === 'BUY') {
          simulator.execute(sym, 'HOLD', d.price);
          buyQueue.push({ sym, d });
        } else {
          simulator.execute(sym, decision, d.price);
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
        // Shared with live (runAllSymbols): confidence first, ties by symbol order.
        const order = new Map(symbols.map((s, k) => [s, k]));
        buyQueue.sort((a, b) => byEntryPriority(
          { confidence: a.d.confidence, order: order.get(a.sym) },
          { confidence: b.d.confidence, order: order.get(b.sym) },
        ));
      }

      // ── Weekly DD circuit breaker (Phase 7) ─────────────────────────────
      // Check ONCE per step (not per candidate) so all queued buys see the
      // same gate decision. When triggered, every BUY at this step is
      // rejected; existing positions are still managed normally.
      let weeklyDDInputs = null;
      if (this.weeklyDDBreaker && buyQueue.length > 0) {
        const nowTs = stepTs;
        // Reference equity mirrors live: current simulated equity (cash +
        // open positions at this bar's signal prices), so the % threshold
        // scales with account growth exactly as the live breaker does.
        const status = simulator.getStatus();
        const equity = calcEquityFromStatus({
          ...status,
          positions: status.positions.map((p) => ({
            ...p,
            currentPrice: stepSignals[p.symbol]?.price ?? p.entryPrice,
          })),
        });
        // The breaker sums realised P&L over SELL records keyed by `timestamp` —
        // the shape of live's trade log. Simulator trades are round trips (side
        // 'LONG', exitTime), so they are mapped here; passed as-is, every one
        // was filtered out and the backtest breaker could never fire.
        weeklyDDInputs = {
          recentTrades: simulator.getTrades().map((t) => ({ side: 'SELL', timestamp: t.exitTime, pnl: t.pnl })),
          referenceEquity: equity > 0 ? equity : initialBalance,
          nowMs: nowTs,
        };
      }

      for (const { sym, d } of buyQueue) {

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

        // Live's entry gates, in live's order, through the shared core
        // (decisionCore.evaluateEntryGates). Each input is what live reads at the
        // cycle: the decision series, bars closed by T, the as-of BTC.D sample.
        const i12 = rowIdx[sym] + MIN_WARMUP; // this bar in the 12h array
        const c12 = symbolCandles[sym];
        const open12 = Number(c12[i12].open);
        const atCycle = [...c12.slice(0, i12), {
          timestamp: Number(c12[i12].timestamp), open: open12, high: open12, low: open12, close: open12, volume: 0,
        }];
        const closedBars = (bars, lastIdx, n) => (bars?.length && lastIdx >= 0
          ? bars.slice(Math.max(0, lastIdx - n + 1), lastIdx + 1) : null);
        const btcd = this.btcDominanceGate ? getContextAsOf(d.timestamp)?.btcDominance : null;
        const gate = evaluateEntryGates({
          symbol: sym,
          config: gateConfig,
          weeklyDD: weeklyDDInputs,
          btcDominance: btcd?.sma7d != null
            ? { ...btcd, deltaPct: Number((btcd.value - btcd.sma7d).toFixed(3)) } // live rounds the same way
            : null,
          candles: atCycle,
          correlation: this.correlationFilter ? {
            openPositions: status.positions,
            // Live's matrix builder over each symbol's trailing window, closed by T.
            matrix: buildCorrelationMatrix(
              [sym, ...status.positions.map((p) => p.symbol)],
              (s) => {
                const k = closedIdx(s, stepTs);
                return symbolCandles[s].slice(Math.max(0, k - this.correlationPeriod), k + 1);
              },
              { enabled: true, period: this.correlationPeriod },
            ),
          } : null,
          // Live reads 20 closed 15m bars and 29 closed 4h bars; the scores only use
          // the newest alignBars / lookback of them, but the 4h score needs more
          // than `lookback` bars or it reads neutral.
          bars15m: mtfIndex[sym] ? closedBars(this.mtfSymbolCandles[sym], mtfIndex[sym][i12 - 1], this.mtfAlignBars + 4) : null,
          bars4h: mtf4hIndex[sym] ? closedBars(this.mtf4hSymbolCandles[sym], mtf4hIndex[sym][i12 - 1], this.mtf4hLookback + 9) : null,
        });
        if (gate.blockReason) {
          filtersApplied[gate.gate] = (filtersApplied[gate.gate] ?? 0) + 1;
          continue;
        }

        const openCount = status.positions.length;
        let positionPct;
        if (this.kellyEnabled) {
          // Research-only (Kelly is not a live rule): the backtester's own chain.
          positionPct = this.#computePositionPct(d, basePct, medianATR, simulator.getTrades());
          if (this.macroFilter && !macroBull) positionPct *= this.macroSizeReduceFactor;
          if (this.regimeSizing && d.adxValue != null) {
            if (d.adxValue >= this.regimeBoostThresh) positionPct *= this.regimeBoostFactor;
            else if (d.adxValue < this.regimePenaltyThresh) positionPct *= this.regimePenaltyFactor;
          }
          if (gate.mtfSizeFactor < 1.0) positionPct *= gate.mtfSizeFactor;
          positionPct = applySizeFloor(positionPct, basePct, this.minSizeMultiplier);
        } else {
          // Live's sizing chain (positionSizing.computePositionSize) on live's series.
          positionPct = computePositionSize({
            basePct,
            candles: atCycle,
            medianATRPct: medianATR,
            btcMacroBull: macroBull,
            confidence: d.confidence,
            mtfSizeFactor: gate.mtfSizeFactor,
            config: sizingConfig,
          });
        }

        // Regime-LABEL exposure tilt (research, off unless configured): concentrate
        // deployment where the edge lives — attribution shows BULL_TREND carries P&L.
        if (this.regimeSizeMult && currentRegimeLabel && this.regimeSizeMult[currentRegimeLabel] != null) {
          positionPct *= Number(this.regimeSizeMult[currentRegimeLabel]);
        }

        const entryOpts = {
          positionPct,
          // Live fills the market order seconds after the cycle on T: at the open
          // of bar T (follow-ups item 1; it used to wait for bar T + 1).
          fillPrice: d.price,
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
          entryOpts.stopLossPrice = d.price * (1 - Number(symRisk.stopLossPct));
        }
        if (!atrStopsActive && symRisk?.takeProfitPct != null) {
          entryOpts.takeProfitPrice = d.price * (1 + Number(symRisk.takeProfitPct));
        }

        if (this.atrSLTP && d.atrPct > 0) {
          const atrValue = d.atrPct * d.price;
          entryOpts.stopLossPrice = d.price - this.atrSLMultiplier * atrValue;
          entryOpts.takeProfitPrice = d.price + this.atrTPMultiplier * atrValue;
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

      // One equity point per step, every position marked (item 2): at this bar's
      // price, or its last known price when the symbol has no bar now.
      for (const sym of symbols) if (rows[sym]) lastPrice[sym] = rows[sym].price;
      simulator.setTimestamp(stepTs);
      simulator.markEquity(lastPrice);
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

    // Pulled off the simulator, which is where the exchange floor is applied.
    filtersApplied.minNotional = simulator.minNotionalRejections;

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
        correlationPeriod: this.correlationPeriod,
        fearGreedFilter: this.fearGreedFilter,
        fearGreedThreshold: this.fearGreedThreshold,
        symbols: symbols.length,
      },
    };
  }

  /**
   * The per-bar decision rows `run()` steps over, without running the portfolio.
   * A symbol's row for bar `t` is what live decides at the cycle on `t`'s open
   * (the strategies drop the forming bar), so a live signal compares against it
   * directly. Used by the live reconciliation; `run()` builds its rows with the
   * same private routine, so the two cannot drift.
   */
  computeSignalRows(symbolCandles) {
    return this.#precomputeData(symbolCandles, Object.keys(symbolCandles));
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
        // The series live's gates and sizing read at the cycle on bar i's open:
        // the closed bars plus a forming bar seconds old — flat at the open. The
        // strategies drop the last bar either way, so the decision is unchanged.
        const open = Number(candle.open);
        const atCycle = [...slice.slice(0, -1), {
          timestamp: Number(candle.timestamp), open, high: open, low: open, close: open, volume: 0,
        }];
        const sellVotes = (result.signals ?? []).filter((x) => x.signal === 'SELL').length;

        allData[sym].push({
          decision: result.decision,
          confidence: result.confidence,
          // The price at the cycle: live decides and fills seconds after bar i
          // opens (follow-ups item 1). `close` is bar i's close, 12 h later.
          price: open,
          close: Number(candle.close),
          // The asymmetric exit reads the raw votes (decisionCore.resolveDecision).
          sellVotes,
          totalVotes: result.signals?.length ?? 0,
          timestamp: Number(candle.timestamp),
          atrPct: this.#computeATRpct(atCycle),
          adxValue: this.#computeADX(atCycle),
          volumeOk: this.#computeVolumeOk(atCycle),
          mom: this.#computeMomentum(atCycle), // trailing-return relative strength (no lookahead)
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

  // ATR% of a symbol with a bar at the step but no row yet (inside its first
  // MIN_WARMUP bars), on the series live holds then: closed bars + a flat forming bar.
  #atrBeforeWarmup(candles, k, stepTs) {
    if (k < 0 || k >= MIN_WARMUP || Number(candles[k].timestamp) !== stepTs) return null;
    const open = Number(candles[k].open);
    return this.#computeATRpct([...candles.slice(0, k), { timestamp: stepTs, open, high: open, low: open, close: open, volume: 0 }]);
  }

  // Live's own ATR% (positionSizing.js sizes with it), so the two cannot drift.
  #computeATRpct(candles) {
    return computeATRPct(candles, this.atrPeriod);
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

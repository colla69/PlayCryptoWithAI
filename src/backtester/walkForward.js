/**
 * Walk-Forward backtest harness (Phase 8).
 *
 * Why this matters:
 *   The current portfolio backtest evaluates the bot on a fixed window
 *   using its CURRENT config. That's optimistic — the config was fit on
 *   data that overlaps the test window. Walk-forward simulates running
 *   the bot for real over time: at each evaluation point, the bot only
 *   "sees" data up to that point. We roll forward in steps and concat
 *   the forward-only test results.
 *
 *   For *this* bot, the per-symbol strategy lists are static (not re-fit
 *   each window), so walk-forward is mostly an honesty check: the
 *   filter+aggregator chain MUST keep working as data evolves. It also
 *   produces a more credible equity curve for Sharpe / DD computation
 *   because each test window is genuinely OOS at its own evaluation moment.
 *
 *   When Phase 4 walk-forward retune lands, this harness becomes the
 *   training+validation engine: refit per-symbol configs on the train
 *   window, evaluate forward, advance, repeat.
 *
 * Output:
 *   - One concatenated equity curve assembled from all forward windows
 *   - Per-fold metrics + aggregate metrics
 *   - Deflated Sharpe across the concat'd curve
 *
 * Strict no-lookahead: each fold's PortfolioBacktester only receives
 * symbolCandles sliced to [foldStart, foldEnd]. The aggregator + filter
 * stack inside the backtester already excludes the forming candle.
 */

import config from '../../config/default.js';
import { PortfolioBacktester } from './index.js';
import { deflatedSharpeRatio } from './deflatedSharpe.js';
import {
  buildPerSymbolOverrides,
  FULL_LIVE_FILTERS,
  SLIPPAGE_TIERS,
  sliceWindow,
} from './baselineFramework.js';
import {
  RSIStrategy, BollingerBandsStrategy, CCIStrategy, StochasticStrategy,
  EMAStrategy, MACDStrategy, ADXStrategy, SupertrendStrategy,
  MFIStrategy, OBVStrategy, PSARStrategy, WilliamsRStrategy,
  StochRSIStrategy, HeikinAshiStrategy, SupportResistanceStrategy,
} from '../strategies/index.js';

const STRATEGY_BUILDERS = {
  RSI:        (s) => new RSIStrategy(symCfg(s, 'rsi', config.rsi)),
  EMA:        (s) => new EMAStrategy(symCfg(s, 'ema', config.ema)),
  MACD:       (s) => new MACDStrategy(symCfg(s, 'macd', config.macd)),
  BB:         (s) => new BollingerBandsStrategy(symCfg(s, 'bollinger', config.bollinger)),
  Stoch:      (s) => new StochasticStrategy(symCfg(s, 'stochastic', config.stochastic)),
  ADX:        (s) => new ADXStrategy(symCfg(s, 'adx', config.adx)),
  CCI:        (s) => new CCIStrategy(symCfg(s, 'cci', config.cci)),
  Supertrend: (s) => new SupertrendStrategy(symCfg(s, 'supertrend', config.supertrend)),
  MFI:        (s) => new MFIStrategy(symCfg(s, 'mfi', config.mfi)),
  OBV:        (s) => new OBVStrategy(symCfg(s, 'obv', config.obv)),
  PSAR:       (s) => new PSARStrategy(symCfg(s, 'psar', config.psar)),
  WilliamsR:  (s) => new WilliamsRStrategy(symCfg(s, 'williamsR', config.williamsR)),
  StochRSI:   (s) => new StochRSIStrategy(symCfg(s, 'stochRsi', config.stochRsi ?? {})),
  HeikinAshi: (s) => new HeikinAshiStrategy(symCfg(s, 'heikinAshi', config.heikinAshi ?? {})),
  SR:         (s) => new SupportResistanceStrategy(symCfg(s, 'supportResistance', config.supportResistance ?? {})),
};

function symCfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}

function buildStrategies(symbol) {
  const names = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI'];
  return names.map((n) => {
    const b = STRATEGY_BUILDERS[n];
    if (!b) throw new Error(`Unknown strategy '${n}' for ${symbol}`);
    return b(symbol);
  });
}

function median(arr) {
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Generate walk-forward folds from a contiguous candle range.
 *
 * Pattern: each fold has a TRAIN portion (used as warm-up to populate
 * indicators) and a FORWARD portion (the OOS evaluation window).
 *
 *   |─── train ───|── forward ──|   fold 1
 *                 |─── train ───|── forward ──|   fold 2
 *                               |─── train ───|── forward ──|   fold 3
 *
 * step = forward (no overlap on the OOS portion)
 *
 * @param {object} args
 * @param {number} args.firstTs
 * @param {number} args.lastTs
 * @param {number} args.candleIntervalMs   — 12h = 43_200_000
 * @param {number} args.trainBars          — bars used as warm-up before each fold's forward window (default 365 = 6mo)
 * @param {number} args.forwardBars        — OOS evaluation length per fold (default 180 = 3mo)
 * @returns {Array<{ index, trainStart, trainEnd, forwardStart, forwardEnd }>}
 */
export function generateFolds({
  firstTs,
  lastTs,
  candleIntervalMs,
  trainBars,
  forwardBars,
}) {
  const folds = [];
  const totalMs = lastTs - firstTs;
  const totalBars = Math.floor(totalMs / candleIntervalMs);
  if (totalBars < trainBars + forwardBars) return folds;

  let foldIdx = 0;
  let trainStartBar = 0;
  while (trainStartBar + trainBars + forwardBars <= totalBars) {
    folds.push({
      index: foldIdx++,
      trainStart:   firstTs + trainStartBar * candleIntervalMs,
      trainEnd:     firstTs + (trainStartBar + trainBars) * candleIntervalMs,
      forwardStart: firstTs + (trainStartBar + trainBars) * candleIntervalMs,
      forwardEnd:   firstTs + (trainStartBar + trainBars + forwardBars) * candleIntervalMs,
    });
    trainStartBar += forwardBars;
  }
  // Final partial fold if there's enough data left for at least half a forward window
  if (trainStartBar + trainBars + Math.floor(forwardBars / 2) <= totalBars) {
    folds.push({
      index: foldIdx,
      trainStart:   firstTs + trainStartBar * candleIntervalMs,
      trainEnd:     firstTs + (trainStartBar + trainBars) * candleIntervalMs,
      forwardStart: firstTs + (trainStartBar + trainBars) * candleIntervalMs,
      forwardEnd:   lastTs,
      partial:      true,
    });
  }
  return folds;
}

/**
 * Run one walk-forward fold. The backtester gets the FULL train+forward
 * window (so indicators warm up properly), but we slice the trades and
 * equity-curve points returned to ONLY include those that occurred in the
 * forward portion when aggregating across folds.
 */
export function runFold({
  fold,
  symbolCandles,
  mtf15mCandles = {},
  mtf4hCandles = {},
  fearGreedData = null,
  budget,
  maxOpenPositions,
}) {
  // Slice candles to train+forward span. Symbols without enough overlap drop out.
  const sliced = sliceWindow(symbolCandles, fold.trainStart, fold.forwardEnd);
  const symbols = Object.keys(sliced);
  if (symbols.length === 0) {
    return { fold, skipped: true, reason: 'no symbols in window' };
  }
  const strategies = Object.fromEntries(symbols.map((s) => [s, buildStrategies(s)]));
  const { symbolRisk, symbolMinConfidence } = buildPerSymbolOverrides(symbols);
  const minConfMedian = median(
    symbols.map((s) => config.perSymbol?.[s]?.minConfidence ?? config.risk?.minConfidence ?? 0.7),
  );
  const slMedian = median(symbols.map((s) => config.perSymbol?.[s]?.stopLossPct ?? config.risk?.stopLossPct ?? 0.05));
  const tpMedian = median(symbols.map((s) => config.perSymbol?.[s]?.takeProfitPct ?? config.risk?.takeProfitPct ?? 0.12));

  const backtester = new PortfolioBacktester(strategies, {
    risk: {
      ...(config.risk ?? {}),
      initialBalance:      budget,
      stopLossPct:         slMedian,
      takeProfitPct:       tpMedian,
      trailingStopPct:     0,
      feePct:              0.001,
      slippagePct:         0.001,
      breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
    },
    signals: { ...(config.signals ?? {}), minConfidence: minConfMedian },
    maxOpenPositions,
    symbolSlippage:    SLIPPAGE_TIERS,
    symbolRisk,
    symbolMinConfidence,
    mtfSymbolCandles:  mtf15mCandles,
    mtf4hSymbolCandles: mtf4hCandles,
    fearGreedData,
    confidenceThresholdScale: Number.isFinite(config.risk?.confidenceThresholdScale)
      ? config.risk.confidenceThresholdScale
      : 1,
    ...FULL_LIVE_FILTERS,
  });

  const result = backtester.run(sliced);

  // Filter to only the forward window: trades EXIT after forwardStart count.
  // (A trade opened during train but exited during forward still counts as
  // forward — that's how live would work: positions carry across boundaries.)
  const forwardTrades = result.trades.filter((t) => {
    const exitTs = Number(t.exitTime ?? t.closeTime ?? t.entryTime);
    return exitTs >= fold.forwardStart;
  });
  const forwardEquity = (result.equityCurve ?? []).filter(
    (p) => Number(p.timestamp) >= fold.forwardStart,
  );

  // The fold's starting balance = balance at the moment forward begins.
  // Approximate by using the equity point closest to (but not after) forwardStart.
  const trainEnd = (result.equityCurve ?? []).filter(
    (p) => Number(p.timestamp) <= fold.forwardStart,
  ).at(-1);
  const foldStartBalance = trainEnd?.balance ?? budget;
  const foldEndBalance = forwardEquity.at(-1)?.balance ?? foldStartBalance;
  const foldReturn = foldStartBalance > 0
    ? (foldEndBalance - foldStartBalance) / foldStartBalance
    : 0;

  return {
    fold,
    skipped: false,
    symbols_used: symbols.length,
    forward_trades: forwardTrades,
    forward_equity: forwardEquity,
    fold_start_balance: foldStartBalance,
    fold_end_balance:   foldEndBalance,
    fold_return:        Number(foldReturn.toFixed(4)),
    fold_metrics_raw:   result.metrics,
  };
}

/**
 * Stitch fold equity curves into a single continuous capital trajectory.
 * Each fold starts where the previous ended (we chain the percentage returns).
 *
 * Returns the global equity curve and aggregate metrics (Sharpe, DD, etc.).
 */
export function aggregateFolds(foldResults, { budget, nTrialsForDSR = 16280 }) {
  const validFolds = foldResults.filter((f) => !f.skipped);
  if (validFolds.length === 0) {
    return {
      equity: [],
      total_return: 0,
      sharpe: 0,
      max_drawdown: 0,
      win_rate: 0,
      total_trades: 0,
      deflated_sharpe: null,
    };
  }

  // Chain returns: start at budget, scale each fold's curve by the running balance.
  const stitched = [];
  let runningBalance = budget;
  let allTrades = [];
  for (const f of validFolds) {
    if (f.forward_equity.length === 0) continue;
    const foldStart = f.fold_start_balance;
    const scale = runningBalance / (foldStart || runningBalance || 1);
    for (const point of f.forward_equity) {
      stitched.push({
        timestamp: Number(point.timestamp),
        balance: Number(point.balance) * scale,
      });
    }
    runningBalance = (f.fold_end_balance ?? runningBalance) * scale;
    // Scale PnL by the same factor so trade-level pnl matches the global curve
    allTrades = allTrades.concat(
      f.forward_trades.map((t) => ({ ...t, pnl: Number(t.pnl ?? 0) * scale })),
    );
  }
  if (stitched.length === 0) {
    return {
      equity: [], total_return: 0, sharpe: 0, max_drawdown: 0, win_rate: 0,
      total_trades: 0, deflated_sharpe: null,
    };
  }

  const finalBalance = stitched.at(-1).balance;
  const totalReturn = (finalBalance - budget) / budget;

  // Daily returns from stitched equity
  const byDay = new Map();
  for (const p of stitched) {
    const day = new Date(p.timestamp).toISOString().slice(0, 10);
    byDay.set(day, p.balance);
  }
  const dailyBalances = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  const dailyReturns = [];
  let prev = budget;
  for (const bal of dailyBalances) {
    if (prev > 0) dailyReturns.push((bal - prev) / prev);
    prev = bal;
  }
  const meanRet = dailyReturns.length
    ? dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length
    : 0;
  const variance = dailyReturns.length > 1
    ? dailyReturns.reduce((s, v) => s + (v - meanRet) ** 2, 0) / (dailyReturns.length - 1)
    : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (meanRet / std) * Math.sqrt(252) : 0;

  // Max drawdown from stitched curve
  let peak = budget;
  let maxDD = 0;
  for (const p of stitched) {
    if (p.balance > peak) peak = p.balance;
    if (peak > 0) maxDD = Math.max(maxDD, (peak - p.balance) / peak);
  }

  const winners = allTrades.filter((t) => Number(t.pnl) > 0);
  const losers = allTrades.filter((t) => Number(t.pnl) < 0);
  const winRate = allTrades.length ? winners.length / allTrades.length : 0;
  const grossWin = winners.reduce((s, t) => s + Number(t.pnl), 0);
  const grossLoss = losers.reduce((s, t) => s + Math.abs(Number(t.pnl)), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  const dsr = deflatedSharpeRatio({
    observedSharpe: sharpe,
    returns: dailyReturns,
    nTrials: nTrialsForDSR,
  });

  return {
    equity: stitched,
    total_return: Number(totalReturn.toFixed(4)),
    total_return_pct: `${totalReturn >= 0 ? '+' : ''}${(totalReturn * 100).toFixed(2)}%`,
    sharpe: Number(sharpe.toFixed(4)),
    max_drawdown: Number(maxDD.toFixed(4)),
    max_drawdown_pct: `${(-maxDD * 100).toFixed(2)}%`,
    win_rate: Number(winRate.toFixed(4)),
    profit_factor: Number.isFinite(profitFactor) ? Number(profitFactor.toFixed(4)) : null,
    total_trades: allTrades.length,
    folds_evaluated: validFolds.length,
    deflated_sharpe: dsr,
  };
}

/**
 * Monte Carlo trade-order shuffle (Phase 8).
 *
 * Given a sequence of completed trades, randomly permute the order N times
 * and recompute equity curve + DD + Sharpe each time. Returns the
 * percentile bands. This separates "skill" (positive average trade) from
 * "luck" (the actual order in which wins/losses landed).
 *
 * Interpretation:
 *   - If P95 of MaxDD ≪ observed MaxDD: we got LUCKY on ordering
 *   - If P5  of MaxDD ≫ observed MaxDD: we got UNLUCKY on ordering
 *   - If observed Sharpe is near P5: the result is fragile to ordering
 *
 * @param {object} args
 * @param {Array<{pnl: number}>} args.trades
 * @param {number} args.initialBalance
 * @param {number} [args.iterations=1000]
 * @param {() => number} [args.rng]   — for reproducible tests; default Math.random
 * @returns {{ observed, shuffled: { p5, p50, p95 } } }
 */
export function monteCarloShuffle({
  trades = [],
  initialBalance,
  iterations = 1000,
  rng = Math.random,
}) {
  if (!Array.isArray(trades) || trades.length < 2 || !(initialBalance > 0)) {
    return null;
  }
  const pnls = trades.map((t) => Number(t.pnl ?? 0)).filter(Number.isFinite);
  if (!pnls.length) return null;

  const computeMetrics = (orderedPnls) => {
    let balance = initialBalance;
    let peak = balance;
    let maxDD = 0;
    const rets = [];
    for (const pnl of orderedPnls) {
      const prev = balance;
      balance += pnl;
      if (balance > peak) peak = balance;
      if (peak > 0) maxDD = Math.max(maxDD, (peak - balance) / peak);
      if (prev > 0) rets.push((balance - prev) / prev);
    }
    const meanR = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
    const variance = rets.length > 1
      ? rets.reduce((s, v) => s + (v - meanR) ** 2, 0) / (rets.length - 1)
      : 0;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (meanR / std) * Math.sqrt(252) : 0;
    return {
      totalReturn: (balance - initialBalance) / initialBalance,
      maxDD,
      sharpe,
      finalBalance: balance,
    };
  };

  const observed = computeMetrics(pnls);

  // Shuffle and recompute N times
  const shuffledReturns = [];
  const shuffledDDs = [];
  const shuffledSharpes = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = [...pnls];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    const m = computeMetrics(shuffled);
    shuffledReturns.push(m.totalReturn);
    shuffledDDs.push(m.maxDD);
    shuffledSharpes.push(m.sharpe);
  }

  const pct = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  };

  return {
    iterations,
    observed: {
      total_return: Number(observed.totalReturn.toFixed(4)),
      max_drawdown: Number(observed.maxDD.toFixed(4)),
      sharpe:       Number(observed.sharpe.toFixed(4)),
    },
    shuffled: {
      total_return: {
        p5:  Number(pct(shuffledReturns, 5).toFixed(4)),
        p50: Number(pct(shuffledReturns, 50).toFixed(4)),
        p95: Number(pct(shuffledReturns, 95).toFixed(4)),
      },
      max_drawdown: {
        p5:  Number(pct(shuffledDDs, 5).toFixed(4)),
        p50: Number(pct(shuffledDDs, 50).toFixed(4)),
        p95: Number(pct(shuffledDDs, 95).toFixed(4)),
      },
      sharpe: {
        p5:  Number(pct(shuffledSharpes, 5).toFixed(4)),
        p50: Number(pct(shuffledSharpes, 50).toFixed(4)),
        p95: Number(pct(shuffledSharpes, 95).toFixed(4)),
      },
    },
  };
}

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
import { annualizedSharpe, dailyReturnsFromEquity } from './metrics.js';
import {
  buildPerSymbolOverrides,
  FULL_LIVE_FILTERS,
  SLIPPAGE_TIERS,
  sliceWithHistory,
} from './baselineFramework.js';
// Live's own builder (follow-ups item 7): a private copy here knew 15 of the 20
// strategies and defaulted a symbol without a list to ['RSI'] where live uses all.
import { buildStrategiesForSymbol as buildStrategies } from '../utils/strategyBuilder.js';




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
  filterOverrides = {},
  rideWinnersTrail = 0,
  ridePartial = null,
  trailArmPct = 0,
  // Research sweeps (runStopSweep.mjs): scale every stop / target, and reuse the
  // fold's signal rows across cells. Both off by default.
  riskScale = null,
  riskOverrides = {},
  rows = null,
  rowsOnly = false,
}) {
  // Slice candles to train+forward span. Symbols without enough overlap drop out.
  // History before the fold warms the indicators; trading starts at trainStart.
  const sliced = sliceWithHistory(symbolCandles, fold.trainStart, fold.forwardEnd);
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
  let tpMedian = median(symbols.map((s) => config.perSymbol?.[s]?.takeProfitPct ?? config.risk?.takeProfitPct ?? 0.12));
  let slMedianScaled = slMedian;
  if (riskScale) {
    const sl = Number(riskScale.stopLoss ?? 1);
    const tp = Number(riskScale.takeProfit ?? 1);
    slMedianScaled = slMedian * sl;
    tpMedian *= tp;
    for (const s of Object.keys(symbolRisk)) {
      const r = symbolRisk[s];
      symbolRisk[s] = {
        ...r,
        ...(r.stopLossPct != null && { stopLossPct: r.stopLossPct * sl }),
        ...(r.takeProfitPct != null && { takeProfitPct: r.takeProfitPct * tp }),
      };
    }
  }

  // WS4 ride-winners (mirror of runWindow): disable fixed TP + lift aging, trail instead.
  const riding = rideWinnersTrail > 0;
  if (riding) {
    tpMedian = 99;
    for (const s of Object.keys(symbolRisk)) {
      if (symbolRisk[s]) symbolRisk[s] = { ...symbolRisk[s], takeProfitPct: 99 };
    }
  }

  const backtester = new PortfolioBacktester(strategies, {
    risk: {
      ...(config.risk ?? {}),
      initialBalance:      budget,
      stopLossPct:         slMedianScaled,
      takeProfitPct:       tpMedian,
      trailingStopPct:     riding ? rideWinnersTrail : (config.risk?.trailingStopPct ?? 0), // live reads config.risk
      feePct:              0.001,
      slippagePct:         0.001,
      breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
      ...(riding && { positionAgingExit: { enabled: false } }),
      ...(riding && ridePartial && { ridePartial }),
      ...(riding && trailArmPct > 0 && { trailArmPct }),
      // A sweep's exit cell, e.g. { trailingStopPct: 0.07, trailArmPct: 0.05 }.
      ...riskOverrides,
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
    tradeFromTs: fold.trainStart,
    // WS3 sweep hook: per-run filter knob overrides (e.g. {mtfMinScore:0.3}).
    ...filterOverrides,
  });

  // The fold's signal rows, from this same construction, for a sweep to reuse.
  if (rowsOnly) return { fold, skipped: false, rows: backtester.computeSignalRows(sliced) };

  const result = backtester.run(sliced, { rows });

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
  const dailyReturns = [...dailyReturnsFromEquity(stitched, budget).values()];
  const sharpe = annualizedSharpe(dailyReturns);

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
    // These are per-trade observations, not daily returns.
    const sharpe = annualizedSharpe(rets, 1);
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

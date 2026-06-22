/**
 * Live drift monitor (Phase 8).
 *
 * Compares the bot's *live* rolling per-trade performance against the
 * backtested expectation and raises an alert when they diverge beyond a
 * statistical band — an early warning that the strategy is behaving
 * differently in production than in simulation.
 *
 * Basis note (important for honesty): live and backtest Sharpe are only
 * comparable on the SAME basis. This module uses a **per-trade** Sharpe
 * (mean / std of per-trade returns, un-annualised) for both sides, NOT the
 * daily-equity Sharpe printed by the baseline runner. Configure the reference
 * (`config.monitor.driftRefSharpe`) from a per-trade backtest stat, or leave it
 * null for log-only observability (no alerts).
 *
 * Standard error of a Sharpe estimate (Lo, 2002, iid approximation):
 *     SE(SR) ≈ sqrt( (1 + 0.5·SR²) / n )
 * We alert when |live − ref| > zThreshold · SE  (default z = 2).
 *
 * Pure: no I/O, no logging. main.js calls these and handles logging/notifying.
 */

/**
 * Extract per-trade fractional returns from closed SELL trades within a window.
 * @param {Array} trades        — dashboard trade objects (newest first is fine)
 * @param {object} opts
 * @param {number} [opts.windowDays=30]
 * @param {number} [opts.nowMs=Date.now()]
 * @returns {number[]} per-trade returns as fractions (e.g. 0.05 = +5%)
 */
export function tradeReturns(trades, { windowDays = 30, nowMs = Date.now() } = {}) {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const out = [];
  for (const t of trades ?? []) {
    if (!t || t.side !== 'SELL') continue;
    const ts = toMs(t.timestamp);
    if (Number.isFinite(ts) && ts < cutoff) continue;
    const ret = tradeReturnFraction(t);
    if (ret != null) out.push(ret);
  }
  return out;
}

/** Best-effort per-trade fractional return from a trade record. */
export function tradeReturnFraction(t) {
  const entry = Number(t?.entryPrice);
  const exit  = Number(t?.exitPrice);
  if (Number.isFinite(entry) && entry > 0 && Number.isFinite(exit)) {
    return (exit - entry) / entry;
  }
  // Fallback: pnl relative to the pre-trade balance
  const pnl = Number(t?.pnl);
  const bal = Number(t?.balance);
  if (Number.isFinite(pnl) && Number.isFinite(bal) && bal - pnl > 0) {
    return pnl / (bal - pnl);
  }
  return null;
}

/** Per-trade Sharpe = mean / std of returns (un-annualised). 0 if <2 samples. */
export function sharpeOf(returns) {
  const xs = (returns ?? []).filter((x) => Number.isFinite(x));
  const n = xs.length;
  if (n < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

/** Standard error of a Sharpe estimate (Lo 2002 iid approximation). */
export function sharpeStdErr(sharpe, n) {
  if (!(n > 1)) return Infinity;
  return Math.sqrt((1 + 0.5 * sharpe * sharpe) / n);
}

/**
 * Compute live rolling stats from trade history.
 * @returns {{ n:number, winRate:number, meanReturn:number, sharpe:number }}
 */
export function computeLiveStats(trades, opts = {}) {
  const rets = tradeReturns(trades, opts);
  const n = rets.length;
  const wins = rets.filter((r) => r > 0).length;
  const meanReturn = n ? rets.reduce((a, b) => a + b, 0) / n : 0;
  return {
    n,
    winRate: n ? wins / n : 0,
    meanReturn: Number(meanReturn.toFixed(5)),
    sharpe: Number(sharpeOf(rets).toFixed(4)),
  };
}

/**
 * Evaluate drift of live per-trade Sharpe vs the backtest reference.
 * @param {object} args
 * @param {number} args.liveSharpe
 * @param {number|null} args.refSharpe   — null = log-only (no alert)
 * @param {number} args.nLive
 * @param {number} [args.zThreshold=2]
 * @param {number} [args.minTrades=10]
 * @returns {{ alert:boolean, z:number|null, stdErr:number, drift:number|null, reason:string }}
 */
export function evaluateDrift({ liveSharpe, refSharpe, nLive, zThreshold = 2, minTrades = 10 }) {
  if (refSharpe == null || !Number.isFinite(refSharpe)) {
    return { alert: false, z: null, stdErr: Infinity, drift: null, reason: 'no reference configured (log-only)' };
  }
  if (!(nLive >= minTrades)) {
    return { alert: false, z: null, stdErr: Infinity, drift: null, reason: `only ${nLive} live trades (< ${minTrades}) — not enough to judge` };
  }
  const stdErr = sharpeStdErr(refSharpe, nLive);
  const drift = liveSharpe - refSharpe;
  const z = stdErr > 0 ? drift / stdErr : 0;
  const alert = Math.abs(z) > zThreshold;
  const dir = drift < 0 ? 'below' : 'above';
  return {
    alert,
    z: Number(z.toFixed(2)),
    stdErr: Number(stdErr.toFixed(4)),
    drift: Number(drift.toFixed(4)),
    reason: alert
      ? `live per-trade Sharpe ${liveSharpe.toFixed(2)} is ${Math.abs(z).toFixed(1)}σ ${dir} backtest ${refSharpe.toFixed(2)} (n=${nLive})`
      : `live Sharpe ${liveSharpe.toFixed(2)} within ${zThreshold}σ of backtest ${refSharpe.toFixed(2)} (z=${z.toFixed(1)})`,
  };
}

function toMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') { const n = Date.parse(value); return Number.isFinite(n) ? n : NaN; }
  return NaN;
}

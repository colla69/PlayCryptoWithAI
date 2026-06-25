/**
 * Momentum / relative-strength helper — shared by live (`core/filters.js`) and
 * backtest (`portfolioBacktester.js`) so the two compute it identically (parity).
 *
 * Trailing N-bar return = relative-strength proxy. Both callers pass the SAME
 * candle series the aggregator saw (ending at the signal/closed candle), so there
 * is no lookahead and live ≡ backtest.
 */

/**
 * @param {Array<{close:number}>} candles — series ending at the signal (closed) candle
 * @param {number} lookback — bars back to measure return over
 * @returns {number} fractional return over the window (e.g. 0.12 = +12%); 0 if insufficient data
 */
export function trailingReturn(candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < lookback + 1) return 0;
  const now = Number(candles.at(-1)?.close);
  const then = Number(candles.at(-1 - lookback)?.close);
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return 0;
  return now / then - 1;
}

/**
 * Momentum-leader filter: pass only if trailing return ≥ minPct (don't buy
 * falling knives / downtrending coins). Returns true (pass) when disabled.
 * @param {Array<{close:number}>} candles
 * @param {{enabled?:boolean, minPct?:number, lookback?:number}} cfg
 * @returns {boolean} true = allow BUY, false = block
 */
export function passesMomentumFilter(candles, cfg) {
  if (!cfg?.enabled) return true;
  const minPct = Number(cfg.minPct ?? 0);
  return trailingReturn(candles, Number(cfg.lookback ?? 20)) >= minPct;
}

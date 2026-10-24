/**
 * Exchange trading constraints shared by the live trader AND the backtester.
 *
 * These live in one module on purpose. The minimum-notional rule used to exist
 * only in `liveTrader.js`, so every backtest happily "filled" positions the
 * exchange would have rejected — the backtester reported a constant trade count
 * across the whole 2026-06 deployment sweep precisely because nothing was ever
 * turned away. On a small account that is not a rounding error: at the 2026-07
 * live sizing distribution a $189 account clears $11 on only ~42% of signals.
 *
 * Any constraint the exchange enforces on a real order belongs here, and the
 * simulator must apply it too. See "Live ≡ Backtest" in
 * .github/copilot-instructions.md.
 */

/**
 * Floor used when the exchange's own `minNotional` is unavailable.
 * Binance spot enforces $10; the bot keeps $1 of headroom so a fill that slips
 * slightly doesn't land under the limit.
 */
export const FALLBACK_MIN_NOTIONAL = 11;

/**
 * Effective minimum notional for a market: the exchange's value when known,
 * never below our own floor.
 * @param {{minNotional?: number}} [limits] result of `getMarketLimits()`
 * @returns {number}
 */
export function resolveMinNotional(limits) {
  return Math.max(Number(limits?.minNotional ?? 0), FALLBACK_MIN_NOTIONAL);
}

/**
 * Raises an order the exchange would reject to its floor, when that is a modest
 * stretch of what the sizing asked for. On a small account the brake chain (macro,
 * ADX, confidence, ATR) often sizes a signal at $6–10 and the order is turned away
 * (7% of signals in 2026-09/10 live sizing, 14% when free cash was under $150). The
 * bump buys the floor instead, but only when the computed order was at least
 * `minRatio` of it — so it never more than doubles a position — and the free
 * balance covers it. Off unless `risk.minNotionalBump.enabled`. Live, paper and the
 * simulator all call this, so the rule exists once.
 *
 * @param {number} notional — the order value the sizing produced
 * @param {{freeBalance: number, minNotional?: number, bump?: {enabled?: boolean, minRatio?: number}}} p
 * @returns {number} the order value to place
 */
export function bumpToMinNotional(notional, { freeBalance, minNotional = FALLBACK_MIN_NOTIONAL, bump } = {}) {
  if (!bump?.enabled || !(notional > 0) || notional >= minNotional) return notional;
  // 0.5% above the floor, so step-size rounding of the quantity cannot land it under again.
  const target = minNotional * 1.005;
  if (notional < minNotional * Number(bump.minRatio ?? 0.5)) return notional;
  if (!(Number(freeBalance) >= target)) return notional;
  return target;
}

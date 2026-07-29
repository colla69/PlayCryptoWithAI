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

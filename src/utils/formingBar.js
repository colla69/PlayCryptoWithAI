import { timeframeMs } from './candleFreshness.js';

/**
 * Makes the series a decision is made on end with the forming bar.
 *
 * Every strategy drops its last bar (`candles.slice(0, -1)`), because live always
 * expects the newest bar to be the one still forming. A thin pair may not have
 * printed that bar 3–5 s after the close. Then the series ends at the bar that just
 * closed, the strategies drop that bar, and live decides one bar late. The
 * backtester always has the bar. The 2026-10 live reconciliation found 36 such
 * signals in ENS, JUP, THETA, MANTA and BNB (follow-ups plan, item 5).
 *
 * When the newest bar is the one that closed when the current period opened, this
 * returns a copy with a flat placeholder bar for the current period. The strategies
 * drop the placeholder, so they see exactly the closed bars. The input array is not
 * changed. Never persist the result: the placeholder is not market data.
 *
 * @param {Array<{timestamp: number, close: number}>} candles
 * @param {string} timeframe — e.g. '12h'
 * @param {number} [now]
 * @returns {Array} the same array, or a copy with the placeholder appended
 */
export function withFormingBar(candles, timeframe, now = Date.now()) {
  const periodMs = timeframeMs(timeframe);
  const last = candles?.at(-1);
  if (!periodMs || !last) return candles;
  const periodOpen = Math.floor(now / periodMs) * periodMs;
  // Only the one-bar-late case. An older newest bar is a gap or a frozen series,
  // which checkCandleFreshness() handles; a placeholder would hide it.
  if (Number(last.timestamp) !== periodOpen - periodMs) return candles;
  const close = Number(last.close);
  return [
    ...candles,
    { timestamp: periodOpen, open: close, high: close, low: close, close, volume: 0, placeholder: true },
  ];
}

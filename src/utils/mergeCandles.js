/**
 * Payload-wins candle merge — the single copy of a rule that has now broken
 * four times.
 *
 * Wherever two sources of the same bar combine, the exchange payload wins. The
 * reason is always the same: every fetch window includes the still-forming
 * candle, so the older copy of an overlapping timestamp is a partial bar. Keep
 * it and it is frozen into history for good, its corrected closed version
 * discarded — silently corrupting every indicator computed from it, with
 * nothing to error on.
 *
 * The four:
 *   · dashboardState.updateCandles  in-memory, first-wins  (live scored TIA CCI
 *                                   49.1 vs backtest 76.7 on identical on-disk data)
 *   · downloadHistory               first-wins, corrupting the research data itself
 *   · saveCachedCandles             blind overwrite truncating backfilled history
 *   · initializeHistoricalData      first-wins startup seed — `!seen.has(ts)`
 *                                   dropped the exchange's corrected bar, and
 *                                   because the seed re-persists what it loaded,
 *                                   each boot re-froze the previous boot's partial
 *                                   bar. 36 of 37 symbols carried frozen 12h bars
 *                                   on the restart dates 2026-07-02/07-29/07-30.
 *
 * Every one was a separate hand-rolled merge. This module exists so the next one
 * is a function call rather than a fifth opportunity to get the direction wrong.
 *
 * @param {Array<{timestamp:number}>} existing history (loses on collision)
 * @param {Array<{timestamp:number}>} payload  exchange data (wins on collision)
 * @param {{cap?: number}} [options] cap 0 disables trimming
 * @returns {Array<{timestamp:number}>} ascending, deduplicated, trimmed to cap
 */
export const CANDLE_WINDOW = 2_500;

export function mergeCandles(existing, payload, { cap = CANDLE_WINDOW } = {}) {
  const byTimestamp = new Map();
  // Insertion order matters only for correctness of the overwrite, not output
  // order — the result is sorted by timestamp regardless.
  for (const candle of Array.isArray(existing) ? existing : []) {
    const ts = Number(candle?.timestamp);
    if (Number.isFinite(ts)) byTimestamp.set(ts, candle);
  }
  for (const candle of Array.isArray(payload) ? payload : []) {
    const ts = Number(candle?.timestamp);
    if (Number.isFinite(ts)) byTimestamp.set(ts, candle);
  }

  const merged = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  return cap > 0 ? merged.slice(-cap) : merged;
}

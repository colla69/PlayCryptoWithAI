/**
 * Venue veto from Binance's announcements (events: src/data/exchangeEventsFeed.js).
 * Pure; live and the replay call it with the events announced by the cycle time.
 *
 *  - Monitoring tag: no new entries from the announcement until the tag is removed.
 *    The tag led every token delisting in the feed by 1–5 months (VANRY: 31 days).
 *  - USDC-pair removal or token delisting: no new entries, and a held position is
 *    sold at the first cycle after the notice — once the pair halts, the stale-series
 *    guard skips the symbol before any exit runs and the position is stranded.
 *    The veto ends a week after the removal's effective time: by then the 24h
 *    stale-series guard has taken over, and a pair Binance relists can trade again
 *    (it removed and later relisted USDC pairs around the 2022 BUSD conversion).
 *
 * No timing parameter: entries stop and exits start at the notice itself.
 *
 * @param {object[]} events — { coin, kind, announcedAt, effectiveAt, pair? }
 * @param {string} coin — base asset, e.g. 'LSK'
 * @param {number} nowMs
 * @returns {{blockEntry: boolean, exitHeld: boolean, reason: string|null}}
 */
const REMOVAL_TAIL_MS = 7 * 86_400_000;

export function exchangeEventState(events, coin, nowMs) {
  let tag = null;
  let untagAt = -Infinity;
  let removal = null;
  for (const e of events ?? []) {
    if (e.coin !== coin || !(e.announcedAt <= nowMs)) continue;
    if (e.kind === 'monitoring_tag' && !(tag && tag.announcedAt > e.announcedAt)) tag = e;
    else if (e.kind === 'monitoring_tag_removed') untagAt = Math.max(untagAt, e.announcedAt);
    else if (!removal && (e.kind === 'token_delist' || (e.kind === 'pair_removal' && e.pair === `${coin}/USDC`))
      // A removal without a time ends a week after its announcement, never "forever".
      && !(nowMs >= (Number.isFinite(e.effectiveAt) ? e.effectiveAt : e.announcedAt) + REMOVAL_TAIL_MS)) removal = e;
  }
  if (tag && untagAt >= tag.announcedAt) tag = null;
  if (removal) {
    const what = removal.kind === 'token_delist' ? 'token delisting' : `${removal.pair} removal`;
    return { blockEntry: true, exitHeld: true, reason: `Binance ${what} announced ${new Date(removal.announcedAt).toISOString().slice(0, 10)}${removal.title ? ` ("${removal.title}")` : ''}` };
  }
  if (tag) return { blockEntry: true, exitHeld: false, reason: `Binance monitoring tag since ${new Date(tag.announcedAt).toISOString().slice(0, 10)}` };
  return { blockEntry: false, exitHeld: false, reason: null };
}

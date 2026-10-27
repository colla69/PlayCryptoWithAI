import fs from 'fs';
import logger from '../utils/logger.js';
import { mergeCandles } from '../utils/mergeCandles.js';

/**
 * Deribit DVOL feed (30-day implied vol, in percent) for the TSM sleeve's vol
 * targeting — section E1 of docs/plans/2026-10-single-engine-rebuild.md: on the
 * six-year replay, sizing on DVOL instead of 30-day realized vol cut the worst
 * drop 9.4% → 8.5% at an equal Sharpe.
 *
 * Data: Deribit's keyless `public/get_volatility_index_data`, 12h bars (`timestamp`
 * = bar open), BTC and ETH only, history from 2021-03-24. Cached to disk; the
 * replay reads the same file, so live and backtest size on identical values. Every
 * fetch window holds the forming bar, so the merge is payload-wins (mergeCandles).
 * A failed refresh keeps the cache; the caller falls back to realized vol when no
 * bar closed within its age limit.
 */

const CACHE = 'data/dvol.json';
export const DVOL_COINS = ['BTC', 'ETH'];
const URL_BASE = 'https://www.deribit.com/api/v2/public/get_volatility_index_data';
const PERIOD_MS = 43_200_000;
const HISTORY_START = Date.UTC(2021, 2, 24);
const REFRESH_SPAN_MS = 7 * 86_400_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Pure-ish: the cached series by coin, or null. Used by the replay scripts. */
export function readDvolCache(cachePath = CACHE) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const d = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return DVOL_COINS.some((c) => d?.[c]?.length) ? d : null;
  } catch {
    return null;
  }
}

async function fetchRange(currency, fromMs, toMs, fetchImpl) {
  const rows = [];
  let end = toMs;
  // The endpoint pages backwards: `continuation` is the next end timestamp.
  for (let page = 0; page < 100 && end > fromMs; page++) {
    const url = `${URL_BASE}?currency=${currency}&start_timestamp=${fromMs}&end_timestamp=${end}&resolution=${PERIOD_MS / 1000}`;
    // Bounded: the sleeve's cycle awaits this; a hung request must not stall it.
    const json = await (await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })).json();
    const data = json?.result?.data;
    if (!Array.isArray(data)) throw new Error(`no data in Deribit response (${JSON.stringify(json?.error ?? json).slice(0, 120)})`);
    for (const [timestamp, open, high, low, close] of data) rows.push({ timestamp, open, high, low, close });
    const next = json.result.continuation;
    if (!next || next >= end) break;
    end = next;
  }
  // Sanity range: this feed scales real position sizes, so a corrupt response must
  // never survive parsing. DVOL has printed between ~25 and ~200.
  return rows.filter((r) => Number.isFinite(r.timestamp) && r.timestamp % PERIOD_MS === 0
    && Number.isFinite(r.close) && r.close > 5 && r.close < 500);
}

/**
 * The cached series, refreshed when it lacks the bar that closed at the last 12h
 * boundary — a time-to-live would let a cycle size on the bar before it, which the
 * replay never does.
 *
 * @returns {Promise<{fetchedAt: number, BTC: object[], ETH: object[]}|null>}
 */
export async function loadDvolHistory({ now = Date.now(), cachePath = CACHE, fetchImpl = fetch } = {}) {
  const cached = readDvolCache(cachePath);
  const lastClosedOpen = Math.floor(now / PERIOD_MS) * PERIOD_MS - PERIOD_MS;
  const fresh = (d) => DVOL_COINS.every((c) => (d?.[c]?.at(-1)?.timestamp ?? -Infinity) >= lastClosedOpen);
  if (cached && fresh(cached)) return cached;
  try {
    const next = { fetchedAt: now };
    for (const coin of DVOL_COINS) {
      const have = cached?.[coin] ?? [];
      const from = have.length ? Math.max(HISTORY_START, now - REFRESH_SPAN_MS) : HISTORY_START;
      // Closed bars only: a stored forming bar would pass the freshness check above
      // after its close and freeze a partial value into the series.
      const payload = (await fetchRange(coin, from, now, fetchImpl)).filter((r) => r.timestamp + PERIOD_MS <= now);
      if (!payload.length) throw new Error(`empty ${coin} response`);
      next[coin] = mergeCandles(have, payload, { cap: 0 });
    }
    fs.writeFileSync(cachePath, JSON.stringify(next));
    return next;
  } catch (err) {
    logger.warn(`DVOL fetch failed: ${err.message}${cached ? ' — using the cache' : ''}`);
    return cached;
  }
}

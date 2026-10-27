import fs from 'fs';
import logger from '../utils/logger.js';

/**
 * Binance venue events from its announcement feed: monitoring tags, USDC spot-pair
 * removals and token delistings — section E item 2 of
 * docs/plans/2026-10-single-engine-rebuild.md. LSK/USDC and GMX/USDC were removed
 * with three days' notice and VANRY was delisted a month after its monitoring tag,
 * all while in the universe; a position held through a removal is stranded, because
 * the stale-series guard then skips the symbol before any exit runs.
 *
 * Source: the keyless CMS endpoints behind binance.com/en/support/announcement
 * (catalog 161 "Delisting", 49 "Latest Binance News"). Undocumented and rate-limited
 * (HTTP 429 after ~100 quick requests), so live reads the newest page of each catalog
 * once per 4h period and fetches a body only for a new pair-removal notice. Cached to
 * disk; the replay reads the same file and keeps events announced by its clock. A
 * failed refresh keeps the cache: no new events, nothing extra blocked (fail-open).
 *
 * Event: { coin, kind, announcedAt, effectiveAt, pair?, notice, title }
 *   kind: 'monitoring_tag' | 'monitoring_tag_removed' | 'pair_removal' | 'token_delist'
 *   pair: the removed `<COIN>/USDC` pair (pair_removal only — other quotes are not ours)
 */

const CACHE = 'data/exchangeEvents.json';
const LIST_URL = 'https://www.binance.com/bapi/composite/v1/public/cms/article/list/query';
const DETAIL_URL = 'https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query';
export const CATALOGS = { delisting: 161, news: 49 };
const PERIOD_MS = 4 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;
const dayStart = (iso) => Date.parse(`${iso}T00:00:00Z`);

/** Coin tickers in a title segment: "ACX, LSK & STX" → ['ACX', 'LSK', 'STX']; "SLX (SLIMEX)" → 'SLX'. */
function coinsIn(segment) {
  return segment.split(/,|&|\band\b/)
    .map((s) => s.trim().split(/\s+/)[0])
    .filter((s) => /^[A-Z0-9]{1,15}$/.test(s));
}

/** The text of the title between `marker` and the next clause ("…, Remove …", " on <date>"). */
function clause(title, marker) {
  const i = title.indexOf(marker);
  if (i < 0) return null;
  const rest = title.slice(i + marker.length);
  // "…for ZEC and the Seed Tag for ENA" — the Seed Tag is a different list.
  return rest.split(/,?\s+and\s+the\b|,?\s+(?:and\s+)?(?:Remove|Extend|Add)\b|\s+on\s+\d{4}-|\s+\(\d{4}-/)[0];
}

/** Plain text of a CMS article body (a JSON node tree, or already a string). */
export function bodyText(body) {
  const walk = (n) => {
    if (typeof n === 'string') return n;
    if (Array.isArray(n)) return n.map(walk).join('');
    if (!n || typeof n !== 'object') return '';
    const inner = (n.child ? walk(n.child) : '') + (n.text ?? '');
    return inner + (n.node === 'element' && /^(p|li|tr|td|br|h\d)$/.test(n.tag) ? '\n' : '');
  };
  try {
    return walk(JSON.parse(body));
  } catch {
    return String(body ?? '');
  }
}

/** True when a notice's events need its body (the removed pairs are listed only there). */
export const needsBody = (title) => /^(?:Updated )?Notice of Removal of (?:Spot )?Trading Pairs/i.test(title);

/**
 * Events in one notice. Pure: `title` and `releaseDate` from the list, `text` the
 * body's plain text when needsBody(title).
 */
export function parseNotice({ code, title, releaseDate, text = '' }) {
  const base = { announcedAt: Number(releaseDate), notice: code, title };
  const events = [];
  if (/Monitoring Tag/i.test(title)) {
    const added = clause(title, 'Monitoring Tag to Include ');
    for (const coin of added ? coinsIn(added) : []) events.push({ ...base, coin, kind: 'monitoring_tag', effectiveAt: base.announcedAt });
    const removed = clause(title, 'Remove the Monitoring Tag for ');
    for (const coin of removed ? coinsIn(removed) : []) events.push({ ...base, coin, kind: 'monitoring_tag_removed', effectiveAt: base.announcedAt });
    return events;
  }
  const delist = /^Binance Will Delist (.+?) on (\d{4}-\d{2}-\d{2})/.exec(title);
  if (delist) {
    for (const coin of coinsIn(delist[1])) events.push({ ...base, coin, kind: 'token_delist', effectiveAt: dayStart(delist[2]) });
    return events;
  }
  if (needsBody(title)) {
    // "At 2026-06-12 03:00 (UTC): LSK/USDC, …" — one line per removal time.
    const lines = text.split('\n');
    const fallback = DATE_RE.exec(title)?.[1];
    for (const line of lines) {
      const at = /At (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \(UTC\)/.exec(line);
      const effectiveAt = at ? Date.parse(`${at[1]}T${at[2]}:00Z`) : (fallback ? dayStart(fallback) : null);
      for (const m of line.matchAll(/\b([A-Z0-9]{1,15})\/USDC\b/g)) {
        events.push({ ...base, coin: m[1], kind: 'pair_removal', pair: `${m[1]}/USDC`, effectiveAt });
      }
    }
  }
  return events;
}

/** The cached events, or null. Used by the replay scripts. */
export function readExchangeEventsCache(cachePath = CACHE) {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const d = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return Array.isArray(d?.events) ? d : null;
  } catch {
    return null;
  }
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** One page of a catalog's notice list: [{code, title, releaseDate}]. */
export async function fetchNoticePage(catalogId, pageNo, { pageSize = 50, fetchImpl = fetch } = {}) {
  const json = await getJson(`${LIST_URL}?type=1&catalogId=${catalogId}&pageNo=${pageNo}&pageSize=${pageSize}`, fetchImpl);
  const articles = json?.data?.catalogs?.[0]?.articles;
  if (!Array.isArray(articles)) throw new Error(`no articles in catalog ${catalogId} page ${pageNo}`);
  return articles.map(({ code, title, releaseDate }) => ({ code, title, releaseDate }));
}

/** A notice body's plain text. */
export async function fetchNoticeText(code, { fetchImpl = fetch } = {}) {
  const json = await getJson(`${DETAIL_URL}?articleCode=${code}`, fetchImpl);
  if (!json?.data) throw new Error(`no body for notice ${code}`);
  return bodyText(json.data.body);
}

/**
 * Adds the events of `notices` not yet in `cache.seen` (fetching bodies as needed)
 * and returns the new cache. A body that fails to load leaves its notice unseen, so
 * the next refresh retries it.
 */
export async function ingestNotices(cache, notices, { fetchImpl = fetch, pauseMs = 0 } = {}) {
  const seen = new Set(cache?.seen ?? []);
  const events = [...(cache?.events ?? [])];
  for (const n of notices) {
    if (!n?.code || seen.has(n.code)) continue;
    let text = '';
    if (needsBody(n.title)) {
      try {
        text = await fetchNoticeText(n.code, { fetchImpl });
      } catch (err) {
        logger.warn(`Exchange events: body of "${n.title}" failed (${err.message}) — retried next refresh`);
        continue;
      }
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    events.push(...parseNotice({ ...n, text }));
    seen.add(n.code);
  }
  events.sort((a, b) => a.announcedAt - b.announcedAt);
  return { ...cache, events, seen: [...seen] };
}

/**
 * The cached events, refreshed once per 4h period (every scalper and satellite cycle
 * starts one): the replay applies each event from its announcement time, so live must
 * have read the feed since the last cycle boundary to match it.
 *
 * @returns {Promise<{fetchedAt:number, events:object[], seen:string[]}|null>}
 */
export async function loadExchangeEvents({ now = Date.now(), cachePath = CACHE, fetchImpl = fetch } = {}) {
  const cached = readExchangeEventsCache(cachePath);
  if (cached && cached.fetchedAt >= Math.floor(now / PERIOD_MS) * PERIOD_MS) return cached;
  try {
    const notices = [];
    for (const id of Object.values(CATALOGS)) notices.push(...await fetchNoticePage(id, 1, { fetchImpl }));
    const next = { ...(await ingestNotices(cached ?? { events: [], seen: [] }, notices, { fetchImpl })), fetchedAt: now };
    fs.writeFileSync(cachePath, JSON.stringify(next));
    return next;
  } catch (err) {
    logger.warn(`Exchange events: feed refresh failed (${err.message})${cached ? ' — using the cache' : ' — no events'}`);
    return cached;
  }
}

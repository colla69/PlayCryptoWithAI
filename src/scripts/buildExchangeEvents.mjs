/**
 * buildExchangeEvents.mjs — backfill data/exchangeEvents.json from Binance's whole
 * announcement history (the live feed only reads the newest page of each catalog).
 *
 * Pages through the delisting and news catalogs back to --since, then parses every
 * notice with the live parser (src/data/exchangeEventsFeed.js), fetching a body only
 * for a pair-removal notice. The endpoint answers HTTP 429 after ~100 quick requests,
 * so requests are paced and a 429 waits and retries. Resumable: notices already in
 * the cache are skipped, and a run that stops part-way keeps what it parsed.
 *
 * Usage: node src/scripts/buildExchangeEvents.mjs [--since 2020-01-01] [--pause-ms 3000] [--out data/exchangeEvents.json]
 */
import fs from 'fs';
import {
  CATALOGS, fetchNoticePage, ingestNotices, readExchangeEventsCache,
} from '../data/exchangeEventsFeed.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const since = Date.parse(arg('since', '2020-01-01'));
const pauseMs = Number(arg('pause-ms', 3000));
const out = arg('out', 'data/exchangeEvents.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with a wait-and-retry on 429; other errors surface to the caller.
async function politeFetch(url, opts) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 || attempt >= 6) return res;
    console.log(`  429 — waiting ${30 * attempt}s`);
    await sleep(30_000 * attempt);
  }
}

const cache = readExchangeEventsCache(out) ?? { fetchedAt: 0, events: [], seen: [] };
const notices = [];
for (const [name, id] of Object.entries(CATALOGS)) {
  for (let page = 1; page <= 200; page++) {
    const rows = await fetchNoticePage(id, page, { fetchImpl: politeFetch });
    notices.push(...rows);
    await sleep(pauseMs);
    const oldest = Math.min(...rows.map((r) => r.releaseDate));
    console.log(`${name} page ${page}: ${rows.length} notices, oldest ${rows.length ? new Date(oldest).toISOString().slice(0, 10) : '—'}`);
    if (rows.length < 50 || oldest < since) break;
  }
}
const relevant = notices.filter((n) => n.releaseDate >= since);
const next = await ingestNotices(cache, relevant, { fetchImpl: politeFetch, pauseMs });
// fetchedAt stays as it was: a backfill is not the live refresh of the newest page.
fs.writeFileSync(out, JSON.stringify({ ...next, fetchedAt: cache.fetchedAt ?? 0 }));
const byKind = {};
for (const e of next.events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
console.log(`${relevant.length} notices since ${new Date(since).toISOString().slice(0, 10)} · ${next.seen.length} parsed · events ${JSON.stringify(byKind)} → ${out}`);

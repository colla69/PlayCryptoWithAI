import fs from 'fs';
import path from 'path';
import { runtimeDir } from '../utils/runtimePaths.js';

/**
 * Forward recorder for the exchange-flow gauges (plan doc § H). Coin Metrics
 * rewrites its exchange-flow history when its address labels change, so the
 * downloaded history cannot be backtested honestly; each snapshot keeps the last
 * 45 days exactly as published at that moment, and `gaugesAsOf()`
 * (src/backtester/gaugeSnapshots.js) later rebuilds EX1/EX7 from the snapshot that
 * existed at each decision time.
 *
 * Research only: nothing here feeds a trading decision. The bot calls it on a
 * timer so the snapshots accumulate wherever the bot runs; `recordContextGauges.mjs`
 * calls the same code by hand.
 */

export const SNAPSHOT_ASSETS = ['btc', 'eth'];
const WINDOW_DAYS = 45; // 30-day supply change + 7-day net flow + room for a late row
const DAY = 86_400_000;
const FETCH_TIMEOUT_MS = 15_000;

export const snapshotDir = () => path.join(runtimeDir('data'), 'context', 'snapshots');
const snapshotFile = (asset, dir) => path.join(dir, `cm_exchange_${asset}.jsonl`);

/**
 * Every snapshot recorded for `asset`, oldest first ([] when none). A line cut short
 * by a crash mid-append is skipped, so one bad write cannot stop all later ones.
 */
export function readSnapshots(asset, dir = snapshotDir()) {
  const file = snapshotFile(asset, dir);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** The last WINDOW_DAYS of BTC/ETH exchange supply and flows, as the API returns them now. */
export async function fetchExchangeFlows(asset, now = Date.now(), fetchImpl = fetch) {
  const start = new Date(now - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const rows = [];
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}` +
    `&metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv&frequency=1d&start_time=${start}&page_size=1000&paging_from=start`;
  for (let page = 0; url && page < 10; page++) {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Coin Metrics ${asset} HTTP ${res.status}`);
    const body = await res.json();
    for (const e of body.data ?? []) {
      const r = { t: Date.parse(e.time), sply: Number(e.SplyExNtv), fin: Number(e.FlowInExNtv), fout: Number(e.FlowOutExNtv) };
      if ([r.t, r.sply, r.fin, r.fout].every(Number.isFinite)) rows.push(r);
    }
    url = body.next_page_url ?? null;
  }
  if (!rows.length) throw new Error(`Coin Metrics ${asset}: no rows`);
  return rows.sort((a, b) => a.t - b.t);
}

/**
 * Append one snapshot per asset, skipping an asset whose last snapshot is younger
 * than `minGapMs` (restarts and the bot's timer must not pile up near-duplicates).
 * Never throws: each asset's outcome is returned for the caller to log.
 *
 * @returns {Promise<Array<{asset:string, status:'recorded'|'skipped'|'failed', rows?:object[], error?:string}>>}
 */
export async function recordSnapshots({ now = Date.now(), dir = snapshotDir(), minGapMs = 0, fetchImpl = fetch } = {}) {
  const out = [];
  for (const asset of SNAPSHOT_ASSETS) {
    try {
      const last = readSnapshots(asset, dir).at(-1);
      if (last && now - last.recordedAt < minGapMs) {
        out.push({ asset, status: 'skipped' });
        continue;
      }
      const rows = await fetchExchangeFlows(asset, now, fetchImpl);
      fs.mkdirSync(dir, { recursive: true });
      const file = snapshotFile(asset, dir);
      // After a crash mid-append the file ends without a newline; start a fresh line
      // so the cut-off fragment does not swallow this snapshot too.
      const lead = fs.existsSync(file) && fs.statSync(file).size > 0 && !fs.readFileSync(file, 'utf8').endsWith('\n') ? '\n' : '';
      fs.appendFileSync(file, `${lead}${JSON.stringify({ recordedAt: now, asset, rows })}\n`);
      out.push({ asset, status: 'recorded', rows });
    } catch (err) {
      out.push({ asset, status: 'failed', error: err.message });
    }
  }
  return out;
}

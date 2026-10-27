/**
 * recordContextGauges.mjs — record Coin Metrics exchange flows as published, so the
 * gauges that cannot be backtested honestly can be judged on forward data.
 *
 * The downloaded history (downloadContextData --only flows) is recomputed: every row
 * carries a 2026 computation time, so a backtest on it sees exchange labels nobody
 * had at the time (plan doc § G2, § H). Each run appends one snapshot per asset —
 * the last 45 days exactly as the API returns them now — to
 * data/context/snapshots/cm_exchange_<asset>.jsonl. `gaugesAsOf()` later rebuilds
 * EX1/EX7 from the snapshot that existed at each decision time.
 *
 * The Coinbase premium and perp open interest need no recording: both are rebuilt
 * from price and exchange history that is not revised.
 *
 * Run once a day (cron/launchd); a missed day is a gap, not an error.
 * Usage: node src/scripts/recordContextGauges.mjs [--report]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exchangeGauges, revisionStats } from '../backtester/gaugeSnapshots.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../data/context/snapshots');
const ASSETS = ['btc', 'eth'];
const WINDOW_DAYS = 45; // 30-day supply change + 7-day net flow + room for a late row
const DAY = 86_400_000;

const file = (asset) => path.join(OUT_DIR, `cm_exchange_${asset}.jsonl`);
const day = (t) => new Date(t).toISOString().slice(0, 10);
const fmtGauges = (g) => (g
  ? `row ${day(g.t)}  supply vs 30d ${g.d30 == null ? 'n/a' : `${(100 * g.d30).toFixed(2)}%`}` +
    `  net 7d ${g.net7 == null ? 'n/a' : g.net7.toFixed(0)}` +
    `  EX1 ${g.d30 > 0 ? 'ON' : 'off'}  EX7 ${g.net7 > 0 ? 'ON' : 'off'}`
  : 'no rows');

function readSnapshots(asset) {
  if (!fs.existsSync(file(asset))) return [];
  return fs.readFileSync(file(asset), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function fetchRecent(asset, recordedAt) {
  const start = new Date(recordedAt - WINDOW_DAYS * DAY).toISOString().slice(0, 10);
  const rows = [];
  let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}` +
    `&metrics=SplyExNtv,FlowInExNtv,FlowOutExNtv&frequency=1d&start_time=${start}&page_size=1000&paging_from=start`;
  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coin Metrics ${asset} HTTP ${res.status}`);
    const body = await res.json();
    for (const e of body.data ?? []) {
      const r = { t: Date.parse(e.time), sply: Number(e.SplyExNtv), fin: Number(e.FlowInExNtv), fout: Number(e.FlowOutExNtv) };
      if (Number.isFinite(r.sply) && Number.isFinite(r.fin) && Number.isFinite(r.fout)) rows.push(r);
    }
    url = body.next_page_url ?? null;
  }
  return rows.sort((a, b) => a.t - b.t);
}

if (process.argv.includes('--report')) {
  for (const asset of ASSETS) {
    const snaps = readSnapshots(asset);
    console.log(`\n${asset.toUpperCase()}: ${snaps.length} snapshots` +
      (snaps.length ? `  ${new Date(snaps[0].recordedAt).toISOString()} → ${new Date(snaps.at(-1).recordedAt).toISOString()}` : ''));
    for (const s of snaps.slice(-10)) {
      console.log(`  recorded ${new Date(s.recordedAt).toISOString().slice(0, 16)}  ${fmtGauges(exchangeGauges(s.rows))}`);
    }
    const rev = revisionStats(snaps);
    console.log(`  revisions: ${rev.comparisons} day-pairs compared; largest change from first published value ` +
      Object.entries(rev.maxRelChange).map(([f, v]) => `${f} ${(100 * v).toFixed(2)}%`).join(', '));
  }
} else {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const recordedAt = Date.now();
  let failed = false;
  for (const asset of ASSETS) {
    try {
      const rows = await fetchRecent(asset, recordedAt);
      if (!rows.length) throw new Error(`Coin Metrics ${asset}: no rows`);
      fs.appendFileSync(file(asset), `${JSON.stringify({ recordedAt, asset, rows })}\n`);
      console.log(`${asset.toUpperCase()} ${rows.length} rows  ${fmtGauges(exchangeGauges(rows))}`);
    } catch (err) {
      console.error(`${asset.toUpperCase()} not recorded: ${err.message}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

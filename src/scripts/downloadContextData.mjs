/**
 * downloadContextData.mjs — fetch the "new information" data sources for
 * edge-overlay research (docs/TREND_CORE_STUDY.md):
 *
 *   1. Perp funding rates (Binance fapi, public, 8h prints since 2019-09) —
 *      positioning/sentiment signal; usable even though the account is spot-only.
 *   2. Macro cross-asset (FRED, keyless CSV): NASDAQ Composite, broad dollar
 *      index, 10y Treasury yield.
 *   3. On-chain valuation (CoinMetrics community API): MVRV + active addresses
 *      for BTC/ETH.
 *   4. Fear & Greed full history (alternative.me, limit=0 — the bot's own cache
 *      only keeps the last 1000 days).
 *   5. Coinbase premium, hourly since 2021-05 (Coinbase Exchange + Binance spot,
 *      public) — US spot demand relative to Binance.
 *
 * Everything lands in data/context/*.json as sorted [{t, ...}] arrays.
 * Idempotent: re-running refreshes the files. All endpoints are free/keyless.
 *
 * Usage: node src/scripts/downloadContextData.mjs [--only funding|fred|onchain|fng|coinbase]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(__dirname, '../../data/context');
fs.mkdirSync(OUT_DIR, { recursive: true });

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const save = (name, rows) => {
  fs.writeFileSync(path.join(OUT_DIR, name), JSON.stringify(rows));
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  console.log(`${name.padEnd(24)} ${String(rows.length).padStart(6)} rows  ${fmt(rows[0].t)} → ${fmt(rows.at(-1).t)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 1. Funding rates ──────────────────────────────────────────────────────────
if (!only || only === 'funding') {
  for (const coin of ['BTC', 'ETH', 'BNB', 'SOL']) {
    const rows = [];
    let start = Date.parse('2019-09-01');
    while (true) {
      const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${coin}USDT&startTime=${start}&limit=1000`;
      const batch = await (await fetch(url)).json();
      if (!Array.isArray(batch) || !batch.length) break;
      for (const e of batch) rows.push({ t: e.fundingTime, r: Number(e.fundingRate) });
      start = batch.at(-1).fundingTime + 1;
      if (batch.length < 1000) break;
      await sleep(300);
    }
    rows.sort((a, b) => a.t - b.t);
    save(`funding_${coin}.json`, rows);
  }
}

// ── 2. FRED macro series (keyless CSV) ────────────────────────────────────────
if (!only || only === 'fred') {
  for (const id of ['NASDAQCOM', 'DTWEXBGS', 'DGS10']) {
    const csv = await (await fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}`)).text();
    const rows = csv.trim().split('\n').slice(1)
      .map((line) => {
        const [date, value] = line.split(',');
        return { t: Date.parse(`${date}T00:00:00Z`), v: Number(value) };
      })
      .filter((r) => Number.isFinite(r.v)); // FRED marks holidays as '.'
    save(`fred_${id}.json`, rows);
    await sleep(300);
  }
}

// ── 3. CoinMetrics community (MVRV + active addresses) ───────────────────────
if (!only || only === 'onchain') {
  for (const asset of ['btc', 'eth']) {
    const rows = [];
    let url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${asset}` +
      `&metrics=CapMVRVCur,AdrActCnt&frequency=1d&start_time=2016-01-01&page_size=10000`;
    while (url) {
      const body = await (await fetch(url)).json();
      for (const e of body.data ?? []) {
        rows.push({ t: Date.parse(e.time), mvrv: Number(e.CapMVRVCur), adract: Number(e.AdrActCnt) });
      }
      url = body.next_page_url ?? null;
      await sleep(300);
    }
    rows.sort((a, b) => a.t - b.t);
    save(`cm_${asset}.json`, rows);
  }
}

// ── 4. Fear & Greed full history ──────────────────────────────────────────────
if (!only || only === 'fng') {
  const body = await (await fetch('https://api.alternative.me/fng/?limit=0&format=json')).json();
  const rows = (body.data ?? [])
    .map((e) => ({ t: Number(e.timestamp) * 1000, v: Number(e.value) }))
    .filter((r) => Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t);
  save('fng.json', rows);
}

// ── 5. Coinbase premium, hourly (US spot demand vs Binance) ──────────────────
// p = Coinbase BTC-USD ÷ (Binance BTCUSDT × Coinbase USDT-USD) − 1. The USDT term
// strips tether's own drift from the dollar out of the gap; Coinbase's USDT-USD
// starts 2021-05-04, so the series does too. Closed hours only, all three present.
if (!only || only === 'coinbase') {
  const H = 3_600_000;
  const now = Date.now();
  const from = Date.parse('2021-05-01');
  const closes = new Map();
  const bn = new Map();
  for (let start = from; ;) {
    const batch = await (await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${start}&limit=1000`)).json();
    for (const k of batch) if (k[0] + H <= now) bn.set(k[0], Number(k[4]));
    if (batch.length < 1000) break;
    start = batch.at(-1)[0] + H;
    await sleep(150);
  }
  closes.set('BN', bn);
  for (const product of ['BTC-USD', 'USDT-USD']) {
    const m = new Map();
    for (let s = from; s < now; s += 300 * H) {
      const e = Math.min(s + 300 * H, now);
      const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'playAIStocks-research' } });
      if (!res.ok) throw new Error(`Coinbase ${product} ${res.status}`);
      for (const [t, , , , close] of await res.json()) {
        const ms = t * 1000;
        if (ms >= s && ms < e && ms + H <= now) m.set(ms, Number(close));
      }
      await sleep(150);
    }
    closes.set(product, m);
  }
  const rows = [];
  for (const [t, b] of [...bn].sort((x, y) => x[0] - y[0])) {
    const cb = closes.get('BTC-USD').get(t);
    const usdt = closes.get('USDT-USD').get(t);
    if (cb && usdt && b) rows.push({ t, p: cb / (b * usdt) - 1 });
  }
  save('coinbase_premium_1h.json', rows);
}

console.log('CONTEXT-DOWNLOAD-DONE');

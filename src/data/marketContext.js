/**
 * Market context cache (Phase 3).
 *
 * Pulls and caches three external signals the bot is currently blind to:
 *
 *   1. BTC dominance (% of total crypto mcap) — CoinGecko /global (keyless)
 *   2. ETHBTC ratio (altseason proxy)         — Binance public spot
 *   3. Fear & Greed Index                     — already in src/data/fearGreed.js
 *
 * All sources are OPTIONAL — each one falls back to a "neutral" value when
 * the API is unreachable so the bot keeps trading on local Binance data.
 *
 * Live + backtester both consume the *cached file* so historical replay is
 * deterministic and live decisions are reproducible. The cache files live
 * under data/marketContext/ and are gitignored.
 *
 * The module exposes:
 *   • refreshMarketContext()  — call periodically (e.g. every 12h alignment)
 *   • getBtcDominanceTrend()  — { value, sma7d, deltaPct } — for the BTC.D gate
 *   • getEthBtcTrend()        — { value, sma7d, deltaPct } — for ETHBTC sizing
 *   • neutralContext()        — fallback shape when network fails
 */

import fs from 'fs';
import path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'marketContext');
const BTCD_FILE = path.join(CACHE_DIR, 'btcDominance.json');
const ETHBTC_FILE = path.join(CACHE_DIR, 'ethBtc.json');

const SOFT_TTL_MS = 6 * 60 * 60 * 1000;   // 6h — refresh if older than this
const HARD_TTL_MS = 48 * 60 * 60 * 1000;  // 48h — fall back to neutral if older

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch { return null; }
}

function writeJson(file, value) {
  ensureCacheDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/**
 * Push a daily sample into a rolling series, dedup by ISO day key.
 */
function pushDaily(series, ts, value) {
  const day = new Date(ts).toISOString().slice(0, 10);
  if (!Number.isFinite(value)) return series;
  const next = series.filter((p) => p.day !== day);
  next.push({ day, ts, value });
  next.sort((a, b) => a.ts - b.ts);
  return next.slice(-180); // keep last 6 months of daily samples
}

function sma(values, window) {
  if (!values.length) return null;
  const tail = values.slice(-window);
  if (tail.length < Math.min(window, 3)) return null;
  return tail.reduce((s, v) => s + v, 0) / tail.length;
}

/**
 * Fetch current BTC dominance from CoinGecko /global. Returns a number in
 * [0, 100] (percent) or null on failure.
 */
async function fetchBtcDominance() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/global', {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const v = json?.data?.market_cap_percentage?.btc;
    return Number.isFinite(Number(v)) ? Number(v) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch current ETHBTC price from Binance public ticker. No auth needed.
 * Returns a positive number or null on failure.
 */
async function fetchEthBtc() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHBTC', {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const p = Number(json?.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Refresh both BTC.D and ETHBTC caches. Each fetch is independent — failure
 * of one does not abort the other. Returns the latest state for caller
 * convenience. Safe to call on every cycle (no-op if soft TTL not expired).
 */
export async function refreshMarketContext({ force = false } = {}) {
  ensureCacheDir();
  const now = Date.now();

  // ── BTC dominance ────────────────────────────────────────────────────────
  let btcdCache = readJson(BTCD_FILE) ?? { series: [], fetchedAt: 0 };
  if (force || (now - (btcdCache.fetchedAt ?? 0) >= SOFT_TTL_MS)) {
    const fresh = await fetchBtcDominance();
    if (fresh != null) {
      btcdCache.series = pushDaily(btcdCache.series ?? [], now, fresh);
      btcdCache.fetchedAt = now;
      btcdCache.latest = fresh;
      writeJson(BTCD_FILE, btcdCache);
    }
  }

  // ── ETHBTC ──────────────────────────────────────────────────────────────
  let ethbtcCache = readJson(ETHBTC_FILE) ?? { series: [], fetchedAt: 0 };
  if (force || (now - (ethbtcCache.fetchedAt ?? 0) >= SOFT_TTL_MS)) {
    const fresh = await fetchEthBtc();
    if (fresh != null) {
      ethbtcCache.series = pushDaily(ethbtcCache.series ?? [], now, fresh);
      ethbtcCache.fetchedAt = now;
      ethbtcCache.latest = fresh;
      writeJson(ETHBTC_FILE, ethbtcCache);
    }
  }

  return { btcdCache, ethbtcCache };
}

function readSeriesFresh(file) {
  const cache = readJson(file);
  if (!cache?.series?.length) return null;
  if (Date.now() - (cache.fetchedAt ?? 0) > HARD_TTL_MS) return null; // too stale
  return cache;
}

/**
 * Compute BTC dominance trend: latest, 7-day SMA, and delta pp (latest − SMA).
 * Returns null when no fresh data is available.
 */
export function getBtcDominanceTrend() {
  const cache = readSeriesFresh(BTCD_FILE);
  if (!cache) return null;
  const values = cache.series.map((p) => p.value);
  const latest = values.at(-1);
  const sma7 = sma(values, 7);
  if (sma7 == null) return { value: latest, sma7d: null, deltaPct: 0 };
  return {
    value: latest,
    sma7d: sma7,
    deltaPct: Number((latest - sma7).toFixed(3)),
  };
}

/**
 * Compute ETHBTC trend: latest, 7-day SMA, and delta as a fraction of SMA.
 * (Fraction is more useful than absolute pp for a ratio.)
 */
export function getEthBtcTrend() {
  const cache = readSeriesFresh(ETHBTC_FILE);
  if (!cache) return null;
  const values = cache.series.map((p) => p.value);
  const latest = values.at(-1);
  const sma7 = sma(values, 7);
  if (sma7 == null || sma7 <= 0) return { value: latest, sma7d: null, deltaFrac: 0 };
  return {
    value: latest,
    sma7d: sma7,
    deltaFrac: Number(((latest - sma7) / sma7).toFixed(4)),
  };
}

/**
 * Backtester replay helper: given a historical timestamp, return the
 * BTC dominance / ETHBTC snapshot AS OF that day (uses cached daily series).
 *
 * IMPORTANT: This is a thin shim. For deterministic backtesting of windows
 * predating the cache's first entry, the caller MUST extend the cache file
 * by hand (or accept the neutral fallback). We never look-ahead — only the
 * series entries with ts <= asOfTs are considered.
 */
export function getContextAsOf(asOfTs) {
  const btcd = readJson(BTCD_FILE)?.series ?? [];
  const ethbtc = readJson(ETHBTC_FILE)?.series ?? [];
  const cutBtcd = btcd.filter((p) => p.ts <= asOfTs);
  const cutEthbtc = ethbtc.filter((p) => p.ts <= asOfTs);
  return {
    btcDominance: cutBtcd.length
      ? { value: cutBtcd.at(-1).value, sma7d: sma(cutBtcd.map((p) => p.value), 7) }
      : null,
    ethBtc: cutEthbtc.length
      ? { value: cutEthbtc.at(-1).value, sma7d: sma(cutEthbtc.map((p) => p.value), 7) }
      : null,
  };
}

/**
 * Neutral fallback shape for callers that need a defined object.
 */
export function neutralContext() {
  return {
    btcDominance: null,
    ethBtc: null,
  };
}

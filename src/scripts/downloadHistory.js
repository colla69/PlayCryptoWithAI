/**
 * downloadHistory.js
 * Downloads up to 2 years of 4h OHLCV data for all configured symbols
 * and saves it to the local candle cache (data/candles/).
 *
 * Uses the REAL Binance public API (unauthenticated) regardless of testnet
 * mode — historical OHLCV is public data and not available on testnet.
 *
 * Usage:  npm run download-history
 *         npm run download-history -- --years 2 --timeframe 4h
 */
import 'dotenv/config';
import ccxt from 'ccxt';
import config from '../../config/default.js';
import { saveCachedCandles, loadCachedCandles } from '../exchange/candleCache.js';

// ── Public-only Binance client (always real Binance, no auth needed) ──────────
const publicClient = new ccxt.binance({ enableRateLimit: true });

const TF_MS = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
  '6h': 21_600_000, '12h': 43_200_000, '1d': 86_400_000,
};

async function fetchHistorical(symbol, timeframe, totalCandles) {
  const msPerCandle = TF_MS[timeframe] ?? 14_400_000;
  const batchSize   = 1000;
  const allRaw      = [];
  let since = Date.now() - totalCandles * msPerCandle;

  while (allRaw.length < totalCandles) {
    const batch = await publicClient.fetchOHLCV(symbol, timeframe, since, batchSize);
    if (!batch.length) break;
    allRaw.push(...batch);
    since = batch.at(-1)[0] + msPerCandle;
    if (batch.length < batchSize) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const seen = new Set();
  const clean = allRaw.filter(([ts]) => { if (seen.has(ts)) return false; seen.add(ts); return true; });
  clean.sort((a, b) => a[0] - b[0]);

  return clean.slice(-totalCandles).map(([timestamp, open, high, low, close, volume]) => ({
    timestamp, open: Number(open), high: Number(high),
    low: Number(low), close: Number(close), volume: Number(volume),
  }));
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const yearsArg     = args.includes('--years')     ? Number(args[args.indexOf('--years')     + 1]) : 2;
const timeframeArg = args.includes('--timeframe') ? String(args[args.indexOf('--timeframe') + 1]) : config.timeframe;
const msPerCandle  = TF_MS[timeframeArg] ?? 14_400_000;
const totalCandles = Math.ceil((yearsArg * 365.25 * 24 * 3600 * 1000) / msPerCandle) + 10;

// ── Helpers ──────────────────────────────────────────────────────────────────
function bar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + `] ${done}/${total}`;
}

function fmt(ms) {
  if (ms < 1000)  return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`\n📥  Historical candle downloader`);
console.log(`    Timeframe : ${timeframeArg}`);
console.log(`    History   : ${yearsArg} year(s) → ~${totalCandles} candles per symbol`);
console.log(`    Symbols   : ${config.symbols.join(', ')}\n`);

const results = [];

for (const symbol of config.symbols) {
  const t0 = Date.now();
  process.stdout.write(`  ${symbol.padEnd(12)}`);

  try {
    const cached = await loadCachedCandles(symbol, timeframeArg);
    const lastTs = cached.at(-1)?.timestamp ?? 0;
    const isUndersizedCache = cached.length < totalCandles;
    const sinceTs = lastTs ? lastTs + msPerCandle : Date.now() - totalCandles * msPerCandle;

    let merged = [...cached];

    if (isUndersizedCache) {
      process.stdout.write(` backfilling to ${totalCandles} candles… `);
      merged = await fetchHistorical(symbol, timeframeArg, totalCandles);
      await saveCachedCandles(symbol, timeframeArg, merged);
      process.stdout.write(`+${Math.max(0, merged.length - cached.length)} new  `);
    } else if (sinceTs < Date.now() - msPerCandle) {
      const needed = Math.ceil((Date.now() - sinceTs) / msPerCandle) + 5;
      process.stdout.write(` fetching ${needed} new candles… `);

      const fresh = await fetchHistorical(symbol, timeframeArg, needed);
      const seen = new Set(cached.map((c) => c.timestamp));
      const added = fresh.filter((c) => !seen.has(c.timestamp));

      merged = [...cached, ...added];
      const cutoff = Date.now() - yearsArg * 365 * 24 * 60 * 60 * 1000;
      merged = merged.filter((c) => c.timestamp >= cutoff);
      merged.sort((a, b) => a.timestamp - b.timestamp);

      await saveCachedCandles(symbol, timeframeArg, merged);
      process.stdout.write(`+${added.length} new  `);
    } else {
      process.stdout.write(` already up-to-date      `);
    }

    const elapsed = Date.now() - t0;
    const from = new Date(merged.at(0)?.timestamp ?? 0).toISOString().slice(0, 10);
    const to   = new Date(merged.at(-1)?.timestamp ?? 0).toISOString().slice(0, 10);
    console.log(`✅  ${merged.length} candles  ${from} → ${to}  (${fmt(elapsed)})`);
    results.push({ symbol, candles: merged.length, ok: true });
  } catch (err) {
    console.log(`❌  ${err.message}`);
    results.push({ symbol, candles: 0, ok: false, error: err.message });
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────────────────');
const ok  = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);
console.log(`  ✅ ${ok.length}/${results.length} symbols downloaded successfully`);
if (ok.length) {
  const total = ok.reduce((s, r) => s + r.candles, 0);
  console.log(`  📊 Total candles stored: ${total.toLocaleString()}`);
}
if (bad.length) {
  console.log(`  ❌ Failed: ${bad.map((r) => r.symbol).join(', ')}`);
}
console.log('\n  Ready for backtesting!  npm run backtest\n');

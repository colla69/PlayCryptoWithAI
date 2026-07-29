/**
 * rebuildDeepHistory.mjs
 *
 * Rebuilds deep 12h candle history by resampling the 4h caches.
 *
 * Binance serves only ~390 days of 12h klines for these USDC pairs, but the 4h
 * series reaches back to 2020 — and a 12h bar is exactly three 4h bars on the
 * UTC grid, so the conversion is lossless. Without this the multi-year baseline
 * windows (y1_holdout, y1y2_full) cannot be computed at all.
 *
 * SAFETY: the resampled series is verified bar-for-bar against the real 12h
 * candles wherever they overlap BEFORE anything is written. Any mismatch aborts
 * that symbol. Writes go through the merge-preserving saveCachedCandles, so the
 * existing (authoritative) recent bars are kept and only older history is added.
 *
 * Usage:
 *   node src/scripts/rebuildDeepHistory.mjs            # dry run — verify only
 *   node src/scripts/rebuildDeepHistory.mjs --write    # verify, then persist
 *   node src/scripts/rebuildDeepHistory.mjs --write --symbols BTC/USDC,ETH/USDC
 */
import config from '../../config/default.js';
import { loadCachedCandles, saveCachedCandles } from '../exchange/candleCache.js';
import { resampleCandles, diffAgainstActual } from '../utils/resampleCandles.js';

const argv = process.argv.slice(2);
const write = argv.includes('--write');
const symbolsArg = argv.includes('--symbols') ? argv[argv.indexOf('--symbols') + 1] : null;
const symbols = symbolsArg ? symbolsArg.split(',').map((s) => s.trim()) : config.symbols;

const day = (t) => new Date(t).toISOString().slice(0, 10);
const pad = (s, n) => String(s).padStart(n);

console.log(`\n🔁  Rebuild deep 12h history from 4h  ${write ? '(WRITING)' : '(dry run — no writes)'}`);
console.log(`    symbols: ${symbols.length}\n`);
console.log('  symbol        4h bars   12h before                12h after                 verified  status');

let written = 0; let failed = 0; let skipped = 0;

for (const symbol of symbols) {
  const label = symbol.replace('/USDC', '').padEnd(12);
  const src = await loadCachedCandles(symbol, '4h');
  const actual = await loadCachedCandles(symbol, '12h');

  if (src.length < 3) { console.log(`  ${label} ${pad(src.length, 8)}   — no 4h history, skipped`); skipped++; continue; }

  const { candles: resampled } = resampleCandles(src, '4h', '12h');
  const { compared, mismatches } = diffAgainstActual(resampled, actual);

  const before = actual.length
    ? `${pad(actual.length, 5)} ${day(actual[0].timestamp)}→${day(actual.at(-1).timestamp)}`
    : `${pad(0, 5)} (none)                `;

  if (mismatches.length) {
    const m = mismatches[0];
    console.log(`  ${label} ${pad(src.length, 8)}   ${before}   ABORTED — ${mismatches.length} mismatch(es), first: ` +
      `${day(m.timestamp)} ${m.field} resampled=${m.resampled} actual=${m.actual}`);
    failed++;
    continue;
  }

  if (compared === 0) {
    // Nothing to check against means we cannot prove the aggregation is right.
    console.log(`  ${label} ${pad(src.length, 8)}   ${before}   REFUSED — no overlap to verify against`);
    failed++;
    continue;
  }

  const merged = resampled.length
    ? `${pad(resampled.length, 5)} ${day(resampled[0].timestamp)}→${day(resampled.at(-1).timestamp)}`
    : 'none';

  if (write) {
    // Merge-preserving: keeps existing bars older than the payload's first
    // timestamp, payload wins from there. Resampled history starts EARLIER than
    // the cache, so this replaces the whole range with verified data.
    await saveCachedCandles(symbol, '12h', resampled);
    written++;
  }
  console.log(`  ${label} ${pad(src.length, 8)}   ${before}   ${merged}   ${pad(compared, 5)}    ${write ? '✅ written' : '✅ verified'}`);
}

console.log(`\n  ${write ? `written: ${written}` : `verified: ${symbols.length - failed - skipped}`}   failed: ${failed}   skipped: ${skipped}`);
if (!write && !failed) console.log('  Re-run with --write to persist.\n');
if (failed) { console.log('  ⚠️  Some symbols failed verification — nothing was written for those.\n'); process.exit(1); }
console.log();

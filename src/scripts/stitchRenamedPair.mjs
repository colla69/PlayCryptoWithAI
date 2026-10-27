/**
 * stitchRenamedPair.mjs — carry a coin's candle history across a ticker rebrand.
 *
 * Binance renames a coin by halting the old pair and opening a new one (TON → GRAM,
 * 2026-06-30 → 07-02, 1:1). The old pair then returns frozen klines forever and the
 * new one starts with no history, so the bot loses the coin twice: the stale guard
 * skips the old symbol, and the new one has too few bars to trade. This writes
 * `<NEW>_USDC_<tf>.json` = the old history + the new pair's bars, merged payload-wins
 * through mergeCandles(). It refuses when the new pair's first open is more than
 * --max-gap-pct away from the old pair's last close: a swap at a ratio other than
 * 1:1 needs the old prices rescaled, which this does not do.
 *
 * New bars stop where the set's BTC file stops (per timeframe), so a stitched file never
 * runs past the rest of a frozen research set. The old files are left in place; move
 * them out of the set by hand once checked.
 *
 * Usage:
 *   node src/scripts/stitchRenamedPair.mjs --old TON --new GRAM [--dir data/candles]
 *     [--until 2026-08-10T21:00:00Z]   — also drop bars opening at or after this
 *     [--timeframes 12h,4h,15m] [--max-gap-pct 5] [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';
import { mergeCandles } from '../utils/mergeCandles.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const oldCoin = arg('old');
const newCoin = arg('new');
const dir = arg('dir', 'data/candles');
const until = arg('until') ? Date.parse(arg('until')) : Infinity;
const timeframes = arg('timeframes', '12h,4h,15m').split(',');
const maxGapPct = Number(arg('max-gap-pct', 5));
const dryRun = argv.includes('--dry-run');
if (!oldCoin || !newCoin) {
  console.error('usage: --old <COIN> --new <COIN> [--dir data/candles] [--until <ISO>] [--timeframes 12h,4h,15m] [--max-gap-pct 5] [--dry-run]');
  process.exit(1);
}

// Public market data only, like downloadHistory.js: no keys, always real Binance.
const client = new ccxt.binance({ enableRateLimit: true });
const TF_MS = { '15m': 900_000, '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000, '1d': 86_400_000 };

async function fetchSince(symbol, timeframe, since) {
  const rows = [];
  for (let from = since; ;) {
    const batch = await client.fetchOHLCV(symbol, timeframe, from, 1000);
    if (!batch.length) break;
    rows.push(...batch);
    from = batch.at(-1)[0] + TF_MS[timeframe];
    if (batch.length < 1000) break;
  }
  return rows.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume),
  }));
}

let failed = false;
for (const tf of timeframes) {
  const oldFile = path.join(dir, `${oldCoin}_USDC_${tf}.json`);
  const newFile = path.join(dir, `${newCoin}_USDC_${tf}.json`);
  const old = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
  const last = old.at(-1);
  const btcEnd = JSON.parse(fs.readFileSync(path.join(dir, `BTC_USDC_${tf}.json`), 'utf8')).at(-1).timestamp;
  // The exchange's last closed bars, never the cycle's forming one.
  const payload = (await fetchSince(`${newCoin}/USDC`, tf, last.timestamp + TF_MS[tf]))
    .filter((c) => c.timestamp < until && c.timestamp <= btcEnd && c.timestamp + TF_MS[tf] <= Date.now());
  if (!payload.length) {
    console.error(`${tf}: no ${newCoin}/USDC bars after ${new Date(last.timestamp).toISOString()}`);
    failed = true;
    continue;
  }
  const gapPct = 100 * Math.abs(payload[0].open / last.close - 1);
  const line = `${tf}: ${oldCoin} ${old.length} bars → ${new Date(last.timestamp).toISOString()} close ${last.close} | ` +
    `${newCoin} ${payload.length} bars from ${new Date(payload[0].timestamp).toISOString()} open ${payload[0].open} | gap ${gapPct.toFixed(2)}%`;
  if (!(gapPct <= maxGapPct)) {
    console.error(`${line} — REFUSED (over ${maxGapPct}%: not a 1:1 swap?)`);
    failed = true;
    continue;
  }
  const merged = mergeCandles(old, payload, { cap: 0 });
  console.log(`${line} → ${merged.length} bars${dryRun ? ' (dry run)' : ` → ${newFile}`}`);
  if (!dryRun) fs.writeFileSync(newFile, JSON.stringify(merged));
}
process.exit(failed ? 1 : 0);

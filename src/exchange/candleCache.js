import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../data/candles');

function cacheFile(symbol, timeframe) {
  // BTC/USDT → BTC_USDT
  const safe = symbol.replace('/', '_');
  return path.join(ROOT, `${safe}_${timeframe}.json`);
}

export async function loadCachedCandles(symbol, timeframe) {
  try {
    const raw = await fs.readFile(cacheFile(symbol, timeframe), 'utf8');
    const candles = JSON.parse(raw);
    if (Array.isArray(candles) && candles.length) {
      logger.info(`Cache hit: ${symbol} ${timeframe} — ${candles.length} candles from disk`);
      return candles;
    }
  } catch {
    // File doesn't exist or is invalid — treat as cold start
  }
  return [];
}

export async function saveCachedCandles(symbol, timeframe, candles) {
  try {
    await fs.mkdir(ROOT, { recursive: true });
    // Merge-preserve: callers pass their capped in-memory window (the trading
    // loop keeps ~2500 bars), but the disk cache may hold years of backfilled
    // research history. A blind overwrite truncates it (this happened — a paper
    // boot destroyed the 6yr 12h backfill). Keep existing bars strictly OLDER
    // than the payload's first timestamp; the payload wins from there on.
    let toWrite = Array.isArray(candles) ? candles : [];
    if (!toWrite.length) {
      // Never wipe an existing cache with an empty payload.
      return;
    }
    try {
      const raw = await fs.readFile(cacheFile(symbol, timeframe), 'utf8');
      const existing = JSON.parse(raw);
      if (Array.isArray(existing) && existing.length) {
        const firstNew = toWrite[0].timestamp;
        const older = existing.filter((c) => Number(c?.timestamp) < firstNew);
        if (older.length) toWrite = [...older, ...toWrite];
      }
    } catch {
      // No existing cache or unreadable — plain write
    }
    await fs.writeFile(cacheFile(symbol, timeframe), JSON.stringify(toWrite), 'utf8');
    logger.debug(`Cache saved: ${symbol} ${timeframe} — ${toWrite.length} candles`);
  } catch (err) {
    logger.warn(`Cache write failed for ${symbol}: ${err.message}`);
  }
}

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
    await fs.writeFile(cacheFile(symbol, timeframe), JSON.stringify(candles), 'utf8');
    logger.debug(`Cache saved: ${symbol} ${timeframe} — ${candles.length} candles`);
  } catch (err) {
    logger.warn(`Cache write failed for ${symbol}: ${err.message}`);
  }
}

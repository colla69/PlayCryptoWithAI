/**
 * Entry filters, live side: gathers what each gate reads and hands it to the
 * shared decision core (`decisionCore.js`), which the backtester calls too.
 */
import { evaluateEntryGates } from './decisionCore.js';
import { getBtcDominanceTrend } from '../data/marketContext.js';
import logger from '../utils/logger.js';

/**
 * Fear & Greed entry threshold modulator (Phase 3).
 *
 * Adjusts the per-symbol minConfidence based on market sentiment:
 *   - Extreme greed (>= greedHigh): TIGHTEN by tightenBy → demand more conviction
 *   - Extreme fear (<= fearLow):    LOOSEN by loosenBy → contrarian, easier entry
 *   - Otherwise: no-op
 *
 * Returns the *adjusted* minConfidence. Caller compares signal.confidence
 * against the returned value.
 *
 * @param {number} originalMinConf
 * @param {number} fearGreedValue   — 0-100
 * @param {{enabled?: boolean, greedHigh?: number, fearLow?: number,
 *          tightenBy?: number, loosenBy?: number}} cfg
 * @returns {{ minConfidence: number, regime: 'greed'|'fear'|'neutral' }}
 */
export function calcFearGreedAdjustedThreshold(originalMinConf, fearGreedValue, cfg) {
  const base = Number(originalMinConf);
  if (!Number.isFinite(base)) return { minConfidence: 0, regime: 'neutral' };
  if (!cfg?.enabled || !Number.isFinite(fearGreedValue)) {
    return { minConfidence: base, regime: 'neutral' };
  }
  const greedHigh = Number(cfg.greedHigh ?? 80);
  const fearLow   = Number(cfg.fearLow   ?? 20);
  const tightenBy = Number(cfg.tightenBy ?? 0.05);
  const loosenBy  = Number(cfg.loosenBy  ?? 0.05);
  if (fearGreedValue >= greedHigh) {
    return {
      minConfidence: Math.min(1, Math.max(0, base + tightenBy)),
      regime: 'greed',
    };
  }
  if (fearGreedValue <= fearLow) {
    return {
      minConfidence: Math.min(1, Math.max(0, base - loosenBy)),
      regime: 'fear',
    };
  }
  return { minConfidence: base, regime: 'neutral' };
}

/**
 * Run all entry filters for a BUY. Returns the first block reason or null.
 * Fetch failures pass the gate that needed the data, as before: a missing 15m
 * or 4h series must not block every entry.
 * @param {object} params
 * @param {string} params.symbol
 * @param {import('../types.js').Candle[]} params.candles — the decision series
 * @param {Array<{symbol: string}>} params.openPositions
 * @param {object} params.correlationMatrix
 * @param {Function} params.fetchOHLCV — returns bars closed by the cycle time
 * @param {object} params.config - Full app config
 * @returns {Promise<{blockReason: string|null, mtfSizeFactor: number}>}
 */
export async function runEntryFilters({ symbol, candles, openPositions, correlationMatrix, fetchOHLCV, config, recentTrades = [], referenceEquity = 0 }) {
  const fetchBars = async (timeframe, limit) => {
    try {
      return await fetchOHLCV(symbol, timeframe, limit);
    } catch (err) {
      logger.warn(`${symbol}: ${timeframe === '15m' ? 'MTF' : '4h MTF'} filter fetch failed — ${err.message}`);
      return null;
    }
  };
  const bars15m = config.mtfFilter?.enabled
    ? await fetchBars('15m', Math.max(20, (config.mtfFilter.alignBars ?? 16) + 4))
    : null;
  const bars4h = config.mtf4hFilter?.enabled
    ? await fetchBars('4h', config.mtf4hFilter.fetchBars ?? 30)
    : null;

  const result = evaluateEntryGates({
    symbol,
    config,
    weeklyDD: { recentTrades, referenceEquity },
    btcDominance: config.btcDominance?.enabled ? getBtcDominanceTrend() : null,
    candles,
    correlation: { openPositions, matrix: correlationMatrix },
    bars15m,
    bars4h,
  });
  if (result.blockReason) {
    logger.info(`${symbol}: BUY suppressed — ${result.blockReason}`);
  } else if (result.mtfSizeFactor < 1.0) {
    logger.info(`${symbol}: MTF misaligned — position reduced to ${(result.mtfSizeFactor * 100).toFixed(0)}%`);
  }
  return { blockReason: result.blockReason, mtfSizeFactor: result.mtfSizeFactor };
}

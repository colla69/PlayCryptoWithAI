/**
 * Entry filters — pure functions that decide whether a BUY signal should be blocked.
 * Each filter returns either null (pass) or a string reason (block).
 */
import { isMarketTrending } from '../utils/indicators.js';
import { mtfAlignScore, mtf4hMomentumScore } from '../utils/mtfAlignment.js';
import {
  calcCorrelationCap,
  calcWeeklyDDBreaker,
} from '../risk/portfolioRisk.js';
import { getBtcDominanceTrend, getEthBtcTrend } from '../data/marketContext.js';
import logger from '../utils/logger.js';

/**
 * Regime filter: blocks BUY in ranging (low-ADX) markets.
 * @param {import('../types.js').Candle[]} candles
 * @param {{enabled?: boolean, adxPeriod?: number, adxThreshold?: number}} regimeCfg
 * @returns {string|null} Block reason or null
 */
export function checkRegimeFilter(candles, regimeCfg) {
  if (!regimeCfg?.enabled) return null;
  if (!isMarketTrending(candles, regimeCfg.adxPeriod, regimeCfg.adxThreshold)) {
    return `Ranging market (ADX < ${regimeCfg.adxThreshold})`;
  }
  return null;
}

/**
 * Correlation filter: blocks BUY if already holding a correlated coin.
 * Delegates to calcCorrelationCap so live ≡ backtest.
 * @param {string} symbol
 * @param {Array<{symbol: string}>} openPositions
 * @param {object} correlationMatrix
 * @param {{enabled?: boolean, threshold?: number}} corrConfig
 * @returns {string|null} Block reason or null
 */
export function checkCorrelationFilter(symbol, openPositions, correlationMatrix, corrConfig) {
  if (!corrConfig?.enabled) return null;
  const cap = calcCorrelationCap({
    candidateSymbol: symbol,
    openPositions,
    correlationMatrix,
    threshold: corrConfig.threshold ?? 0.85,
  });
  if (!cap.blocked) return null;
  const short = cap.conflictSymbol.replace('/USDC', '').replace('/USDT', '');
  return `Correlated with open ${short} (r=${cap.correlation.toFixed(2)})`;
}

/**
 * Weekly DD circuit breaker: blocks new entries after the rolling 7-day
 * portfolio P&L breaches the loss threshold.
 * @param {Array<{timestamp: string|number, pnl: number, side: string}>} recentTrades
 * @param {number} initialBalance
 * @param {{enabled?: boolean, lossThreshold?: number, cooldownHours?: number}} ddConfig
 * @returns {string|null} Block reason or null
 */
export function checkWeeklyDDBreaker(recentTrades, initialBalance, ddConfig) {
  if (!ddConfig?.enabled) return null;
  const breaker = calcWeeklyDDBreaker({
    recentTrades,
    initialBalance,
    lossThreshold: ddConfig.lossThreshold ?? 0.10,
    cooldownHours: ddConfig.cooldownHours ?? 72,
  });
  return breaker.blocked ? breaker.reason : null;
}

/**
 * BTC Dominance gate (Phase 3): block alt entries when BTC.D 7-day SMA is
 * trending strongly UP. Logic: rising BTC dominance means money is flowing
 * INTO Bitcoin from alts → alts likely to underperform / crash short-term.
 *
 * Pass-through (returns null) when:
 *   - btcDominance.enabled is false
 *   - candidate symbol IS BTC/USDC (gate doesn't self-apply)
 *   - market context cache is empty or SMA not yet established
 *
 * @param {string} symbol
 * @param {{enabled?: boolean, blockThresholdPp?: number}} cfg
 * @returns {string|null}
 */
export function checkBtcDominanceGate(symbol, cfg) {
  if (!cfg?.enabled) return null;
  if (typeof symbol !== 'string' || symbol.startsWith('BTC/')) return null;
  const trend = getBtcDominanceTrend();
  if (!trend || trend.sma7d == null) return null;
  const threshold = Number(cfg.blockThresholdPp ?? 1.0); // +1pp above 7d SMA
  if (trend.deltaPct >= threshold) {
    return `BTC.D rising +${trend.deltaPct.toFixed(2)}pp vs 7d SMA (${trend.value.toFixed(2)}% vs ${trend.sma7d.toFixed(2)}%) ≥ ${threshold}pp — alt entry blocked`;
  }
  return null;
}

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
 * MTF 15m alignment filter: blocks or reduces BUY when short-term trend is bearish.
 * @param {string} symbol
 * @param {Function} fetchOHLCV - Candle fetcher function
 * @param {{enabled?: boolean, alignBars?: number, minAlignScore?: number, reduceFactor?: number}} mtfConfig
 * @returns {Promise<{blockReason: string|null, sizeFactor: number}>}
 */
export async function checkMTFFilter(symbol, fetchOHLCV, mtfConfig) {
  if (!mtfConfig?.enabled) return { blockReason: null, sizeFactor: 1.0 };
  try {
    const fetchBars = Math.max(20, (mtfConfig.alignBars ?? 16) + 4);
    const bars15m = await fetchOHLCV(symbol, '15m', fetchBars);
    if (bars15m.length < (mtfConfig.alignBars ?? 16)) return { blockReason: null, sizeFactor: 1.0 };

    const score = mtfAlignScore(bars15m, bars15m.length - 1, mtfConfig.alignBars ?? 16);
    const threshold = mtfConfig.minAlignScore ?? 0.5;
    if (score < threshold) {
      const pct = (score * 100).toFixed(0);
      const reduce = mtfConfig.reduceFactor ?? 0;
      if (reduce > 0) {
        logger.info(`${symbol}: MTF misaligned (${pct}% green) — position reduced to ${(reduce * 100).toFixed(0)}%`);
        return { blockReason: null, sizeFactor: reduce };
      }
      return { blockReason: `MTF misaligned (15m: ${pct}% green < ${(threshold * 100).toFixed(0)}% required)`, sizeFactor: 1.0 };
    }
  } catch (err) {
    logger.warn(`${symbol}: MTF filter fetch failed — ${err.message}`);
  }
  return { blockReason: null, sizeFactor: 1.0 };
}

/**
 * 4h momentum filter: blocks BUY when 4h EMA/RSI trend is bearish.
 * @param {string} symbol
 * @param {Function} fetchOHLCV
 * @param {{enabled?: boolean, fetchBars?: number, lookback?: number, minScore?: number}} cfg4h
 * @returns {Promise<string|null>} Block reason or null
 */
export async function checkMTF4hFilter(symbol, fetchOHLCV, cfg4h) {
  if (!cfg4h?.enabled) return null;
  try {
    const bars4h = await fetchOHLCV(symbol, '4h', cfg4h.fetchBars ?? 30);
    if (bars4h.length < (cfg4h.lookback ?? 21)) return null;

    const score = mtf4hMomentumScore(bars4h, bars4h.length - 1, cfg4h.lookback ?? 21);
    if (score < (cfg4h.minScore ?? 0.45)) {
      return `4h momentum bearish (score=${(score * 100).toFixed(0)}% < ${((cfg4h.minScore ?? 0.45) * 100).toFixed(0)}% required)`;
    }
  } catch (err) {
    logger.warn(`${symbol}: 4h MTF filter fetch failed — ${err.message}`);
  }
  return null;
}

/**
 * Run all entry filters in sequence. Returns the first block reason or null.
 * @param {object} params
 * @param {string} params.symbol
 * @param {import('../types.js').Candle[]} params.candles
 * @param {Array<{symbol: string}>} params.openPositions
 * @param {object} params.correlationMatrix
 * @param {Function} params.fetchOHLCV
 * @param {object} params.config - Full app config
 * @returns {Promise<{blockReason: string|null, mtfSizeFactor: number}>}
 */
export async function runEntryFilters({ symbol, candles, openPositions, correlationMatrix, fetchOHLCV, config, recentTrades = [], initialBalance = 0 }) {
  let mtfSizeFactor = 1.0;

  // Weekly DD circuit breaker (Phase 7) — check first, cheap and global
  const ddBlock = checkWeeklyDDBreaker(recentTrades, initialBalance, config.risk?.weeklyDDBreaker);
  if (ddBlock) {
    logger.info(`${symbol}: BUY suppressed — ${ddBlock}`);
    return { blockReason: ddBlock, mtfSizeFactor };
  }

  // BTC Dominance gate (Phase 3) — block alts during BTC.D spikes
  const btcdBlock = checkBtcDominanceGate(symbol, config.btcDominance);
  if (btcdBlock) {
    logger.info(`${symbol}: BUY suppressed — ${btcdBlock}`);
    return { blockReason: btcdBlock, mtfSizeFactor };
  }

  // Regime filter
  const regimeBlock = checkRegimeFilter(candles, config.regime);
  if (regimeBlock) {
    logger.info(`${symbol}: BUY suppressed — ${regimeBlock}`);
    return { blockReason: regimeBlock, mtfSizeFactor };
  }

  // Correlation filter
  const corrBlock = checkCorrelationFilter(symbol, openPositions, correlationMatrix, config.correlation);
  if (corrBlock) {
    logger.info(`${symbol}: BUY suppressed — ${corrBlock}`);
    return { blockReason: corrBlock, mtfSizeFactor };
  }

  // MTF 15m filter
  const mtfResult = await checkMTFFilter(symbol, fetchOHLCV, config.mtfFilter);
  if (mtfResult.blockReason) {
    logger.info(`${symbol}: BUY suppressed — ${mtfResult.blockReason}`);
    return { blockReason: mtfResult.blockReason, mtfSizeFactor };
  }
  mtfSizeFactor = mtfResult.sizeFactor;

  // 4h MTF momentum filter
  const mtf4hBlock = await checkMTF4hFilter(symbol, fetchOHLCV, config.mtf4hFilter);
  if (mtf4hBlock) {
    logger.info(`${symbol}: BUY suppressed — ${mtf4hBlock}`);
    return { blockReason: mtf4hBlock, mtfSizeFactor };
  }

  return { blockReason: null, mtfSizeFactor };
}

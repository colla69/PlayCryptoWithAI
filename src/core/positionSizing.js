/**
 * Position sizing chain — pure functions that compute the final maxPositionPct.
 * Each multiplier is applied sequentially to the base position size.
 */
import { computeATRPct, calculateADX } from '../utils/indicators.js';

/**
 * Scale position inversely to symbol volatility relative to portfolio median.
 * @param {number} basePct - Starting maxPositionPct
 * @param {import('../types.js').Candle[]} candles
 * @param {number|null} medianATRPct - Portfolio-wide median ATR%
 * @param {{enabled?: boolean, period?: number}} atrConfig
 * @returns {number}
 */
export function applyATRSizing(basePct, candles, medianATRPct, atrConfig) {
  if (!atrConfig?.enabled || medianATRPct == null) return basePct;
  const symbolATRPct = computeATRPct(candles, atrConfig.period);
  if (symbolATRPct <= 0) return basePct;
  return basePct * Math.max(0.5, Math.min(2.0, medianATRPct / symbolATRPct));
}

/**
 * Halve position size during BTC macro bear phase.
 * @param {number} pct
 * @param {boolean} btcMacroBull
 * @param {{enabled?: boolean, sizeReduceFactor?: number}} macroConfig
 * @returns {number}
 */
export function applyMacroFilter(pct, btcMacroBull, macroConfig) {
  if (!macroConfig?.enabled || btcMacroBull) return pct;
  return pct * (macroConfig.sizeReduceFactor ?? 0.5);
}

/**
 * Scale position by ADX trend strength (boost strong trends, penalize weak).
 * @param {number} pct
 * @param {import('../types.js').Candle[]} candles
 * @param {{enabled?: boolean, adxPeriod?: number, boostThresh?: number, boostFactor?: number, penaltyThresh?: number, penaltyFactor?: number}} regimeConfig
 * @returns {number}
 */
export function applyRegimeSizing(pct, candles, regimeConfig) {
  if (!regimeConfig?.enabled) return pct;
  const adxPeriod = regimeConfig.adxPeriod ?? 14;
  const adxLookback = Math.min(candles.length, 50);
  const recent = candles.slice(-adxLookback);
  if (recent.length < 30) return pct;

  const highs = recent.map(c => Number(c.high));
  const lows = recent.map(c => Number(c.low));
  const closes = recent.map(c => Number(c.close));
  const adxValues = calculateADX(highs, lows, closes, adxPeriod);
  const lastADX = adxValues.at(-1)?.adx;

  if (!Number.isFinite(lastADX)) return pct;
  if (lastADX >= regimeConfig.boostThresh) return pct * regimeConfig.boostFactor;
  if (lastADX < regimeConfig.penaltyThresh) return pct * regimeConfig.penaltyFactor;
  return pct;
}

/**
 * Scale position proportionally to signal confidence.
 * @param {number} pct
 * @param {number} confidence
 * @param {{enabled?: boolean, mid?: number, max?: number, min?: number}} confConfig
 * @returns {number}
 */
export function applyConfSizing(pct, confidence, confConfig) {
  if (!confConfig?.enabled) return pct;
  const conf = confidence ?? 0.65;
  const mid = confConfig.mid ?? 0.65;
  const max = confConfig.max ?? 1.5;
  const min = confConfig.min ?? 0.6;

  let scale;
  if (conf >= mid) {
    scale = 1 + (conf - mid) / (1 - mid) * (max - 1);
  } else {
    scale = min + (conf / mid) * (1 - min);
  }
  return pct * Math.min(max, Math.max(min, scale));
}

/**
 * Apply the full sizing chain in order.
 * @param {object} params
 * @param {number} params.basePct
 * @param {import('../types.js').Candle[]} params.candles
 * @param {number|null} params.medianATRPct
 * @param {boolean} params.btcMacroBull
 * @param {number} params.confidence
 * @param {number} params.mtfSizeFactor
 * @param {object} params.config - Full app config
 * @returns {number} Final position percentage
 */
export function computePositionSize({ basePct, candles, medianATRPct, btcMacroBull, confidence, mtfSizeFactor, config }) {
  let pct = basePct;
  pct = applyATRSizing(pct, candles, medianATRPct, config.atr);
  pct = applyMacroFilter(pct, btcMacroBull, config.macroFilter);
  pct = applyRegimeSizing(pct, candles, config.regimeSizing);
  pct = applyConfSizing(pct, confidence, config.confSizing);
  if (mtfSizeFactor < 1.0) pct *= mtfSizeFactor;
  return pct;
}

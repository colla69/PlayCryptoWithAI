import { OBV } from 'technicalindicators';
import { calculateEMA } from '../utils/indicators.js';

/**
 * OBV (On-Balance Volume) Strategy
 *
 * Cumulative volume indicator: adds volume on up-candles, subtracts on down-candles.
 * A rising OBV in an uptrend confirms institutional buying; divergence signals reversals.
 *
 * Dual signal sources:
 * 1. EMA crossover (original): OBV crosses above/below its EMA → BUY/SELL
 * 2. Divergence detection: price vs OBV divergence over a lookback window
 *    - Bullish divergence: price makes lower low, OBV makes higher low (accumulation)
 *    - Bearish divergence: price makes higher high, OBV makes lower high (distribution)
 *
 * Divergence signals get higher confidence since they detect hidden institutional activity.
 */
export class OBVStrategy {
  constructor(config = {}) {
    this.config = { emaPeriod: 20, divergenceLookback: 14, ...config };
  }

  analyze(candles) {
    const closed   = candles.slice(0, -1); // exclude forming candle
    const required = Math.max(this.config.emaPeriod + 2, this.config.divergenceLookback + 5);

    if (closed.length < required) {
      return {
        name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for OBV(EMA-${this.config.emaPeriod})`,
      };
    }

    const closes  = closed.map((c) => c.close);
    const volumes = closed.map((c) => c.volume);

    const obvRaw = OBV.calculate({ close: closes, volume: volumes });

    if (obvRaw.length < this.config.emaPeriod + 1) {
      return { name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0, reason: 'OBV: insufficient data' };
    }

    const emaValues = calculateEMA(obvRaw, this.config.emaPeriod);

    if (emaValues.length < 2) {
      return { name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0, reason: 'OBV EMA: insufficient data' };
    }

    const obv     = Number(obvRaw.at(-1));
    const prevObv = Number(obvRaw.at(-2));
    const ema     = Number(emaValues.at(-1));
    const prevEma = Number(emaValues.at(-2));

    // ── Divergence detection ──────────────────────────────────────────────────
    // Used to boost confidence of crossover signals (not standalone)
    const lookback = this.config.divergenceLookback;
    const divergence = this.#detectDivergence(closes, obvRaw, lookback);

    // ── EMA crossover (primary signal) ────────────────────────────────────────
    const crossedAbove = prevObv <= prevEma && obv > ema;
    const crossedBelow = prevObv >= prevEma && obv < ema;

    // Relative gap: how far OBV has moved past the EMA (capped at 1)
    const relGap = Math.abs(ema) > 0
      ? Math.min(Math.abs(obv - ema) / Math.abs(ema), 1)
      : 0;

    if (crossedAbove) {
      let confidence = Math.min(0.55 + relGap * 0.35, 0.90);
      let reason = `OBV crossed above EMA-${this.config.emaPeriod} — volume buyers in control`;
      // Boost if bullish divergence confirms
      if (divergence?.signal === 'BUY') {
        confidence = Math.min(confidence + 0.15, 0.95);
        reason += ' + bullish divergence';
      }
      return {
        name: 'OBV', signal: 'BUY', value: obv, ema,
        confidence: Number(confidence.toFixed(2)), reason,
      };
    }

    if (crossedBelow) {
      let confidence = Math.min(0.55 + relGap * 0.35, 0.90);
      let reason = `OBV crossed below EMA-${this.config.emaPeriod} — volume sellers in control`;
      // Boost if bearish divergence confirms
      if (divergence?.signal === 'SELL') {
        confidence = Math.min(confidence + 0.15, 0.95);
        reason += ' + bearish divergence';
      }
      return {
        name: 'OBV', signal: 'SELL', value: obv, ema,
        confidence: Number(confidence.toFixed(2)), reason,
      };
    }

    // No crossover — check if strong divergence alone should signal
    // Only trigger standalone divergence if it's very strong AND OBV position agrees
    if (divergence?.signal === 'BUY' && obv > ema && divergence.confidence >= 0.70) {
      return {
        name: 'OBV', signal: 'BUY', value: obv, ema,
        confidence: Number((divergence.confidence * 0.85).toFixed(2)),
        reason: divergence.reason + ' (OBV above EMA confirms)',
      };
    }
    if (divergence?.signal === 'SELL' && obv < ema && divergence.confidence >= 0.70) {
      return {
        name: 'OBV', signal: 'SELL', value: obv, ema,
        confidence: Number((divergence.confidence * 0.85).toFixed(2)),
        reason: divergence.reason + ' (OBV below EMA confirms)',
      };
    }

    const above = obv > ema;
    return {
      name: 'OBV', signal: 'HOLD', value: obv, ema, confidence: 0.2,
      reason: `OBV ${above ? 'above' : 'below'} EMA-${this.config.emaPeriod} — no cross`,
    };
  }

  /**
   * Detect price/OBV divergence over the lookback window.
   * - Bullish: price lower low + OBV higher low → accumulation
   * - Bearish: price higher high + OBV lower high → distribution
   * Returns null if no divergence found.
   */
  #detectDivergence(closes, obvValues, lookback) {
    if (obvValues.length < lookback + 1 || closes.length < lookback + 1) return null;

    const recentCloses = closes.slice(-lookback);
    const recentOBV = obvValues.slice(-lookback);

    // Find local extremes: first half vs second half of the lookback window
    const mid = Math.floor(lookback / 2);
    const firstCloses = recentCloses.slice(0, mid);
    const secondCloses = recentCloses.slice(mid);
    const firstOBV = recentOBV.slice(0, mid);
    const secondOBV = recentOBV.slice(mid);

    const firstPriceLow = Math.min(...firstCloses);
    const secondPriceLow = Math.min(...secondCloses);
    const firstOBVLow = Math.min(...firstOBV);
    const secondOBVLow = Math.min(...secondOBV);

    const firstPriceHigh = Math.max(...firstCloses);
    const secondPriceHigh = Math.max(...secondCloses);
    const firstOBVHigh = Math.max(...firstOBV);
    const secondOBVHigh = Math.max(...secondOBV);

    // Bullish divergence: price lower low + OBV higher low
    if (secondPriceLow < firstPriceLow * 0.99 && secondOBVLow > firstOBVLow * 1.01) {
      const strength = (secondOBVLow - firstOBVLow) / (Math.abs(firstOBVLow) || 1);
      const confidence = Number(Math.min(0.60 + Math.abs(strength) * 0.2, 0.85).toFixed(2));
      return {
        signal: 'BUY',
        confidence,
        reason: `Bullish OBV divergence — price ↓ but volume accumulating (${lookback} bars)`,
      };
    }

    // Bearish divergence: price higher high + OBV lower high
    if (secondPriceHigh > firstPriceHigh * 1.01 && secondOBVHigh < firstOBVHigh * 0.99) {
      const strength = (firstOBVHigh - secondOBVHigh) / (Math.abs(firstOBVHigh) || 1);
      const confidence = Number(Math.min(0.60 + Math.abs(strength) * 0.2, 0.85).toFixed(2));
      return {
        signal: 'SELL',
        confidence,
        reason: `Bearish OBV divergence — price ↑ but volume distributing (${lookback} bars)`,
      };
    }

    return null;
  }
}

export default OBVStrategy;

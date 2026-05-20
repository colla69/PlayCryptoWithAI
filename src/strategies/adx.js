import { calculateADX } from '../utils/indicators.js';

/**
 * ADX (Average Directional Index) Strategy
 *
 * Uses trend strength + direction to signal:
 * - BUY  when ADX > threshold AND +DI > -DI (strong uptrend)
 * - SELL when ADX > threshold AND -DI > +DI (strong downtrend)
 * - HOLD when ADX < threshold (choppy/ranging market — avoid trading)
 *
 * Confidence scales with both ADX magnitude (trend strength) and the
 * gap between +DI and -DI (directional conviction).
 */
export class ADXStrategy {
  constructor(config = {}) {
    this.config = { period: 14, threshold: 25, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const highs  = closed.map((c) => c.high);
    const lows   = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);

    if (closed.length < this.config.period * 2) {
      return { name: 'ADX', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for ADX-${this.config.period}` };
    }

    const values = calculateADX(highs, lows, closes, this.config.period);
    if (!values.length) {
      return { name: 'ADX', signal: 'HOLD', value: NaN, confidence: 0, reason: 'ADX: insufficient data' };
    }

    const { adx, pdi, mdi } = values.at(-1);
    const adxVal = Number(adx);
    const pdiVal = Number(pdi);
    const mdiVal = Number(mdi);

    if (adxVal < this.config.threshold) {
      return {
        name: 'ADX', signal: 'HOLD',
        adx: adxVal, pdi: pdiVal, mdi: mdiVal, confidence: 0.1,
        reason: `ADX ${adxVal.toFixed(1)} < ${this.config.threshold} — ranging, skip`,
      };
    }

    // Trend strength component: scales 0→1 from threshold to 60
    const trendStrength = Math.min((adxVal - this.config.threshold) / (60 - this.config.threshold), 1);
    // Directional conviction: scales 0→1 from 0 to 20 DI gap
    const diGap = Math.abs(pdiVal - mdiVal);
    const directionStrength = Math.min(diGap / 20, 1);
    const confidence = Number((0.45 + trendStrength * 0.35 + directionStrength * 0.2).toFixed(2));

    if (pdiVal > mdiVal) {
      return {
        name: 'ADX', signal: 'BUY',
        adx: adxVal, pdi: pdiVal, mdi: mdiVal, confidence,
        reason: `ADX ${adxVal.toFixed(1)} uptrend (+DI ${pdiVal.toFixed(1)} > -DI ${mdiVal.toFixed(1)})`,
      };
    }

    return {
      name: 'ADX', signal: 'SELL',
      adx: adxVal, pdi: pdiVal, mdi: mdiVal, confidence,
      reason: `ADX ${adxVal.toFixed(1)} downtrend (-DI ${mdiVal.toFixed(1)} > +DI ${pdiVal.toFixed(1)})`,
    };
  }
}

export default ADXStrategy;

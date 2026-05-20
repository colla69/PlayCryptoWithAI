import { calculateADX } from '../utils/indicators.js';

/**
 * ADX (Average Directional Index) Strategy
 *
 * Uses trend strength + direction to signal:
 * - BUY  when ADX > threshold AND +DI > -DI (strong uptrend)
 * - SELL when ADX > threshold AND -DI > +DI (strong downtrend)
 * - HOLD when ADX < threshold (choppy/ranging market — avoid trading)
 *
 * The key insight: ADX acts as a QUALITY FILTER that blocks signals
 * during ranging markets, which is the main cause of stop-loss churn.
 */
export class ADXStrategy {
  constructor(config = {}) {
    this.config = { period: 14, threshold: 25, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const highs = closed.map((c) => c.high);
    const lows = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);

    if (closed.length < this.config.period * 2) {
      return { name: 'ADX', signal: 'HOLD', value: NaN, reason: `Not enough candles for ADX-${this.config.period}` };
    }

    const values = calculateADX(highs, lows, closes, this.config.period);
    if (!values.length) {
      return { name: 'ADX', signal: 'HOLD', value: NaN, reason: 'ADX: insufficient data' };
    }

    const { adx, pdi, mdi } = values.at(-1);
    const adxVal = Number(adx);
    const pdiVal = Number(pdi);
    const mdiVal = Number(mdi);

    if (adxVal < this.config.threshold) {
      return {
        name: 'ADX',
        signal: 'HOLD',
        adx: adxVal,
        pdi: pdiVal,
        mdi: mdiVal,
        reason: `ADX ${adxVal.toFixed(1)} < ${this.config.threshold} — ranging market, skip`,
      };
    }

    if (pdiVal > mdiVal) {
      return {
        name: 'ADX',
        signal: 'BUY',
        adx: adxVal,
        pdi: pdiVal,
        mdi: mdiVal,
        reason: `ADX ${adxVal.toFixed(1)} strong uptrend (+DI ${pdiVal.toFixed(1)} > -DI ${mdiVal.toFixed(1)})`,
      };
    }

    return {
      name: 'ADX',
      signal: 'SELL',
      adx: adxVal,
      pdi: pdiVal,
      mdi: mdiVal,
      reason: `ADX ${adxVal.toFixed(1)} strong downtrend (-DI ${mdiVal.toFixed(1)} > +DI ${pdiVal.toFixed(1)})`,
    };
  }
}

export default ADXStrategy;

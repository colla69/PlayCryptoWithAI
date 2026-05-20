import { calculateCCI } from '../utils/indicators.js';

/**
 * CCI (Commodity Channel Index) Strategy
 *
 * Mean-reversion oscillator:
 * - BUY  when CCI < -100 (oversold extreme)
 * - SELL when CCI > +100 (overbought extreme)
 * - HOLD otherwise
 *
 * CCI complements RSI by being more sensitive to short-term extremes.
 * Combining CCI + RSI + BB gives triple confirmation of oversold/overbought.
 */
export class CCIStrategy {
  constructor(config = {}) {
    this.config = { period: 20, oversold: -100, overbought: 100, ...config };
  }

  analyze(candles) {
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const closes = candles.map((c) => c.close);

    if (candles.length < this.config.period) {
      return { name: 'CCI', signal: 'HOLD', value: NaN, reason: `Not enough candles for CCI-${this.config.period}` };
    }

    const values = calculateCCI(highs, lows, closes, this.config.period);
    if (!values.length) {
      return { name: 'CCI', signal: 'HOLD', value: NaN, reason: 'CCI: insufficient data' };
    }

    const latest = Number(values.at(-1));

    if (latest < this.config.oversold) {
      return {
        name: 'CCI',
        signal: 'BUY',
        value: latest,
        reason: `CCI ${latest.toFixed(1)} below oversold ${this.config.oversold}`,
      };
    }

    if (latest > this.config.overbought) {
      return {
        name: 'CCI',
        signal: 'SELL',
        value: latest,
        reason: `CCI ${latest.toFixed(1)} above overbought ${this.config.overbought}`,
      };
    }

    return {
      name: 'CCI',
      signal: 'HOLD',
      value: latest,
      reason: `CCI ${latest.toFixed(1)} in neutral zone`,
    };
  }
}

export default CCIStrategy;

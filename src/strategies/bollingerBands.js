import { calculateBollingerBands } from '../utils/indicators.js';

export class BollingerBandsStrategy {
  constructor(config = {}) {
    this.config = { period: 20, stdDev: 2, ...config };
  }

  analyze(candles) {
    const closes = candles.map((c) => c.close);

    if (closes.length < this.config.period) {
      return { name: 'BollingerBands', signal: 'HOLD', reason: `Not enough candles for BB(${this.config.period},${this.config.stdDev})` };
    }

    const bands = calculateBollingerBands(closes, this.config.period, this.config.stdDev);
    if (!bands.length) {
      return { name: 'BollingerBands', signal: 'HOLD', reason: 'Bollinger Bands: insufficient data' };
    }

    const { upper, middle, lower } = bands.at(-1);
    const price = closes.at(-1);
    const bandwidth = Number(((upper - lower) / middle).toFixed(6));

    if (price <= lower) {
      return {
        name: 'BollingerBands',
        signal: 'BUY',
        price, upper, middle, lower, bandwidth,
        reason: `Price ${price.toFixed(2)} at/below lower band ${lower.toFixed(2)}`,
      };
    }

    if (price >= upper) {
      return {
        name: 'BollingerBands',
        signal: 'SELL',
        price, upper, middle, lower, bandwidth,
        reason: `Price ${price.toFixed(2)} at/above upper band ${upper.toFixed(2)}`,
      };
    }

    return {
      name: 'BollingerBands',
      signal: 'HOLD',
      price, upper, middle, lower, bandwidth,
      reason: `Price ${price.toFixed(2)} inside bands [${lower.toFixed(2)}–${upper.toFixed(2)}]`,
    };
  }
}

export default BollingerBandsStrategy;

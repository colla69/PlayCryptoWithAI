import { calculateRSI } from '../utils/indicators.js';

export class RSIStrategy {
  constructor(config) {
    this.config = config;
  }

  analyze(candles) {
    const closes = candles.map((candle) => candle.close);

    if (closes.length < this.config.period) {
      return {
        name: 'RSI',
        signal: 'HOLD',
        value: NaN,
        reason: `Not enough candles for RSI-${this.config.period}`,
      };
    }

    const values = calculateRSI(closes, this.config.period);
    const latest = Number(values.at(-1));

    if (latest < this.config.oversold) {
      return {
        name: 'RSI',
        signal: 'BUY',
        value: latest,
        reason: `RSI ${latest.toFixed(2)} below oversold ${this.config.oversold}`,
      };
    }

    if (latest > this.config.overbought) {
      return {
        name: 'RSI',
        signal: 'SELL',
        value: latest,
        reason: `RSI ${latest.toFixed(2)} above overbought ${this.config.overbought}`,
      };
    }

    return {
      name: 'RSI',
      signal: 'HOLD',
      value: latest,
      reason: `RSI ${latest.toFixed(2)} within neutral range`,
    };
  }
}

export default RSIStrategy;

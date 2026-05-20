import { calculateEMA } from '../utils/indicators.js';

export class EMAStrategy {
  constructor(config) {
    this.config = config;
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const closes = closed.map((candle) => candle.close);
    const requiredCandles = Math.max(this.config.fast, this.config.slow) + 1;

    if (closes.length < requiredCandles) {
      return {
        name: 'EMA',
        signal: 'HOLD',
        fastEMA: NaN,
        slowEMA: NaN,
        reason: `Not enough candles for EMA ${this.config.fast}/${this.config.slow}`,
      };
    }

    const fastValues = calculateEMA(closes, this.config.fast);
    const slowValues = calculateEMA(closes, this.config.slow);

    const currentFast = Number(fastValues.at(-1));
    const previousFast = Number(fastValues.at(-2));
    const currentSlow = Number(slowValues.at(-1));
    const previousSlow = Number(slowValues.at(-2));

    const crossedAbove = previousFast <= previousSlow && currentFast > currentSlow;
    const crossedBelow = previousFast >= previousSlow && currentFast < currentSlow;

    if (crossedAbove) {
      return {
        name: 'EMA',
        signal: 'BUY',
        fastEMA: currentFast,
        slowEMA: currentSlow,
        reason: `EMA ${this.config.fast} crossed above EMA ${this.config.slow}`,
      };
    }

    if (crossedBelow) {
      return {
        name: 'EMA',
        signal: 'SELL',
        fastEMA: currentFast,
        slowEMA: currentSlow,
        reason: `EMA ${this.config.fast} crossed below EMA ${this.config.slow}`,
      };
    }

    return {
      name: 'EMA',
      signal: 'HOLD',
      fastEMA: currentFast,
      slowEMA: currentSlow,
      reason: `No EMA crossover detected (${currentFast.toFixed(4)} vs ${currentSlow.toFixed(4)})`,
    };
  }
}

export default EMAStrategy;

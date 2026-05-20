import { calculateEMA } from '../utils/indicators.js';

export class EMAStrategy {
  constructor(config) {
    this.config = config;
  }

  analyze(candles) {
    const closed    = candles.slice(0, -1);   // exclude forming candle
    const closes    = closed.map((candle) => candle.close);
    const requiredCandles = Math.max(this.config.fast, this.config.slow) + 1;

    if (closes.length < requiredCandles) {
      return {
        name: 'EMA', signal: 'HOLD', fastEMA: NaN, slowEMA: NaN, confidence: 0,
        reason: `Not enough candles for EMA ${this.config.fast}/${this.config.slow}`,
      };
    }

    const fastValues = calculateEMA(closes, this.config.fast);
    const slowValues = calculateEMA(closes, this.config.slow);

    const currentFast  = Number(fastValues.at(-1));
    const previousFast = Number(fastValues.at(-2));
    const currentSlow  = Number(slowValues.at(-1));
    const previousSlow = Number(slowValues.at(-2));

    const crossedAbove = previousFast <= previousSlow && currentFast > currentSlow;
    const crossedBelow = previousFast >= previousSlow && currentFast < currentSlow;

    if (crossedAbove) {
      // Stronger signal when fast EMA itself is rising (both EMAs aligned)
      const fastRising   = currentFast > previousFast;
      const slowRising   = currentSlow > previousSlow;
      const confidence   = Number((0.55 + (fastRising ? 0.15 : 0) + (slowRising ? 0.1 : 0)).toFixed(2));
      return {
        name: 'EMA', signal: 'BUY', fastEMA: currentFast, slowEMA: currentSlow, confidence,
        reason: `EMA${this.config.fast} crossed above EMA${this.config.slow}${fastRising && slowRising ? ' — both rising ↑' : ''}`,
      };
    }

    if (crossedBelow) {
      const fastFalling  = currentFast < previousFast;
      const slowFalling  = currentSlow < previousSlow;
      const confidence   = Number((0.55 + (fastFalling ? 0.15 : 0) + (slowFalling ? 0.1 : 0)).toFixed(2));
      return {
        name: 'EMA', signal: 'SELL', fastEMA: currentFast, slowEMA: currentSlow, confidence,
        reason: `EMA${this.config.fast} crossed below EMA${this.config.slow}${fastFalling && slowFalling ? ' — both falling ↓' : ''}`,
      };
    }

    return {
      name: 'EMA', signal: 'HOLD', fastEMA: currentFast, slowEMA: currentSlow, confidence: 0.2,
      reason: `No EMA crossover (fast ${currentFast.toFixed(4)} vs slow ${currentSlow.toFixed(4)})`,
    };
  }
}

export default EMAStrategy;

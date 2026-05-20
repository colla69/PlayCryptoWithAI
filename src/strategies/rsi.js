import { calculateRSI } from '../utils/indicators.js';

export class RSIStrategy {
  constructor(config) {
    this.config = config;
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const closes = closed.map((candle) => candle.close);

    // Need period + 1 so we can compare two consecutive RSI values for direction
    if (closes.length < this.config.period + 1) {
      return { name: 'RSI', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for RSI-${this.config.period}` };
    }

    const values = calculateRSI(closes, this.config.period);
    if (values.length < 2) {
      return { name: 'RSI', signal: 'HOLD', value: NaN, confidence: 0, reason: 'RSI: insufficient data' };
    }

    const prev   = Number(values.at(-2));
    const latest = Number(values.at(-1));
    const rising  = latest > prev;
    const falling = latest < prev;

    if (latest < this.config.oversold) {
      // Only buy when RSI is turning up — avoids catching a falling knife
      const extremity = Math.min((this.config.oversold - latest) / this.config.oversold, 1);
      const confidence = Number((0.5 + extremity * 0.4 + (rising ? 0.1 : 0)).toFixed(2));
      return {
        name: 'RSI',
        signal: rising ? 'BUY' : 'HOLD',
        value: latest,
        confidence,
        reason: `RSI ${latest.toFixed(1)} oversold${rising ? ' ↑ reversal confirmed' : ' — still falling, wait'}`,
      };
    }

    if (latest > this.config.overbought) {
      // Only sell when RSI is turning down — avoids shorting a still-rising market
      const extremity = Math.min((latest - this.config.overbought) / (100 - this.config.overbought), 1);
      const confidence = Number((0.5 + extremity * 0.4 + (falling ? 0.1 : 0)).toFixed(2));
      return {
        name: 'RSI',
        signal: falling ? 'SELL' : 'HOLD',
        value: latest,
        confidence,
        reason: `RSI ${latest.toFixed(1)} overbought${falling ? ' ↓ reversal confirmed' : ' — still rising, wait'}`,
      };
    }

    return { name: 'RSI', signal: 'HOLD', value: latest, confidence: 0.2,
      reason: `RSI ${latest.toFixed(1)} neutral` };
  }
}

export default RSIStrategy;

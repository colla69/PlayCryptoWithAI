import { calculateMACD } from '../utils/indicators.js';

export class MACDStrategy {
  constructor(config = {}) {
    this.config = { fast: 12, slow: 26, signal: 9, ...config };
  }

  analyze(candles) {
    const closes = candles.map((c) => c.close);
    const required = this.config.slow + this.config.signal;

    if (closes.length < required) {
      return { name: 'MACD', signal: 'HOLD', reason: `Not enough candles for MACD(${this.config.fast},${this.config.slow},${this.config.signal})` };
    }

    const values = calculateMACD(closes, this.config.fast, this.config.slow, this.config.signal);
    if (values.length < 2) {
      return { name: 'MACD', signal: 'HOLD', reason: 'MACD: insufficient data' };
    }

    const prev = values.at(-2);
    const curr = values.at(-1);
    const macdLine = Number(curr.MACD ?? 0);
    const signalLine = Number(curr.signal ?? 0);
    const histogram = Number(curr.histogram ?? 0);

    // Cross above signal line → BUY
    const crossedAbove = Number(prev.MACD ?? 0) <= Number(prev.signal ?? 0) && macdLine > signalLine;
    // Cross below signal line → SELL
    const crossedBelow = Number(prev.MACD ?? 0) >= Number(prev.signal ?? 0) && macdLine < signalLine;

    if (crossedAbove) {
      return { name: 'MACD', signal: 'BUY', macd: macdLine, signalLine, histogram, reason: `MACD crossed above signal (hist: ${histogram.toFixed(4)})` };
    }
    if (crossedBelow) {
      return { name: 'MACD', signal: 'SELL', macd: macdLine, signalLine, histogram, reason: `MACD crossed below signal (hist: ${histogram.toFixed(4)})` };
    }

    return {
      name: 'MACD',
      signal: 'HOLD',
      macd: macdLine,
      signalLine,
      histogram,
      reason: `MACD ${macdLine.toFixed(4)} vs signal ${signalLine.toFixed(4)} (hist: ${histogram.toFixed(4)})`,
    };
  }
}

export default MACDStrategy;

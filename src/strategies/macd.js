import { calculateMACD } from '../utils/indicators.js';

export class MACDStrategy {
  constructor(config = {}) {
    this.config = { fast: 12, slow: 26, signal: 9, ...config };
  }

  analyze(candles) {
    const closed  = candles.slice(0, -1);   // exclude forming candle
    const closes  = closed.map((c) => c.close);
    const required = this.config.slow + this.config.signal;

    if (closes.length < required) {
      return { name: 'MACD', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for MACD(${this.config.fast},${this.config.slow},${this.config.signal})` };
    }

    const values = calculateMACD(closes, this.config.fast, this.config.slow, this.config.signal);
    if (values.length < 2) {
      return { name: 'MACD', signal: 'HOLD', confidence: 0, reason: 'MACD: insufficient data' };
    }

    const prev = values.at(-2);
    const curr = values.at(-1);
    const prevMACD    = Number(prev.MACD     ?? 0);
    const prevSignal  = Number(prev.signal   ?? 0);
    const macdLine    = Number(curr.MACD     ?? 0);
    const signalLine  = Number(curr.signal   ?? 0);
    const histogram   = Number(curr.histogram ?? 0);
    const prevHist    = Number(prev.histogram ?? 0);

    const crossedAbove = prevMACD <= prevSignal && macdLine > signalLine;
    const crossedBelow = prevMACD >= prevSignal && macdLine < signalLine;

    // Histogram growing in the direction of the signal = momentum confirming the cross
    const histGrowing = Math.abs(histogram) > Math.abs(prevHist);
    // Zero-line position: crossovers in MACD's own positive/negative territory are stronger
    const aboveZero = macdLine > 0 && signalLine > 0;
    const belowZero = macdLine < 0 && signalLine < 0;

    if (crossedAbove) {
      const confidence = Number(Math.min(
        0.55 + (histGrowing ? 0.15 : 0) + (aboveZero ? 0.15 : 0), 1,
      ).toFixed(2));
      return {
        name: 'MACD', signal: 'BUY', macd: macdLine, signalLine, histogram, confidence,
        reason: `MACD crossed above signal${aboveZero ? ' (above zero)' : ''}${histGrowing ? ' ↑' : ''} hist:${histogram.toFixed(4)}`,
      };
    }

    if (crossedBelow) {
      const confidence = Number(Math.min(
        0.55 + (histGrowing ? 0.15 : 0) + (belowZero ? 0.15 : 0), 1,
      ).toFixed(2));
      return {
        name: 'MACD', signal: 'SELL', macd: macdLine, signalLine, histogram, confidence,
        reason: `MACD crossed below signal${belowZero ? ' (below zero)' : ''}${histGrowing ? ' ↓' : ''} hist:${histogram.toFixed(4)}`,
      };
    }

    return {
      name: 'MACD', signal: 'HOLD', macd: macdLine, signalLine, histogram, confidence: 0.2,
      reason: `MACD ${macdLine.toFixed(4)} vs signal ${signalLine.toFixed(4)} hist:${histogram.toFixed(4)}`,
    };
  }
}

export default MACDStrategy;

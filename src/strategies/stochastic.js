import { calculateStochastic } from '../utils/indicators.js';

export class StochasticStrategy {
  constructor(config = {}) {
    this.config = { period: 14, signalPeriod: 3, oversold: 20, overbought: 80, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const highs = closed.map((c) => c.high);
    const lows = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);
    const required = this.config.period + this.config.signalPeriod;

    if (closes.length < required) {
      return { name: 'Stochastic', signal: 'HOLD', reason: `Not enough candles for Stoch(${this.config.period},${this.config.signalPeriod})` };
    }

    const values = calculateStochastic(highs, lows, closes, this.config.period, this.config.signalPeriod);
    if (values.length < 2) {
      return { name: 'Stochastic', signal: 'HOLD', reason: 'Stochastic: insufficient data' };
    }

    const prev = values.at(-2);
    const curr = values.at(-1);
    const k = Number(curr.k ?? 0);
    const d = Number(curr.d ?? 0);

    // %K crosses above %D in oversold zone → BUY
    const crossedAboveOversold = Number(prev.k ?? 0) <= Number(prev.d ?? 0) && k > d && k < this.config.oversold + 10;
    // %K crosses below %D in overbought zone → SELL
    const crossedBelowOverbought = Number(prev.k ?? 0) >= Number(prev.d ?? 0) && k < d && k > this.config.overbought - 10;

    if (crossedAboveOversold || k < this.config.oversold) {
      return {
        name: 'Stochastic',
        signal: 'BUY',
        k, d,
        reason: `Stoch K=${k.toFixed(1)} D=${d.toFixed(1)} — oversold zone`,
      };
    }

    if (crossedBelowOverbought || k > this.config.overbought) {
      return {
        name: 'Stochastic',
        signal: 'SELL',
        k, d,
        reason: `Stoch K=${k.toFixed(1)} D=${d.toFixed(1)} — overbought zone`,
      };
    }

    return {
      name: 'Stochastic',
      signal: 'HOLD',
      k, d,
      reason: `Stoch K=${k.toFixed(1)} D=${d.toFixed(1)} — neutral`,
    };
  }
}

export default StochasticStrategy;

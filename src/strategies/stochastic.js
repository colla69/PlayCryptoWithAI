import { calculateStochastic } from '../utils/indicators.js';

export class StochasticStrategy {
  constructor(config = {}) {
    this.config = { period: 14, signalPeriod: 3, oversold: 20, overbought: 80, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const highs  = closed.map((c) => c.high);
    const lows   = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);
    const required = this.config.period + this.config.signalPeriod;

    if (closes.length < required) {
      return { name: 'Stochastic', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for Stoch(${this.config.period},${this.config.signalPeriod})` };
    }

    const values = calculateStochastic(highs, lows, closes, this.config.period, this.config.signalPeriod);
    if (values.length < 2) {
      return { name: 'Stochastic', signal: 'HOLD', confidence: 0, reason: 'Stochastic: insufficient data' };
    }

    const prev = values.at(-2);
    const curr = values.at(-1);
    const k     = Number(curr.k ?? 0);
    const d     = Number(curr.d ?? 0);
    const prevK = Number(prev.k ?? 0);
    const prevD = Number(prev.d ?? 0);

    // %K crosses above %D while both are in the oversold zone → BUY reversal
    const crossedAboveOversold  = prevK <= prevD && k > d && k < this.config.oversold + 10;
    // %K crosses below %D while both are in the overbought zone → SELL reversal
    const crossedBelowOverbought = prevK >= prevD && k < d && k > this.config.overbought - 10;

    // Confidence scales with how deeply in the zone the crossover occurred
    if (crossedAboveOversold) {
      const depth      = Math.max(this.config.oversold - k, 0);
      const confidence = Number(Math.min(0.55 + depth / this.config.oversold * 0.4, 1).toFixed(2));
      return {
        name: 'Stochastic', signal: 'BUY', k, d, confidence,
        reason: `Stoch K=${k.toFixed(1)} crossed above D=${d.toFixed(1)} in oversold zone`,
      };
    }

    if (crossedBelowOverbought) {
      const depth      = Math.max(k - this.config.overbought, 0);
      const confidence = Number(Math.min(0.55 + depth / (100 - this.config.overbought) * 0.4, 1).toFixed(2));
      return {
        name: 'Stochastic', signal: 'SELL', k, d, confidence,
        reason: `Stoch K=${k.toFixed(1)} crossed below D=${d.toFixed(1)} in overbought zone`,
      };
    }

    return {
      name: 'Stochastic', signal: 'HOLD', k, d, confidence: 0.2,
      reason: `Stoch K=${k.toFixed(1)} D=${d.toFixed(1)} — no crossover in extreme zone`,
    };
  }
}

export default StochasticStrategy;

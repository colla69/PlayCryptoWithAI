import { calculateRSI } from '../utils/indicators.js';

/**
 * StochRSI — Stochastic applied to RSI values.
 *
 * Why this is better for short timeframes (1h / 15m):
 *   • RSI alone on 15m is noisy: price oscillates quickly between 40–60,
 *     producing few extreme readings to act on.
 *   • Applying the Stochastic formula to the RSI series re-normalises its
 *     range at each window, so even moderate RSI swings produce clear 0–100
 *     extremes.  This generates more signals without sacrificing quality.
 *   • The %K/%D crossover in extreme zones provides the same reversal-
 *     confirmation logic we use in the plain Stochastic, but responds 2–3x
 *     faster.
 *
 * Algorithm:
 *   1. Compute RSI(rsiPeriod).
 *   2. Over a rolling window of stochPeriod RSI values, compute:
 *        stochK = (RSI − min) / (max − min) × 100
 *      Flat range (max == min) → stochK = 50.
 *   3. stochD = SMA(stochK, signalPeriod).
 *   4. Signal when stochK crosses stochD inside the oversold / overbought zones.
 */

export class StochRSIStrategy {
  constructor(config = {}) {
    this.config = {
      rsiPeriod:    14,
      stochPeriod:  14,
      signalPeriod:  3,
      oversold:     20,
      overbought:   80,
      ...config,
    };
  }

  analyze(candles) {
    const { rsiPeriod, stochPeriod, signalPeriod, oversold, overbought } = this.config;
    const closed = candles.slice(0, -1); // exclude forming candle
    const closes = closed.map((c) => c.close);

    const required = rsiPeriod + stochPeriod + signalPeriod + 2;
    if (closes.length < required) {
      return {
        name: 'StochRSI', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for StochRSI (need ${required}, have ${closes.length})`,
      };
    }

    // Step 1 — RSI
    const rsiValues = calculateRSI(closes, rsiPeriod);
    if (rsiValues.length < stochPeriod + signalPeriod) {
      return { name: 'StochRSI', signal: 'HOLD', confidence: 0, reason: 'StochRSI: insufficient RSI data' };
    }

    // Step 2 — Stochastic %K over RSI
    const kValues = [];
    for (let i = stochPeriod - 1; i < rsiValues.length; i++) {
      const window = rsiValues.slice(i - stochPeriod + 1, i + 1);
      const lo = Math.min(...window);
      const hi = Math.max(...window);
      kValues.push(hi === lo ? 50 : ((rsiValues[i] - lo) / (hi - lo)) * 100);
    }

    // Step 3 — %D = SMA(K, signalPeriod)
    if (kValues.length < signalPeriod + 1) {
      return { name: 'StochRSI', signal: 'HOLD', confidence: 0, reason: 'StochRSI: insufficient K values' };
    }
    const dValues = [];
    for (let i = signalPeriod - 1; i < kValues.length; i++) {
      const w = kValues.slice(i - signalPeriod + 1, i + 1);
      dValues.push(w.reduce((s, v) => s + v, 0) / signalPeriod);
    }
    if (dValues.length < 2) {
      return { name: 'StochRSI', signal: 'HOLD', confidence: 0, reason: 'StochRSI: insufficient D values' };
    }

    const kLast = kValues.at(-1);
    const dLast = dValues.at(-1);
    const kPrev = kValues.at(-2);
    const dPrev = dValues.at(-2);

    // BUY: %K crosses above %D while both are in oversold territory
    const crossedUpOversold   = kPrev <= dPrev && kLast > dLast && kLast < oversold + 15;
    // SELL: %K crosses below %D while both are in overbought territory
    const crossedDownOverbought = kPrev >= dPrev && kLast < dLast && kLast > overbought - 15;

    if (crossedUpOversold) {
      const depth = Math.max(oversold - kLast, 0);
      const confidence = Number(Math.min(0.55 + (depth / oversold) * 0.40, 0.95).toFixed(2));
      return {
        name: 'StochRSI', signal: 'BUY', k: kLast, d: dLast, confidence,
        reason: `StochRSI K=${kLast.toFixed(1)} crossed above D=${dLast.toFixed(1)} in oversold ↑`,
      };
    }

    if (crossedDownOverbought) {
      const depth = Math.max(kLast - overbought, 0);
      const confidence = Number(Math.min(0.55 + (depth / (100 - overbought)) * 0.40, 0.95).toFixed(2));
      return {
        name: 'StochRSI', signal: 'SELL', k: kLast, d: dLast, confidence,
        reason: `StochRSI K=${kLast.toFixed(1)} crossed below D=${dLast.toFixed(1)} in overbought ↓`,
      };
    }

    return {
      name: 'StochRSI', signal: 'HOLD', k: kLast, d: dLast, confidence: 0.2,
      reason: `StochRSI K=${kLast.toFixed(1)} D=${dLast.toFixed(1)} — no extreme crossover`,
    };
  }
}

export default StochRSIStrategy;

import { OBV } from 'technicalindicators';
import { calculateEMA } from '../utils/indicators.js';

/**
 * OBV (On-Balance Volume) Strategy
 *
 * Cumulative volume indicator: adds volume on up-candles, subtracts on down-candles.
 * A rising OBV in an uptrend confirms institutional buying; divergence signals reversals.
 *
 * This strategy uses an EMA of the OBV series as a signal line:
 * - BUY  when OBV crosses above its EMA (buyers taking control)
 * - SELL when OBV crosses below its EMA (sellers taking control)
 * - HOLD during continuation (no cross)
 *
 * Cross-only design avoids constant directional bias — the same logic that
 * proved effective for Supertrend on longer timeframes.
 * Confidence scales with the relative gap between OBV and its EMA at the cross.
 */
export class OBVStrategy {
  constructor(config = {}) {
    this.config = { emaPeriod: 20, ...config };
  }

  analyze(candles) {
    const closed   = candles.slice(0, -1); // exclude forming candle
    const required = this.config.emaPeriod + 2;

    if (closed.length < required) {
      return {
        name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for OBV(EMA-${this.config.emaPeriod})`,
      };
    }

    const closes  = closed.map((c) => c.close);
    const volumes = closed.map((c) => c.volume);

    const obvRaw = OBV.calculate({ close: closes, volume: volumes });

    if (obvRaw.length < this.config.emaPeriod + 1) {
      return { name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0, reason: 'OBV: insufficient data' };
    }

    const emaValues = calculateEMA(obvRaw, this.config.emaPeriod);

    if (emaValues.length < 2) {
      return { name: 'OBV', signal: 'HOLD', value: NaN, confidence: 0, reason: 'OBV EMA: insufficient data' };
    }

    const obv     = Number(obvRaw.at(-1));
    const prevObv = Number(obvRaw.at(-2));
    const ema     = Number(emaValues.at(-1));
    const prevEma = Number(emaValues.at(-2));

    const crossedAbove = prevObv <= prevEma && obv > ema;
    const crossedBelow = prevObv >= prevEma && obv < ema;

    // Relative gap: how far OBV has moved past the EMA (capped at 1)
    const relGap = Math.abs(ema) > 0
      ? Math.min(Math.abs(obv - ema) / Math.abs(ema), 1)
      : 0;

    if (crossedAbove) {
      const confidence = Number(Math.min(0.55 + relGap * 0.35, 0.90).toFixed(2));
      return {
        name: 'OBV', signal: 'BUY', value: obv, ema, confidence,
        reason: `OBV crossed above EMA-${this.config.emaPeriod} — volume buyers in control`,
      };
    }

    if (crossedBelow) {
      const confidence = Number(Math.min(0.55 + relGap * 0.35, 0.90).toFixed(2));
      return {
        name: 'OBV', signal: 'SELL', value: obv, ema, confidence,
        reason: `OBV crossed below EMA-${this.config.emaPeriod} — volume sellers in control`,
      };
    }

    const above = obv > ema;
    return {
      name: 'OBV', signal: 'HOLD', value: obv, ema, confidence: 0.2,
      reason: `OBV ${above ? 'above' : 'below'} EMA-${this.config.emaPeriod} — no cross`,
    };
  }
}

export default OBVStrategy;

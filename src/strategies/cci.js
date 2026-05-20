import { calculateCCI } from '../utils/indicators.js';

/**
 * CCI (Commodity Channel Index) Strategy
 *
 * Mean-reversion oscillator:
 * - BUY  when CCI < -100 AND CCI is turning up (reversal confirmed)
 * - SELL when CCI > +100 AND CCI is turning down (reversal confirmed)
 * - HOLD otherwise — avoids entries while momentum is still extreme
 *
 * Direction confirmation prevents buying into a free-fall or selling into
 * a runaway rally. Confidence scales with how far past the threshold CCI is.
 */
export class CCIStrategy {
  constructor(config = {}) {
    this.config = { period: 20, oversold: -100, overbought: 100, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const highs  = closed.map((c) => c.high);
    const lows   = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);

    // Need period + 1 so we can compare two consecutive CCI values for direction
    if (closed.length < this.config.period + 1) {
      return { name: 'CCI', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for CCI-${this.config.period}` };
    }

    const values = calculateCCI(highs, lows, closes, this.config.period);
    if (values.length < 2) {
      return { name: 'CCI', signal: 'HOLD', value: NaN, confidence: 0, reason: 'CCI: insufficient data' };
    }

    const prev   = Number(values.at(-2));
    const latest = Number(values.at(-1));
    const rising  = latest > prev;
    const falling = latest < prev;

    if (latest < this.config.oversold) {
      const extremity  = Math.min(Math.abs(latest - this.config.oversold) / 100, 1);
      const confidence = Number((0.5 + extremity * 0.4 + (rising ? 0.1 : 0)).toFixed(2));
      return {
        name: 'CCI', signal: rising ? 'BUY' : 'HOLD',
        value: latest, confidence,
        reason: `CCI ${latest.toFixed(1)} oversold${rising ? ' ↑ reversal confirmed' : ' — still falling, wait'}`,
      };
    }

    if (latest > this.config.overbought) {
      const extremity  = Math.min(Math.abs(latest - this.config.overbought) / 100, 1);
      const confidence = Number((0.5 + extremity * 0.4 + (falling ? 0.1 : 0)).toFixed(2));
      return {
        name: 'CCI', signal: falling ? 'SELL' : 'HOLD',
        value: latest, confidence,
        reason: `CCI ${latest.toFixed(1)} overbought${falling ? ' ↓ reversal confirmed' : ' — still rising, wait'}`,
      };
    }

    return { name: 'CCI', signal: 'HOLD', value: latest, confidence: 0.2,
      reason: `CCI ${latest.toFixed(1)} neutral` };
  }
}

export default CCIStrategy;

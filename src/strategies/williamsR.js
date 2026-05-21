import { WilliamsR } from 'technicalindicators';

/**
 * Williams %R Strategy
 *
 * Fast momentum oscillator (range: −100 to 0). Similar to Stochastic but uses
 * the highest high rather than a smoothed %K/%D pair — responds quicker to
 * price extremes, making it well-suited to complement Bollinger Bands and RSI
 * in mean-reversion setups.
 *
 * - BUY  when %R < oversold (default −80) AND turning up (reversal confirmed)
 * - SELL when %R > overbought (default −20) AND turning down (reversal confirmed)
 * - HOLD otherwise (including extreme readings still moving in the same direction)
 *
 * The "wait for turning" filter avoids catching a falling knife — the same
 * approach used by the RSI strategy, which proved effective in backtests.
 * Confidence scales with depth of the extreme + direction confirmation.
 */
export class WilliamsRStrategy {
  constructor(config = {}) {
    this.config = { period: 14, oversold: -80, overbought: -20, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const required = this.config.period + 1;

    if (closed.length < required) {
      return {
        name: 'WilliamsR', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for Williams %R-${this.config.period}`,
      };
    }

    const highs  = closed.map((c) => c.high);
    const lows   = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);

    const values = WilliamsR.calculate({ high: highs, low: lows, close: closes, period: this.config.period });

    if (values.length < 2) {
      return { name: 'WilliamsR', signal: 'HOLD', value: NaN, confidence: 0, reason: 'Williams %R: insufficient data' };
    }

    const prev   = Number(values.at(-2));
    const latest = Number(values.at(-1));
    const rising  = latest > prev; // %R is negative — "rising" means less negative (e.g. -90 → -70)
    const falling = latest < prev; // "falling" means more negative (e.g. -20 → -40)

    // Oversold: %R near -100 (very negative)
    if (latest < this.config.oversold) {
      // Turn-up confirmation: %R rising from extreme (moving toward zero = buyers arriving)
      const extremity  = Math.min((this.config.oversold - latest) / Math.abs(this.config.oversold), 1);
      const confidence = Number((0.5 + extremity * 0.4 + (rising ? 0.1 : 0)).toFixed(2));
      return {
        name: 'WilliamsR', signal: rising ? 'BUY' : 'HOLD', value: latest, confidence,
        reason: `%R ${latest.toFixed(1)} oversold${rising ? ' ↑ reversal confirmed' : ' — still falling, wait'}`,
      };
    }

    // Overbought: %R near 0 (less negative)
    if (latest > this.config.overbought) {
      // Turn-down confirmation: %R falling from extreme (moving toward -100 = sellers arriving)
      const extremity  = Math.min((latest - this.config.overbought) / Math.abs(this.config.overbought), 1);
      const confidence = Number((0.5 + extremity * 0.4 + (falling ? 0.1 : 0)).toFixed(2));
      return {
        name: 'WilliamsR', signal: falling ? 'SELL' : 'HOLD', value: latest, confidence,
        reason: `%R ${latest.toFixed(1)} overbought${falling ? ' ↓ reversal confirmed' : ' — still rising, wait'}`,
      };
    }

    return {
      name: 'WilliamsR', signal: 'HOLD', value: latest, confidence: 0.2,
      reason: `%R ${latest.toFixed(1)} neutral`,
    };
  }
}

export default WilliamsRStrategy;

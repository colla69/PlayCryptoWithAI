import { MFI } from 'technicalindicators';

/**
 * MFI (Money Flow Index) Strategy
 *
 * Volume-weighted RSI. Measures buying/selling pressure by combining
 * price direction with volume. More reliable than RSI alone because
 * it catches accumulation/distribution that pure price momentum misses.
 *
 * - BUY  when MFI < oversold (default 20) AND turning up (reversal confirmed)
 * - SELL when MFI > overbought (default 80) AND turning down (reversal confirmed)
 * - HOLD otherwise (including extreme readings still moving in the same direction)
 *
 * Confidence scales with depth of the extreme + direction confirmation,
 * matching the RSI strategy's confidence model for aggregator compatibility.
 */
export class MFIStrategy {
  constructor(config = {}) {
    this.config = { period: 14, oversold: 20, overbought: 80, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const required = this.config.period + 1;

    if (closed.length < required) {
      return {
        name: 'MFI', signal: 'HOLD', value: NaN, confidence: 0,
        reason: `Not enough candles for MFI-${this.config.period}`,
      };
    }

    const highs   = closed.map((c) => c.high);
    const lows    = closed.map((c) => c.low);
    const closes  = closed.map((c) => c.close);
    const volumes = closed.map((c) => c.volume);

    const values = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: this.config.period });

    if (values.length < 2) {
      return { name: 'MFI', signal: 'HOLD', value: NaN, confidence: 0, reason: 'MFI: insufficient data' };
    }

    const prev   = Number(values.at(-2));
    const latest = Number(values.at(-1));
    const rising  = latest > prev;
    const falling = latest < prev;

    if (latest < this.config.oversold) {
      // Only buy when MFI is turning up — volume buyers entering
      const extremity  = Math.min((this.config.oversold - latest) / this.config.oversold, 1);
      const confidence = Number((0.5 + extremity * 0.4 + (rising ? 0.1 : 0)).toFixed(2));
      return {
        name: 'MFI', signal: rising ? 'BUY' : 'HOLD', value: latest, confidence,
        reason: `MFI ${latest.toFixed(1)} oversold${rising ? ' ↑ volume reversal confirmed' : ' — still falling, wait'}`,
      };
    }

    if (latest > this.config.overbought) {
      // Only sell when MFI is turning down — volume sellers dominating
      const extremity  = Math.min((latest - this.config.overbought) / (100 - this.config.overbought), 1);
      const confidence = Number((0.5 + extremity * 0.4 + (falling ? 0.1 : 0)).toFixed(2));
      return {
        name: 'MFI', signal: falling ? 'SELL' : 'HOLD', value: latest, confidence,
        reason: `MFI ${latest.toFixed(1)} overbought${falling ? ' ↓ volume reversal confirmed' : ' — still rising, wait'}`,
      };
    }

    return {
      name: 'MFI', signal: 'HOLD', value: latest, confidence: 0.2,
      reason: `MFI ${latest.toFixed(1)} neutral`,
    };
  }
}

export default MFIStrategy;

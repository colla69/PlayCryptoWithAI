import { PSAR } from 'technicalindicators';

/**
 * Parabolic SAR Strategy
 *
 * Trailing stop-reversal system. The SAR dot sits below price in an uptrend
 * and above price in a downtrend. A flip (dot crosses to the other side of price)
 * signals a potential trend change.
 *
 * Design: flip-only — HOLD during trend continuation. Same rationale as Supertrend:
 * on higher timeframes (12h) continuation signals amplify whipsaws, while fresh
 * flips carry strong mean-reversion or trend-reversal conviction.
 *
 * - BUY  on bullish flip: previous close < prev SAR AND current close > current SAR
 * - SELL on bearish flip: previous close > prev SAR AND current close < current SAR
 * - HOLD during continuation (SAR already on the correct side of price)
 *
 * Confidence scales with how far price has moved from the SAR at the flip point.
 */
export class PSARStrategy {
  constructor(config = {}) {
    this.config = { step: 0.02, max: 0.2, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle

    // PSAR needs at least 3 candles to produce 2 comparable values
    if (closed.length < 3) {
      return {
        name: 'PSAR', signal: 'HOLD', value: NaN, confidence: 0,
        reason: 'Not enough candles for PSAR',
      };
    }

    const highs  = closed.map((c) => c.high);
    const lows   = closed.map((c) => c.low);
    const closes = closed.map((c) => c.close);

    const sar = PSAR.calculate({ high: highs, low: lows, step: this.config.step, max: this.config.max });

    if (!sar || sar.length < 2) {
      return { name: 'PSAR', signal: 'HOLD', value: NaN, confidence: 0, reason: 'PSAR: insufficient data' };
    }

    // Align SAR tail with close tail (PSAR output length may differ from input)
    const offset     = closes.length - sar.length;
    const currClose  = closes[closes.length - 1];
    const prevClose  = closes[closes.length - 2];
    const currSAR    = Number(sar.at(-1));
    const prevSAR    = Number(sar.at(-2));

    if (!Number.isFinite(currSAR) || !Number.isFinite(prevSAR)) {
      return { name: 'PSAR', signal: 'HOLD', value: NaN, confidence: 0, reason: 'PSAR: NaN value' };
    }

    // Determine previous and current trend direction
    const wasBullish = prevClose > prevSAR;
    const isBullish  = currClose > currSAR;

    const justFlippedUp   = !wasBullish && isBullish;
    const justFlippedDown = wasBullish  && !isBullish;

    // Distance from SAR as a confidence boost (capped)
    const distBoost = Math.min((Math.abs(currClose - currSAR) / currClose) * 8, 0.15);

    if (justFlippedUp) {
      const confidence = Number(Math.min(0.70 + distBoost, 0.90).toFixed(2));
      return {
        name: 'PSAR', signal: 'BUY', value: currSAR, confidence,
        reason: `PSAR flipped bullish ↑ — SAR ${currSAR.toFixed(4)} now below price ${currClose.toFixed(4)}`,
      };
    }

    if (justFlippedDown) {
      const confidence = Number(Math.min(0.70 + distBoost, 0.90).toFixed(2));
      return {
        name: 'PSAR', signal: 'SELL', value: currSAR, confidence,
        reason: `PSAR flipped bearish ↓ — SAR ${currSAR.toFixed(4)} now above price ${currClose.toFixed(4)}`,
      };
    }

    return {
      name: 'PSAR', signal: 'HOLD', value: currSAR, confidence: 0.1,
      reason: `PSAR ${isBullish ? 'uptrend' : 'downtrend'} continues (SAR ${currSAR.toFixed(4)})`,
    };
  }
}

export default PSARStrategy;

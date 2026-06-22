/**
 * Pin-Bar / Wick Rejection Strategy
 *
 * Pure single-candle price-action signal.  Looks for a strong wick
 * (≥ 2× the body) in one direction with the close in the opposite end of
 * the range — the classic rejection pattern where the market probed in one
 * direction and was forcefully pushed back.
 *
 * Standalone counterpart to the pin-bar logic embedded inside
 * SupportResistanceStrategy (which only fires when price is near an S/R
 * zone).  This voter fires anywhere the pattern prints, adding a pure
 * "price-action only" basis that is orthogonal to MAs, oscillators, and
 * volume indicators.  SupportResistanceStrategy is left intact so existing
 * per-symbol configs continue to behave identically.
 *
 * BUY  — bullish pin: lower wick > wickToBodyMin × body AND close in the
 *        upper (1 − closeBandFrac) of the candle range
 * SELL — bearish pin: upper wick > wickToBodyMin × body AND close in the
 *        lower closeBandFrac of the candle range
 * HOLD — no qualifying rejection, or both-sided spinning top
 *
 * Confidence: base 0.55, +0.05 per extra body-unit of wick beyond the
 * threshold, capped at 0.85.
 *
 * Dojis (body ≈ 0) are handled by clamping the effective body to a tiny
 * fraction of the range so the ratio doesn't explode to Infinity — a doji
 * with a single long wick still scores like a strong pin.
 */

export class PinBarStrategy {
  constructor(config = {}) {
    this.config = {
      wickToBodyMin: 2.0, // wick must be ≥ this × body
      closeBandFrac: 0.4, // close must be in upper/lower (1 − closeBandFrac) of range
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    if (closed.length < 2) {
      return {
        name: 'PinBar', signal: 'HOLD', confidence: 0,
        reason: 'Not enough candles for PinBar',
      };
    }

    const last  = closed.at(-1);
    const { wickToBodyMin, closeBandFrac } = this.config;

    const body  = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    if (range <= 0) {
      return {
        name: 'PinBar', signal: 'HOLD', confidence: 0,
        reason: 'PinBar: zero-range candle',
      };
    }

    // Guard ÷0 on dojis: floor the body at 0.1% of the range so the ratio
    // stays finite while still rewarding long single-sided wicks.
    const effBody    = Math.max(body, range * 0.001);
    const lowerWick  = Math.min(last.open, last.close) - last.low;
    const upperWick  = last.high - Math.max(last.open, last.close);
    const lowerRatio = lowerWick / effBody;
    const upperRatio = upperWick / effBody;

    // Where in the range did the candle close? 0 = at low, 1 = at high.
    const closeFrac = (last.close - last.low) / range;

    const bullishPin = lowerRatio >= wickToBodyMin && closeFrac >= (1 - closeBandFrac);
    const bearishPin = upperRatio >= wickToBodyMin && closeFrac <= closeBandFrac;

    // Spinning top — long wick both sides, direction ambiguous.
    if (bullishPin && bearishPin) {
      return {
        name: 'PinBar', signal: 'HOLD', confidence: 0.15,
        reason: `PinBar ambiguous — long wicks both sides (L=${lowerRatio.toFixed(1)}×, U=${upperRatio.toFixed(1)}×)`,
      };
    }

    if (bullishPin) {
      const extra      = Math.max(0, lowerRatio - wickToBodyMin);
      const confidence = Number(Math.min(0.85, 0.55 + extra * 0.05).toFixed(4));
      return {
        name: 'PinBar', signal: 'BUY', confidence,
        reason: `Bullish pin — lower wick ${lowerRatio.toFixed(1)}× body, close in upper ${(closeFrac * 100).toFixed(0)}% of range`,
      };
    }

    if (bearishPin) {
      const extra      = Math.max(0, upperRatio - wickToBodyMin);
      const confidence = Number(Math.min(0.85, 0.55 + extra * 0.05).toFixed(4));
      return {
        name: 'PinBar', signal: 'SELL', confidence,
        reason: `Bearish pin — upper wick ${upperRatio.toFixed(1)}× body, close in lower ${((1 - closeFrac) * 100).toFixed(0)}% of range`,
      };
    }

    return {
      name: 'PinBar', signal: 'HOLD', confidence: 0.1,
      reason: `No pin-bar rejection (L=${lowerRatio.toFixed(1)}×, U=${upperRatio.toFixed(1)}×)`,
    };
  }
}

export default PinBarStrategy;

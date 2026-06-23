/**
 * VWAP-σ Mean Reversion Strategy
 *
 * Rolling volume-weighted average price (VWAP) over an N-bar window with
 * volume-weighted standard deviation bands at ±k·σ.  Mean-reverts when
 * price stretches past the band.
 *
 * Why this is orthogonal to Bollinger Bands:
 *   • BB uses a simple moving average of close.  Every bar weighs equally
 *     regardless of participation.
 *   • VWAP-σ weighs each bar's typical price by its volume.  Heavy-volume
 *     bars exert proportionally more pull on the centerline, so the
 *     reference price reflects where real money traded — not where casual
 *     wicks printed.
 *   • σ uses the same volume-weighted statistic, keeping the basis
 *     consistent (no mixing SMA stdev with a VWAP center).
 *
 * BUY  — price ≤ VWAP − k·σ
 * SELL — price ≥ VWAP + k·σ
 * HOLD — inside the band
 *
 * Confidence ladder (by absolute z-score):
 *   |z| = 1 → 0.50
 *   |z| = 2 → 0.70
 *   |z| = 3 → 0.90 (cap)
 */

export class VWAPSigmaStrategy {
  constructor(config = {}) {
    this.config = {
      period:     20, // rolling window length
      stdDevMult: 2,  // band width in σ
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const { period, stdDevMult } = this.config;

    if (closed.length < period + 1) {
      return {
        name: 'VWAPSigma', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for VWAP-σ(${period})`,
      };
    }

    const window = closed.slice(-period);
    const price  = closed.at(-1).close;

    // Volume-weighted typical price
    let volSum = 0;
    let pvSum  = 0;
    for (const c of window) {
      const typical = (c.high + c.low + c.close) / 3;
      volSum += c.volume;
      pvSum  += typical * c.volume;
    }
    if (volSum <= 0) {
      return {
        name: 'VWAPSigma', signal: 'HOLD', confidence: 0,
        reason: 'VWAP-σ: zero-volume window',
      };
    }
    const vwap = pvSum / volSum;

    // Volume-weighted variance (same basis as the centerline)
    let varNum = 0;
    for (const c of window) {
      const typical = (c.high + c.low + c.close) / 3;
      varNum += c.volume * (typical - vwap) ** 2;
    }
    const sigma = Math.sqrt(Math.max(varNum / volSum, 0));
    if (sigma <= 0) {
      return {
        name: 'VWAPSigma', signal: 'HOLD', confidence: 0.1,
        reason: 'VWAP-σ: degenerate band (σ=0)',
      };
    }

    const upper  = vwap + stdDevMult * sigma;
    const lower  = vwap - stdDevMult * sigma;
    const zScore = (price - vwap) / sigma;

    // Confidence from |z|: 0..1 → 0.5, 1..2 → 0.5–0.7, 2..3 → 0.7–0.9, ≥3 → 0.9
    const confFromZ = (absZ) => {
      if (absZ <= 1) return 0.5;
      if (absZ <= 2) return 0.5 + (absZ - 1) * 0.20;
      if (absZ <= 3) return 0.7 + (absZ - 2) * 0.20;
      return 0.9;
    };

    if (price <= lower) {
      const confidence = Number(confFromZ(Math.abs(zScore)).toFixed(4));
      return {
        name: 'VWAPSigma', signal: 'BUY', confidence,
        reason: `Price ${price.toFixed(4)} ≤ VWAP-${stdDevMult}σ ${lower.toFixed(4)} (z=${zScore.toFixed(2)})`,
      };
    }

    if (price >= upper) {
      const confidence = Number(confFromZ(Math.abs(zScore)).toFixed(4));
      return {
        name: 'VWAPSigma', signal: 'SELL', confidence,
        reason: `Price ${price.toFixed(4)} ≥ VWAP+${stdDevMult}σ ${upper.toFixed(4)} (z=${zScore.toFixed(2)})`,
      };
    }

    return {
      name: 'VWAPSigma', signal: 'HOLD', confidence: 0.15,
      reason: `Price ${price.toFixed(4)} inside VWAP±${stdDevMult}σ (z=${zScore.toFixed(2)})`,
    };
  }
}

export default VWAPSigmaStrategy;

/**
 * Volume Surge Strategy
 *
 * Standalone vote that requires *real participation*:  the current-bar
 * volume must materially exceed the recent average AND the candle
 * direction (green vs red) must confirm what the surge is doing.
 *
 * Why this is orthogonal to the existing pool:
 *   • Every other strategy votes on *price* shape — RSI, BB, EMA, MACD,
 *     S&R, etc.  They will all flip on a 1% wick on zero volume.
 *   • This strategy votes on *volume* magnitude with a direction
 *     confirmation.  It abstains (HOLD) on quiet bars regardless of price
 *     action, providing a participation filter the aggregator can blend in.
 *
 * BUY  — current vol ≥ mult × mean(last N) AND close > open
 * SELL — current vol ≥ mult × mean(last N) AND close < open
 * HOLD — no surge, or surge on a doji (close ≈ open)
 *
 * Confidence scales with surge magnitude:
 *   ratio = 2.0  → 0.50  (entry to surge zone)
 *   ratio = 4.0  → 0.90  (cap)
 *
 * The baseline excludes the current bar so it cannot inflate its own
 * comparison threshold.
 */

export class VolumeSurgeStrategy {
  constructor(config = {}) {
    this.config = {
      period:     20,   // mean-volume lookback (excluding current bar)
      multiplier: 2.0,  // current/mean ratio that qualifies as a surge
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const { period, multiplier } = this.config;

    if (closed.length < period + 1) {
      return {
        name: 'VolumeSurge', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for VolSurge(${period})`,
      };
    }

    // Baseline = N bars BEFORE the current one (don't include current in
    // its own threshold).
    const baseline = closed.slice(-period - 1, -1);
    const meanVol  = baseline.reduce((s, c) => s + c.volume, 0) / baseline.length;
    const current  = closed.at(-1);

    if (meanVol <= 0) {
      return {
        name: 'VolumeSurge', signal: 'HOLD', confidence: 0,
        reason: 'VolSurge: zero-volume baseline',
      };
    }

    const ratio = current.volume / meanVol;
    const surge = ratio >= multiplier;

    if (!surge) {
      return {
        name: 'VolumeSurge', signal: 'HOLD', confidence: 0.1,
        reason: `No surge — vol ${ratio.toFixed(2)}× < ${multiplier}×`,
      };
    }

    // (ratio − 1) / 3 maps ratio=2 → 0.33, ratio=4 → 1.0; clamp to [0.5, 0.9]
    const confidence = Number(
      Math.max(0.5, Math.min(0.9, (ratio - 1) / 3)).toFixed(4),
    );

    if (current.close > current.open) {
      return {
        name: 'VolumeSurge', signal: 'BUY', confidence,
        reason: `Volume surge ${ratio.toFixed(2)}× on green candle`,
      };
    }
    if (current.close < current.open) {
      return {
        name: 'VolumeSurge', signal: 'SELL', confidence,
        reason: `Volume surge ${ratio.toFixed(2)}× on red candle`,
      };
    }
    return {
      name: 'VolumeSurge', signal: 'HOLD', confidence: 0.2,
      reason: `Volume surge ${ratio.toFixed(2)}× on doji (no direction)`,
    };
  }
}

export default VolumeSurgeStrategy;

/**
 * Donchian Breakout Strategy
 *
 * Trend-following structural breakout: fires when the latest close pushes
 * past the highest high (or below the lowest low) of the previous N closed
 * bars.  Volume confirmation gates the signal to filter out thin, hollow
 * breakouts that tend to fade.
 *
 * Why this is orthogonal to the existing pool:
 *   • Oscillators (RSI, Stoch, CCI) mean-revert — they fade extremes.
 *     Donchian goes the other way, riding the extreme.
 *   • Moving averages (EMA, MACD) lag — they wait for the cross.
 *     Donchian fires on the bar that breaks structure.
 *   • Trend filters (ADX, Supertrend) tell you a trend exists, not where
 *     it started. Donchian marks the structural breakout that initiated it.
 *
 * BUY  — current close > max(high) over the N closed bars before current
 *        AND current-bar volume ≥ multiplier × mean of last 20 volumes
 * SELL — symmetrical breakdown at the lower band
 * HOLD — inside the channel, or breakout without volume confirmation
 *
 * The channel is built from the N bars **before** the current closed bar
 * (closed.slice(-N-1, -1)) so the bar being tested for breakout never
 * contributes to the band it is meant to break — avoids self-reference.
 *
 * Confidence:
 *   base 0.55 + min(1, breakout_distance / channel_width) × 0.35
 *        + 0.10 bonus when volume ratio ≥ 2.0×
 *        capped at 0.90.
 */

export class DonchianStrategy {
  constructor(config = {}) {
    this.config = {
      period:         20,   // N-bar lookback for the channel
      volumeMultiple: 1.2,  // current vol must be ≥ this × mean to confirm
      volumePeriod:   20,   // window for the mean-volume baseline
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const { period, volumeMultiple, volumePeriod } = this.config;
    const needed = Math.max(period, volumePeriod) + 1;

    if (closed.length < needed) {
      return {
        name: 'Donchian', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for Donchian(${period}) — need ${needed}`,
      };
    }

    // Channel = N bars BEFORE the current closed bar (no self-reference)
    const channelBars = closed.slice(-period - 1, -1);
    const current     = closed.at(-1);

    let upper = -Infinity;
    let lower =  Infinity;
    for (const c of channelBars) {
      if (c.high > upper) upper = c.high;
      if (c.low  < lower) lower = c.low;
    }
    const width = Math.max(upper - lower, 1e-10);

    // Volume confirmation
    const recentVols = closed.slice(-volumePeriod).map((c) => c.volume);
    const meanVol    = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    const volRatio   = meanVol > 0 ? current.volume / meanVol : 0;
    const volumeOk   = volRatio >= volumeMultiple;
    const strongVol  = volRatio >= 2.0;

    const price = current.close;

    if (price > upper) {
      if (!volumeOk) {
        return {
          name: 'Donchian', signal: 'HOLD', confidence: 0.25,
          reason: `Upper break ${price.toFixed(4)} > ${upper.toFixed(4)} but vol ${volRatio.toFixed(2)}× < ${volumeMultiple}×`,
        };
      }
      const magnitude  = Math.min((price - upper) / width, 1);
      let   confidence = 0.55 + magnitude * 0.35 + (strongVol ? 0.10 : 0);
      confidence       = Number(Math.min(0.90, Math.max(0, confidence)).toFixed(4));
      return {
        name: 'Donchian', signal: 'BUY', confidence,
        reason: `Donchian↑ break ${price.toFixed(4)} > ${period}-bar high ${upper.toFixed(4)} (vol ${volRatio.toFixed(2)}×)`,
      };
    }

    if (price < lower) {
      if (!volumeOk) {
        return {
          name: 'Donchian', signal: 'HOLD', confidence: 0.25,
          reason: `Lower break ${price.toFixed(4)} < ${lower.toFixed(4)} but vol ${volRatio.toFixed(2)}× < ${volumeMultiple}×`,
        };
      }
      const magnitude  = Math.min((lower - price) / width, 1);
      let   confidence = 0.55 + magnitude * 0.35 + (strongVol ? 0.10 : 0);
      confidence       = Number(Math.min(0.90, Math.max(0, confidence)).toFixed(4));
      return {
        name: 'Donchian', signal: 'SELL', confidence,
        reason: `Donchian↓ break ${price.toFixed(4)} < ${period}-bar low ${lower.toFixed(4)} (vol ${volRatio.toFixed(2)}×)`,
      };
    }

    return {
      name: 'Donchian', signal: 'HOLD', confidence: 0.1,
      reason: `Inside Donchian(${period}) channel [${lower.toFixed(4)}–${upper.toFixed(4)}]`,
    };
  }
}

export default DonchianStrategy;

/**
 * Heikin-Ashi Trend Strategy
 *
 * Why this works on short timeframes (1h / 15m):
 *   • Raw 15m candles are extremely noisy — wicks dominate, bodies are small,
 *     and every random price tick shows up as a new candle.
 *   • Heikin-Ashi smooths the OHLC data by averaging across two consecutive
 *     candles.  The result is a synthetic "trend candle" that filters out most
 *     of the wick noise and makes the underlying trend direction much clearer.
 *   • Unlike EMA crossovers (which lag) or RSI (which oscillates), HA candles
 *     show trend direction at every bar without needing a lookback period — the
 *     smoothing is baked into the candle construction itself.
 *
 * Heikin-Ashi formulas:
 *   HA_close = (open + high + low + close) / 4
 *   HA_open  = (prev_HA_open + prev_HA_close) / 2
 *   HA_high  = max(high, HA_open, HA_close)
 *   HA_low   = min(low,  HA_open, HA_close)
 *
 * Signal logic:
 *   BUY  — latest HA candle is bullish AND previous HA candle was bearish
 *           (first green candle after a bearish sequence = trend flip)
 *   SELL — latest HA candle is bearish AND previous HA candle was bullish
 *
 * Confidence boosters:
 *   • Strong bull: no lower shadow on the HA candle (HA_low == HA_open)
 *     → price never retraced to the open: fully committed buyers
 *   • Strong bear: no upper shadow (HA_high == HA_close)
 *   • Body size relative to the candle range: large body = strong conviction
 */

export class HeikinAshiStrategy {
  constructor(config = {}) {
    this.config = {
      warmup:    10, // HA candles to compute before trusting the series
      minStreak:  3, // consecutive HA candles in one direction before signalling a flip
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const needed = this.config.warmup + this.config.minStreak + 2;
    if (closed.length < needed) {
      return {
        name: 'HeikinAshi', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for HA (need ${needed})`,
      };
    }

    const ha = this.#computeHA(closed);
    const curr = ha.at(-1);
    const prev = ha.at(-2);

    const currBull = curr.close > curr.open;
    const prevBull = prev.close > prev.open;

    // Only signal on a genuine flip — not just any single candle reversal
    if (currBull === prevBull) {
      return {
        name: 'HeikinAshi', signal: 'HOLD', confidence: 0.15,
        reason: `HA ${currBull ? 'bullish' : 'bearish'} continuation`,
      };
    }

    // Count how many consecutive candles were in the prior direction
    const priorDirection = prevBull;
    let streak = 0;
    for (let i = ha.length - 2; i >= 0; i--) {
      if ((ha[i].close > ha[i].open) === priorDirection) streak++;
      else break;
    }

    // Require a minimum streak in the prior direction before trusting the flip
    if (streak < this.config.minStreak) {
      return {
        name: 'HeikinAshi', signal: 'HOLD', confidence: 0.2,
        reason: `HA flipped but prior streak too short (${streak} < ${this.config.minStreak})`,
      };
    }

    // Flip from bear to bull
    if (!prevBull && currBull) {
      const noLowerShadow = curr.low >= curr.open - curr.open * 0.0005;
      const body = curr.close - curr.open;
      const range = curr.high - curr.low || 1;
      const bodyRatio = body / range;
      const streakBoost = Math.min((streak - this.config.minStreak) * 0.02, 0.10);
      const confidence = Number(Math.min(
        0.60 + bodyRatio * 0.15 + (noLowerShadow ? 0.10 : 0) + streakBoost,
        0.90,
      ).toFixed(2));
      return {
        name: 'HeikinAshi', signal: 'BUY', confidence,
        reason: `HA flipped bullish ↑ after ${streak}-bar bear streak${noLowerShadow ? ' (no lower shadow)' : ''}`,
      };
    }

    // Flip from bull to bear
    const noUpperShadow = curr.high <= curr.open + curr.open * 0.0005;
    const body = curr.open - curr.close;
    const range = curr.high - curr.low || 1;
    const bodyRatio = body / range;
    const streakBoost = Math.min((streak - this.config.minStreak) * 0.02, 0.10);
    const confidence = Number(Math.min(
      0.60 + bodyRatio * 0.15 + (noUpperShadow ? 0.10 : 0) + streakBoost,
      0.90,
    ).toFixed(2));
    return {
      name: 'HeikinAshi', signal: 'SELL', confidence,
      reason: `HA flipped bearish ↓ after ${streak}-bar bull streak${noUpperShadow ? ' (no upper shadow)' : ''}`,
    };
  }

  /**
   * Convert a OHLCV candle array to Heikin-Ashi candles.
   * @param {object[]} candles - closed candles (newest last)
   * @returns {{ open, high, low, close }[]}
   */
  #computeHA(candles) {
    const ha = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const haClose = (c.open + c.high + c.low + c.close) / 4;
      const haOpen = i === 0
        ? (c.open + c.close) / 2
        : (ha[i - 1].open + ha[i - 1].close) / 2;
      ha.push({
        open:  haOpen,
        high:  Math.max(c.high,  haOpen, haClose),
        low:   Math.min(c.low,   haOpen, haClose),
        close: haClose,
      });
    }
    return ha;
  }
}

export default HeikinAshiStrategy;

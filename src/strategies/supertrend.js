/**
 * Supertrend strategy — matches TradingView's Pine Script implementation.
 *
 * Algorithm:
 *   1. Compute ATR using Wilder's smoothing (RMA, alpha = 1/period)
 *   2. Upper/lower bands = midpoint (hl2) ± multiplier × ATR
 *   3. Bands are locked once price moves away (never "open up" again mid-trend)
 *   4. Trend flips when price closes on the opposite side of the active band
 *
 * Confidence:
 *   - Fresh flip (trend change this candle): 0.75 + distance bonus
 *   - Continuation (already in trend):       0.50 + distance bonus
 *   Both capped at 0.90 to avoid overriding other strategies too aggressively.
 */

export class SupertrendStrategy {
  constructor(config) {
    this.config = config;
  }

  analyze(candles) {
    const { period = 10, multiplier = 3.0 } = this.config;
    const closed = candles.slice(0, -1); // exclude forming candle

    if (closed.length < period + 2) {
      return {
        name: 'Supertrend',
        signal: 'HOLD',
        value: NaN,
        confidence: 0,
        reason: `Not enough candles for Supertrend-${period}`,
      };
    }

    const st = computeSupertrend(closed, period, multiplier);
    if (!st || st.length < 2) {
      return { name: 'Supertrend', signal: 'HOLD', value: NaN, confidence: 0, reason: 'Supertrend: insufficient data' };
    }

    const prev = st.at(-2);
    const curr = st.at(-1);
    const close = closed.at(-1).close;
    const stLine = curr.value;

    const justFlippedUp   = prev.trend === -1 && curr.trend === 1;
    const justFlippedDown = prev.trend ===  1 && curr.trend === -1;

    // Distance of price from the Supertrend line as a small confidence boost
    const distBoost = Math.min((Math.abs(close - stLine) / close) * 8, 0.15);

    if (justFlippedUp) {
      const confidence = Number(Math.min(0.75 + distBoost, 0.90).toFixed(2));
      return {
        name: 'Supertrend',
        signal: 'BUY',
        value: stLine,
        confidence,
        reason: `Supertrend flipped bullish ↑ (ST ${stLine.toFixed(4)})`,
      };
    }

    if (justFlippedDown) {
      const confidence = Number(Math.min(0.75 + distBoost, 0.90).toFixed(2));
      return {
        name: 'Supertrend',
        signal: 'SELL',
        value: stLine,
        confidence,
        reason: `Supertrend flipped bearish ↓ (ST ${stLine.toFixed(4)})`,
      };
    }

    // Continuation — signal the current trend direction at lower confidence
    if (curr.trend === 1) {
      const confidence = Number(Math.min(0.50 + distBoost, 0.65).toFixed(2));
      return {
        name: 'Supertrend',
        signal: 'BUY',
        value: stLine,
        confidence,
        reason: `Supertrend uptrend (ST ${stLine.toFixed(4)})`,
      };
    }

    const confidence = Number(Math.min(0.50 + distBoost, 0.65).toFixed(2));
    return {
      name: 'Supertrend',
      signal: 'SELL',
      value: stLine,
      confidence,
      reason: `Supertrend downtrend (ST ${stLine.toFixed(4)})`,
    };
  }
}

/**
 * Compute the Supertrend series from an array of closed OHLCV candles.
 * Returns one entry per candle starting from index `period`.
 *
 * @param {object[]} candles
 * @param {number}   period      ATR lookback (Wilder's RMA)
 * @param {number}   multiplier  Band width multiplier
 * @returns {{ value: number, trend: 1 | -1, upper: number, lower: number }[]}
 */
function computeSupertrend(candles, period, multiplier) {
  if (candles.length < period + 1) return null;

  // ── 1. True Range ─────────────────────────────────────────────────────────
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const { high, low } = candles[i];
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  // ── 2. ATR via Wilder's RMA (matches TradingView `ta.atr`) ───────────────
  // Seed with SMA of first `period` TR values, then apply RMA
  const atr = [];
  const seed = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  atr.push(seed);
  for (let i = period; i < tr.length; i++) {
    atr.push((atr.at(-1) * (period - 1) + tr[i]) / period);
  }
  // atr[i] corresponds to candles[i + period]

  // ── 3. Supertrend ─────────────────────────────────────────────────────────
  const result = [];

  for (let i = 0; i < atr.length; i++) {
    const ci = i + period; // index into `candles`
    const { high, low, close } = candles[ci];
    const hl2 = (high + low) / 2;

    const rawUpper = hl2 + multiplier * atr[i];
    const rawLower = hl2 - multiplier * atr[i];

    if (i === 0) {
      const trend = close > rawLower ? 1 : -1;
      result.push({ upper: rawUpper, lower: rawLower, trend, value: trend === 1 ? rawLower : rawUpper });
      continue;
    }

    const prev = result.at(-1);
    const prevClose = candles[ci - 1].close;

    // Bands only tighten, never widen, mid-trend (Pine Script band-lock logic)
    const finalUpper = (rawUpper < prev.upper || prevClose > prev.upper) ? rawUpper : prev.upper;
    const finalLower = (rawLower > prev.lower || prevClose < prev.lower) ? rawLower : prev.lower;

    // Trend flips when price closes beyond the active band
    let trend;
    if (prev.trend === 1) {
      trend = close >= finalLower ? 1 : -1;
    } else {
      trend = close <= finalUpper ? -1 : 1;
    }

    result.push({ upper: finalUpper, lower: finalLower, trend, value: trend === 1 ? finalLower : finalUpper });
  }

  return result;
}

export default SupertrendStrategy;

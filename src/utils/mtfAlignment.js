/**
 * Multi-Timeframe Alignment Utilities
 *
 * Builds a compact lookup that maps each 12h candle index to the last 15m candle
 * index that falls within that 12h period, enabling O(1) MTF checks in the
 * simulation loop without any lookahead.
 *
 * Alignment metric: fraction of the last N 15m candles that closed higher than
 * they opened (green candles). Simple, readable, and resistant to overfitting —
 * no fitted thresholds inside this module.
 */

const MS_12H = 12 * 60 * 60 * 1000;
const MS_4H  = 4 * 60 * 60 * 1000;

/**
 * Build a lookup array: for each primary-timeframe candle at index i, the value
 * is the index of the last 4h candle whose timestamp falls within that period.
 * Returns -1 for candles with no 4h coverage.
 */
export function buildMtf4hIndex(candlesPrimary, candles4h, msPrimary = MS_12H) {
  const result = new Int32Array(candlesPrimary.length).fill(-1);
  let j = 0;
  for (let i = 0; i < candlesPrimary.length; i++) {
    const tStart = Number(candlesPrimary[i].timestamp);
    const tEnd = tStart + msPrimary;
    while (j < candles4h.length && Number(candles4h[j].timestamp) < tEnd) j++;
    const lastInPeriod = j - 1;
    if (lastInPeriod >= 0 && Number(candles4h[lastInPeriod].timestamp) >= tStart) {
      result[i] = lastInPeriod;
    }
  }
  return result;
}

/**
 * 4h momentum alignment score using EMA crossover + RSI direction.
 * Returns [0, 1]: >0.5 = bullish momentum, <0.5 = bearish, 0.5 = neutral.
 *
 * Logic:
 *  - EMA(8) vs EMA(21) on 4h closes → bullish if fast > slow
 *  - RSI(14) direction: bullish if RSI > 50
 *  - Combined: 60% EMA weight + 40% RSI weight (EMA is more reliable for momentum)
 *
 * @param {Array<{close: number}>} candles4h
 * @param {number} lastIdx — last 4h candle index to use
 * @param {number} lookback — how many 4h candles to examine (default 21)
 * @returns {number} 0–1
 */
export function mtf4hMomentumScore(candles4h, lastIdx, lookback = 21) {
  if (lastIdx < 0 || lastIdx < lookback) return 0.5;
  const firstIdx = lastIdx - lookback + 1;
  const closes = [];
  for (let k = firstIdx; k <= lastIdx; k++) closes.push(Number(candles4h[k].close));
  if (closes.length < lookback) return 0.5;

  // EMA calculation
  const ema = (data, period) => {
    const k = 2 / (period + 1);
    let val = data[0];
    for (let i = 1; i < data.length; i++) val = data[i] * k + val * (1 - k);
    return val;
  };

  const emaFast = ema(closes, 8);
  const emaSlow = ema(closes, 21);
  // Normalized distance: positive = bullish, capped ±1
  const emaSpread = Math.max(-1, Math.min(1, (emaFast - emaSlow) / emaSlow * 20));
  const emaScore = 0.5 + emaSpread * 0.5; // map [-1,1] → [0,1]

  // RSI(14) on the window
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / (closes.length - 1);
  const avgLoss = losses / (closes.length - 1);
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  const rsi = 100 - 100 / (1 + rs);
  const rsiScore = rsi / 100; // 0–1

  // Weighted combination
  return emaScore * 0.6 + rsiScore * 0.4;
}

/**
 * Build a lookup array: for each 12h candle at index i, the value is the index
 * of the last 15m candle whose timestamp falls within [T12h, T12h + 12h).
 * Returns -1 for 12h candles that have no 15m coverage.
 *
 * @param {Array<{timestamp: number}>} candles12h
 * @param {Array<{timestamp: number}>} candles15m
 * @returns {Int32Array}
 */
export function buildMtfIndex(candles12h, candles15m) {
  const result = new Int32Array(candles12h.length).fill(-1);
  let j = 0;

  for (let i = 0; i < candles12h.length; i++) {
    const tStart = Number(candles12h[i].timestamp);
    const tEnd = tStart + MS_12H;

    // Advance j until we overshoot the end of this 12h period
    while (j < candles15m.length && Number(candles15m[j].timestamp) < tEnd) {
      j++;
    }

    // j is now the first 15m candle AFTER this 12h period ends.
    // j-1 is the last candle within the period (if it exists and is >= tStart).
    const lastInPeriod = j - 1;
    if (
      lastInPeriod >= 0 &&
      Number(candles15m[lastInPeriod].timestamp) >= tStart
    ) {
      result[i] = lastInPeriod;
    }
    // Don't reset j — 15m array is monotonically advancing
  }

  return result;
}

/**
 * Compute a [0, 1] bullish alignment score from the last `bars` 15m candles
 * ending at `lastIdx` (inclusive).
 *
 * Uses recency-weighted scoring: recent candles count more than older ones.
 * A linearly increasing weight (oldest=1, newest=N) emphasises the current
 * short-term trend direction over stale data.
 *
 * Returns 0.5 (neutral) when fewer than half the requested candles are available.
 *
 * @param {Array<{open: number, close: number}>} candles15m
 * @param {number} lastIdx   — index of the last 15m candle in the period
 * @param {number} bars      — how many 15m candles to look back (default 16 = 4h)
 * @returns {number} 0–1
 */
export function mtfAlignScore(candles15m, lastIdx, bars = 16) {
  if (lastIdx < 0) return 0.5;
  const firstIdx = Math.max(0, lastIdx - bars + 1);
  const available = lastIdx - firstIdx + 1;
  if (available < Math.ceil(bars * 0.5)) return 0.5; // not enough data → neutral

  let weightedGreen = 0;
  let totalWeight = 0;
  for (let k = firstIdx; k <= lastIdx; k++) {
    // Linear weight: oldest candle in window = 1, newest = available
    const weight = k - firstIdx + 1;
    totalWeight += weight;
    if (Number(candles15m[k].close) > Number(candles15m[k].open)) {
      weightedGreen += weight;
    }
  }
  return totalWeight > 0 ? weightedGreen / totalWeight : 0.5;
}

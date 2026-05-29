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

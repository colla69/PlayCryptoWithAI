/**
 * Shared test helpers — candle fixtures, mock factories, constants.
 */

/**
 * Generate OHLCV candles from an array of close prices.
 * Each candle gets realistic open/high/low derived from close.
 * @param {number[]} closes - Array of close prices
 * @param {object} [opts]
 * @param {number} [opts.startTime=0] - Timestamp of the first candle
 * @param {number} [opts.interval=43200000] - Candle interval in ms (default 12h)
 */
export function makeCandles(closes, { startTime = 0, interval = 43_200_000 } = {}) {
  return closes.map((close, i) => ({
    timestamp: startTime + i * interval,
    open: +(close * 0.995).toFixed(8),
    high: +(close * 1.02).toFixed(8),
    low: +(close * 0.98).toFixed(8),
    close: +close.toFixed(8),
    volume: 1000,
  }));
}

/**
 * Generate a trending candle series (up or down).
 * @param {number} start - Starting close price
 * @param {number} end - Ending close price
 * @param {number} count - Number of candles
 */
export function makeTrend(start, end, count, opts) {
  const step = (end - start) / (count - 1);
  const closes = Array.from({ length: count }, (_, i) => start + step * i);
  return makeCandles(closes, opts);
}

/**
 * Generate flat/sideways candles around a price.
 * @param {number} price - Center price
 * @param {number} count - Number of candles
 * @param {number} [noise=0.002] - Max random deviation fraction
 */
export function makeFlat(price, count, noise = 0.002) {
  const closes = Array.from({ length: count }, (_, i) => {
    const jitter = (i % 2 === 0 ? 1 : -1) * price * noise * ((i % 3) / 3);
    return price + jitter;
  });
  return makeCandles(closes);
}

/** Default risk config matching production defaults */
export const DEFAULT_RISK = {
  initialBalance: 200,
  maxPositionPct: 0.15,
  stopLossPct: 0.065,
  takeProfitPct: 0.14,
  trailingStopPct: 0,
  breakEvenTriggerPct: 0.04,
  maxOpenPositions: 3,
  maxDailyLossPct: 0.05,
  minConfidence: 0.6,
};

import { EMA, RSI, MACD, BollingerBands, Stochastic, ADX, CCI } from 'technicalindicators';

export function calculateRSI(closes, period) {
  return RSI.calculate({ values: closes, period }).map(Number);
}

export function calculateEMA(closes, period) {
  return EMA.calculate({ values: closes, period }).map(Number);
}

export function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  return MACD.calculate({ values: closes, fastPeriod: fast, slowPeriod: slow, signalPeriod: signal, SimpleMAOscillator: false, SimpleMASignal: false });
}

export function calculateBollingerBands(closes, period = 20, stdDev = 2) {
  return BollingerBands.calculate({ values: closes, period, stdDev });
}

export function calculateStochastic(highs, lows, closes, period = 14, signalPeriod = 3) {
  return Stochastic.calculate({ high: highs, low: lows, close: closes, period, signalPeriod });
}

export function calculateADX(highs, lows, closes, period = 14) {
  return ADX.calculate({ close: closes, high: highs, low: lows, period });
}

export function calculateCCI(highs, lows, closes, period = 20) {
  return CCI.calculate({ high: highs, low: lows, close: closes, period });
}

/**
 * Returns true when the market is trending (ADX >= threshold).
 * Uses the last 50 candles — enough for ADX(14) to stabilise.
 * Returns true by default if there is insufficient candle history.
 *
 * @param {Array}  candles    Full candle array (uses only the tail)
 * @param {number} period     ADX period (default: 14)
 * @param {number} threshold  ADX floor for "trending" (default: 20)
 */
export function isMarketTrending(candles, period = 14, threshold = 20) {
  if (!Array.isArray(candles) || candles.length < period * 2 + 5) return true;

  const slice  = candles.slice(-50);
  const highs  = slice.map((c) => Number(c.high));
  const lows   = slice.map((c) => Number(c.low));
  const closes = slice.map((c) => Number(c.close));

  const values = calculateADX(highs, lows, closes, period);
  const last   = values.at(-1)?.adx;
  return Number.isFinite(last) ? last >= threshold : true;
}

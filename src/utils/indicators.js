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

/**
 * Pearson correlation coefficient between two return series.
 * Returns 0 if either series is too short (< 5 observations).
 */
export function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom > 0 ? num / denom : 0;
}

/**
 * Build an N×N Pearson correlation matrix from log-returns for each symbol.
 * Uses the last `period` candles from the candle cache provided by getCandlesFn.
 *
 * @param {string[]} symbols
 * @param {function(string): Array} getCandlesFn  — returns candle array for a symbol
 * @param {{ enabled: boolean, period?: number }} correlationConfig
 * @returns {Object}  matrix[sym1][sym2] = Pearson r (or 0 if insufficient data)
 */
export function buildCorrelationMatrix(symbols, getCandlesFn, correlationConfig) {
  if (!correlationConfig?.enabled) return {};
  const period = correlationConfig.period ?? 60;
  const returnsBySym = {};

  for (const sym of symbols) {
    const candles = getCandlesFn(sym);
    if (candles.length < period + 1) continue;
    const recent = candles.slice(-(period + 1));
    const rets = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = Number(recent[i - 1].close);
      const curr = Number(recent[i].close);
      if (prev > 0) rets.push(Math.log(curr / prev));
    }
    returnsBySym[sym] = rets;
  }

  const matrix = {};
  for (const sym1 of symbols) {
    matrix[sym1] = {};
    for (const sym2 of symbols) {
      if (sym1 === sym2) { matrix[sym1][sym2] = 1; continue; }
      const r1 = returnsBySym[sym1];
      const r2 = returnsBySym[sym2];
      matrix[sym1][sym2] = r1 && r2 ? pearsonCorrelation(r1, r2) : 0;
    }
  }
  return matrix;
}

/**
 * Deflated Sharpe Ratio (DSR) — Bailey & López de Prado, 2014.
 *
 * The published Sharpe ratio of a backtest is biased upward when:
 *   1. Multiple trials are run and the best is reported (selection bias),
 *   2. The return distribution is non-normal (fat tails or skew).
 *
 * The DSR is the probability that the TRUE underlying Sharpe exceeds the
 * expected maximum Sharpe under the null hypothesis of zero skill, given
 * N trials and the empirical higher moments of returns.
 *
 *   DSR ≥ 0.95  →  observed Sharpe is significant at 95% even after
 *                  correcting for the multiple-testing burden.
 *   DSR < 0.50  →  observed Sharpe is *not* better than what we would
 *                  expect from pure data-dredging.
 *
 * Reference: Bailey, D.H., López de Prado, M. (2014). "The Deflated Sharpe
 * Ratio: Correcting for Selection Bias, Backtest Overfitting, and
 * Non-Normality." Journal of Portfolio Management, 40(5).
 *
 * Inputs all use per-observation (un-annualised) Sharpe. Helper
 * `annualToPerObservation` converts daily-annualised Sharpe (sqrt(252)) to
 * the per-observation form expected by the formula.
 */

const EULER_MASCHERONI = 0.5772156649015329;

/**
 * Standard normal cumulative distribution function via Abramowitz & Stegun
 * approximation 26.2.17 (max abs error ≈ 7.5e-8).
 */
export function normCdf(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Standard normal inverse CDF (quantile function) via Beasley-Springer-Moro
 * approximation. Accurate to ~1e-9 for p ∈ (0, 1).
 */
export function normInv(p) {
  if (p <= 0 || p >= 1) {
    if (p === 0) return Number.NEGATIVE_INFINITY;
    if (p === 1) return Number.POSITIVE_INFINITY;
    return NaN;
  }
  const a = [
    -3.969683028665376e+01,  2.209460984245205e+02, -2.759285104469687e+02,
     1.383577518672690e+02, -3.066479806614716e+01,  2.506628277459239e+00,
  ];
  const b = [
    -5.447609879822406e+01,  1.615858368580409e+02, -1.556989798598866e+02,
     6.680131188771972e+01, -1.328068155288572e+01,
  ];
  const c = [
    -7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00,  4.374664141464968e+00,  2.938163982698783e+00,
  ];
  const d = [
     7.784695709041462e-03,  3.224671290700398e-01,  2.445134137142996e+00,
     3.754408661907416e+00,
  ];
  const pLow  = 0.02425;
  const pHigh = 1 - pLow;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
           ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= pHigh) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
          ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * Sample skewness (Fisher–Pearson, bias-corrected) of an array of returns.
 */
export function skewness(values) {
  const n = values.length;
  if (n < 3) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let m3 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 === 0) return 0;
  const g1 = m3 / Math.pow(m2, 1.5);
  return Math.sqrt(n * (n - 1)) / (n - 2) * g1;
}

/**
 * Sample kurtosis (actual, not excess) of an array of returns.
 * Returns 3 for a normal distribution.
 */
export function kurtosis(values) {
  const n = values.length;
  if (n < 4) return 3;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  let m2 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) return 3;
  return m4 / (m2 * m2);
}

/**
 * Convert annualised daily Sharpe (mean/std × sqrt(252)) back to the
 * per-observation Sharpe that DSR/PSR formulas expect.
 */
export function annualToPerObservation(annualSharpe, periodsPerYear = 252) {
  return annualSharpe / Math.sqrt(periodsPerYear);
}

/**
 * Probabilistic Sharpe Ratio.
 * Returns P(true Sharpe > benchmark Sharpe), given observed Sharpe and
 * empirical higher moments. SR_hat and SR_star must be in the same
 * (per-observation) units.
 */
export function probabilisticSharpeRatio({
  observedSharpe,
  benchmarkSharpe = 0,
  nObservations,
  returnSkewness = 0,
  returnKurtosis = 3,
}) {
  if (!Number.isFinite(observedSharpe) || nObservations < 2) return 0;
  const numerator = (observedSharpe - benchmarkSharpe) * Math.sqrt(nObservations - 1);
  const varianceTerm =
    1 - returnSkewness * observedSharpe +
    ((returnKurtosis - 1) / 4) * observedSharpe * observedSharpe;
  if (varianceTerm <= 0) return 0;
  const denom = Math.sqrt(varianceTerm);
  return normCdf(numerator / denom);
}

/**
 * Expected maximum Sharpe under the null hypothesis (no skill) given N
 * independent trials. Returned in per-observation units.
 *
 * SR0(N) ≈ √V × [(1 − γ_em) · Z⁻¹(1 − 1/N) + γ_em · Z⁻¹(1 − 1/(N·e))]
 *
 * V is the variance of the Sharpe estimator across trials, in
 * per-observation units. Caller must pass it explicitly. Standard
 * defaults used elsewhere in this module:
 *   • If empirical trial Sharpes are available: use their sample variance.
 *   • Otherwise default to V = 1 / (nObs − 1), the per-obs variance of a
 *     Sharpe estimator under the null with iid normal returns.
 */
export function expectedMaxSharpeUnderNull(nTrials, varianceAcrossTrials) {
  if (nTrials < 2) return 0;
  if (!Number.isFinite(varianceAcrossTrials) || varianceAcrossTrials <= 0) return 0;
  const z1 = normInv(1 - 1 / nTrials);
  const z2 = normInv(1 - 1 / (nTrials * Math.E));
  const term = (1 - EULER_MASCHERONI) * z1 + EULER_MASCHERONI * z2;
  return Math.sqrt(varianceAcrossTrials) * term;
}

/**
 * Deflated Sharpe Ratio — the probability that the true Sharpe of the
 * selected strategy exceeds the expected maximum Sharpe under the null,
 * given N trials and empirical higher moments.
 *
 * @param {object} args
 * @param {number} args.observedSharpe       — annualised Sharpe (mean/std × √periodsPerYear)
 * @param {number[]} args.returns            — per-period returns used to compute observedSharpe
 * @param {number} args.nTrials              — number of strategy variants tested
 * @param {number} [args.periodsPerYear=252] — annualisation factor used for observedSharpe
 * @param {number} [args.varianceAcrossTrials] — variance of trial Sharpes in per-obs units;
 *                                               default = 1 / (n − 1) (null + iid normal returns)
 * @returns {{ dsr, sr0, psr, observedSharpePerObs, skewness, kurtosis, nObs }}
 */
export function deflatedSharpeRatio({
  observedSharpe,
  returns,
  nTrials,
  periodsPerYear = 252,
  varianceAcrossTrials,
}) {
  if (!Array.isArray(returns) || returns.length < 4 || !Number.isFinite(observedSharpe)) {
    return { dsr: 0, sr0: 0, psr: 0, observedSharpePerObs: 0, skewness: 0, kurtosis: 3, nObs: 0 };
  }
  const observedSharpePerObs = annualToPerObservation(observedSharpe, periodsPerYear);
  const sk = skewness(returns);
  const ku = kurtosis(returns);
  const varAcross = Number.isFinite(varianceAcrossTrials) && varianceAcrossTrials > 0
    ? varianceAcrossTrials
    : 1 / Math.max(returns.length - 1, 1);
  const sr0 = expectedMaxSharpeUnderNull(Math.max(2, nTrials), varAcross);
  const dsr = probabilisticSharpeRatio({
    observedSharpe: observedSharpePerObs,
    benchmarkSharpe: sr0,
    nObservations: returns.length,
    returnSkewness: sk,
    returnKurtosis: ku,
  });
  const psr = probabilisticSharpeRatio({
    observedSharpe: observedSharpePerObs,
    benchmarkSharpe: 0,
    nObservations: returns.length,
    returnSkewness: sk,
    returnKurtosis: ku,
  });
  return {
    dsr: Number(dsr.toFixed(4)),
    sr0: Number(sr0.toFixed(4)),
    psr: Number(psr.toFixed(4)),
    observedSharpePerObs: Number(observedSharpePerObs.toFixed(4)),
    skewness: Number(sk.toFixed(4)),
    kurtosis: Number(ku.toFixed(4)),
    nObs: returns.length,
  };
}

export default deflatedSharpeRatio;

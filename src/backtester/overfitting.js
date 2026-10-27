/**
 * Backtest-overfitting diagnostics for a set of trials — the companion of
 * deflatedSharpe.js. The deflated Sharpe asks whether the best trial's Sharpe
 * survives the number of trials; these ask whether *choosing* the best trial works.
 *
 * Input everywhere: a matrix of per-period returns, rows = periods (days) in time
 * order, columns = trials (settings, combos, grid cells). Performance = Sharpe of
 * the rows used, annualized like metrics.annualizedSharpe (sample deviation, 365).
 *
 *  - pboCscv: probability of backtest overfitting by combinatorially symmetric
 *    cross-validation — Bailey, Borwein, López de Prado & Zhu (2017), "The
 *    Probability of Backtest Overfitting", Journal of Computational Finance 20(4).
 *  - cpcvSplits / cpcvPathIds: combinatorial purged cross-validation — López de
 *    Prado (2018), Advances in Financial Machine Learning, ch. 12. Folds, purge and
 *    embargo follow skfolio 1.12.2 `CombinatorialPurgedCV` index for index (checked
 *    against it once, 2026-10-27), so a model selected here can be compared there.
 *  - cpcvSelection: the out-of-sample Sharpe of each recombined CPCV path for the
 *    rule "trade the trial with the best Sharpe on the training groups".
 */

import { DAYS_PER_YEAR } from './metrics.js';

/** All k-subsets of 0..n-1, in lexicographic order (itertools.combinations order). */
export function combinations(n, k) {
  const out = [];
  const c = Array.from({ length: k }, (_, i) => i);
  if (k > n || k < 0) return out;
  for (;;) {
    out.push([...c]);
    let i = k - 1;
    while (i >= 0 && c[i] === n - k + i) i--;
    if (i < 0) return out;
    c[i]++;
    for (let j = i + 1; j < k; j++) c[j] = c[j - 1] + 1;
  }
}

/** Group of each row: equal groups of floor(nObs / nGroups) rows, the last takes the remainder. */
function groupOf(nObs, nGroups) {
  const size = Math.floor(nObs / nGroups);
  return { size, of: (i) => Math.min(Math.floor(i / size), nGroups - 1) };
}

/** Annualized Sharpe from a sum, a sum of squares and a count (0 when undefined). */
function sharpeOf(sum, sumSq, n, periodsPerYear) {
  if (n < 2) return 0;
  const mean = sum / n;
  const variance = (sumSq - n * mean * mean) / (n - 1);
  return variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(periodsPerYear) : 0;
}

/** Ranks 1..n (1 = lowest), ties share their average rank. */
function ranks(values) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const r = new Array(values.length);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    for (let m = i; m <= j; m++) r[idx[m]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return r;
}

function checkMatrix(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) throw new Error('overfitting: empty matrix');
  const nTrials = matrix[0].length;
  if (nTrials < 2) throw new Error('overfitting: need at least 2 trials');
  if (matrix.some((row) => row.length !== nTrials)) throw new Error('overfitting: ragged matrix');
  return { nObs: matrix.length, nTrials };
}

/**
 * Probability of backtest overfitting (CSCV). The rows are cut into `nBlocks` equal
 * blocks (the last takes the remainder); for every choice of half the blocks as the
 * in-sample half, the trial with the best in-sample Sharpe is ranked among all trials
 * on the other half. ω = rank / (N + 1), logit λ = ln(ω / (1 − ω)); PBO = share of
 * halvings with λ ≤ 0, i.e. the in-sample winner at or below the out-of-sample median.
 * In-sample ties go to the lowest column; out-of-sample ties share their average rank.
 *
 * @param {number[][]} matrix — rows = periods, columns = trials
 * @param {object} [opts]
 * @param {number} [opts.nBlocks=16] — even; C(16, 8) = 12,870 halvings
 * @param {number} [opts.periodsPerYear=365]
 * @returns {{ pbo, probLoss, slope, intercept, nCombos, nTrials, nBlocks, logits: number[],
 *   picks: number[], meanOosRank: number[] }}
 *   probLoss — share of halvings where the in-sample winner's out-of-sample Sharpe < 0;
 *   slope/intercept — OLS of the winner's out-of-sample Sharpe on its in-sample Sharpe;
 *   picks — how often each trial was the in-sample winner;
 *   meanOosRank — each trial's mean out-of-sample ω over all halvings (0.5 = median).
 */
export function pboCscv(matrix, { nBlocks = 16, periodsPerYear = DAYS_PER_YEAR } = {}) {
  const { nObs, nTrials } = checkMatrix(matrix);
  if (nBlocks < 2 || nBlocks % 2) throw new Error('pboCscv: nBlocks must be even');
  if (nObs < 2 * nBlocks) throw new Error(`pboCscv: ${nObs} rows is too few for ${nBlocks} blocks`);
  const g = groupOf(nObs, nBlocks);
  // per block and trial: sum, sum of squares, count — each halving adds eight of them
  const sum = Array.from({ length: nBlocks }, () => new Float64Array(nTrials));
  const sq = Array.from({ length: nBlocks }, () => new Float64Array(nTrials));
  const cnt = new Float64Array(nBlocks);
  matrix.forEach((row, i) => {
    const b = g.of(i);
    cnt[b]++;
    for (let j = 0; j < nTrials; j++) { sum[b][j] += row[j]; sq[b][j] += row[j] * row[j]; }
  });
  const sharpes = (blocks) => {
    const out = new Array(nTrials);
    const n = blocks.reduce((s, b) => s + cnt[b], 0);
    for (let j = 0; j < nTrials; j++) {
      let s = 0; let q = 0;
      for (const b of blocks) { s += sum[b][j]; q += sq[b][j]; }
      out[j] = sharpeOf(s, q, n, periodsPerYear);
    }
    return out;
  };
  const logits = [];
  const isBest = [];
  const oosBest = [];
  const picks = new Array(nTrials).fill(0);
  const rankSum = new Array(nTrials).fill(0);
  const all = Array.from({ length: nBlocks }, (_, i) => i);
  for (const inBlocks of combinations(nBlocks, nBlocks / 2)) {
    const outBlocks = all.filter((b) => !inBlocks.includes(b));
    const is = sharpes(inBlocks);
    const oos = sharpes(outBlocks);
    let star = 0;
    for (let j = 1; j < nTrials; j++) if (is[j] > is[star]) star = j;
    const r = ranks(oos);
    for (let j = 0; j < nTrials; j++) rankSum[j] += r[j] / (nTrials + 1);
    const w = r[star] / (nTrials + 1);
    logits.push(Math.log(w / (1 - w)));
    isBest.push(is[star]);
    oosBest.push(oos[star]);
    picks[star]++;
  }
  const n = logits.length;
  const mx = isBest.reduce((s, v) => s + v, 0) / n;
  const my = oosBest.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0;
  for (let k = 0; k < n; k++) { sxy += (isBest[k] - mx) * (oosBest[k] - my); sxx += (isBest[k] - mx) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return {
    pbo: logits.filter((l) => l <= 0).length / n,
    probLoss: oosBest.filter((v) => v < 0).length / n,
    slope,
    intercept: my - slope * mx,
    nCombos: n,
    nTrials,
    nBlocks,
    logits,
    picks,
    meanOosRank: rankSum.map((s) => s / n),
  };
}

/** Number of recombined CPCV paths: C(nGroups − 1, nTestGroups − 1). */
export function cpcvNPaths(nGroups, nTestGroups) {
  return combinations(nGroups, nTestGroups).length * nTestGroups / nGroups;
}

/**
 * Path id of each test group in each split: the p-th split (in split order) that
 * tests group g supplies group g of path p. Row s, column j = the j-th test group
 * of split s (groups ascending).
 */
export function cpcvPathIds(nGroups, nTestGroups) {
  const seen = new Array(nGroups).fill(0);
  return combinations(nGroups, nTestGroups).map((test) => test.map((gid) => seen[gid]++));
}

/**
 * Combinatorial purged cross-validation splits. Rows are cut into `nGroups` equal
 * groups (the last takes the remainder); each split tests `nTestGroups` of them and
 * trains on the rest, minus the purge — `purge` training rows before each test
 * block and `purge + embargo` after it, so a position open across a boundary does
 * not leak into the training set.
 *
 * @returns {{ testGroups: number[], train: number[], tests: number[][] }[]} — one per
 *   split in lexicographic order of the test groups; `tests[j]` = rows of testGroups[j]
 */
export function cpcvSplits({ nObs, nGroups, nTestGroups, purge = 0, embargo = 0 }) {
  if (!Number.isInteger(nGroups) || nGroups <= 2) throw new Error('cpcvSplits: nGroups must be an integer > 2');
  if (!Number.isInteger(nTestGroups) || nTestGroups <= 1 || nTestGroups >= nGroups) {
    throw new Error('cpcvSplits: nTestGroups must be an integer in 2..nGroups-1');
  }
  if (purge < 0 || embargo < 0) throw new Error('cpcvSplits: purge and embargo cannot be negative');
  const g = groupOf(nObs, nGroups);
  if (purge + embargo >= g.size - 1) throw new Error('cpcvSplits: purge + embargo must be smaller than a group minus one row');
  const group = Array.from({ length: nObs }, (_, i) => g.of(i));
  const rowsOf = Array.from({ length: nGroups }, () => []);
  group.forEach((gid, i) => rowsOf[gid].push(i));
  return combinations(nGroups, nTestGroups).map((testGroups) => {
    const label = group.map((gid) => (testGroups.includes(gid) ? 1 : 0));
    const cut = new Set();
    for (let r = 0; r + 1 < nObs; r++) {
      if (label[r] === 0 && label[r + 1] === 1) for (let k = 0; k < purge; k++) cut.add(Math.max(0, r - k));
      if (label[r] === 1 && label[r + 1] === 0) for (let k = 0; k < purge + embargo; k++) cut.add(Math.min(nObs - 1, r + k + 1));
    }
    return {
      testGroups,
      train: label.flatMap((l, i) => (l === 0 && !cut.has(i) ? [i] : [])),
      tests: testGroups.map((gid) => rowsOf[gid]),
    };
  });
}

/**
 * CPCV for a selection rule: in each split, pick the trial with the best Sharpe on
 * the (purged) training rows and record its returns on each test group; the test
 * groups recombine into C(nGroups − 1, nTestGroups − 1) full-length out-of-sample
 * paths. Training-Sharpe ties go to the lowest column.
 *
 * @returns {{ paths: { sharpe: number, picks: number[] }[], nSplits: number }} —
 *   picks[g] = the trial traded on group g of that path
 */
export function cpcvSelection(matrix, { nGroups = 10, nTestGroups = 2, purge = 0, embargo = 0, periodsPerYear = DAYS_PER_YEAR } = {}) {
  const { nObs, nTrials } = checkMatrix(matrix);
  const splits = cpcvSplits({ nObs, nGroups, nTestGroups, purge, embargo });
  const pathIds = cpcvPathIds(nGroups, nTestGroups);
  const nPaths = cpcvNPaths(nGroups, nTestGroups);
  const series = Array.from({ length: nPaths }, () => new Array(nObs));
  const picks = Array.from({ length: nPaths }, () => new Array(nGroups));
  splits.forEach(({ train, tests, testGroups }, s) => {
    let star = 0; let best = -Infinity;
    for (let j = 0; j < nTrials; j++) {
      let sum = 0; let q = 0;
      for (const i of train) { sum += matrix[i][j]; q += matrix[i][j] * matrix[i][j]; }
      const sr = sharpeOf(sum, q, train.length, periodsPerYear);
      if (sr > best) { best = sr; star = j; }
    }
    tests.forEach((rows, k) => {
      const p = pathIds[s][k];
      picks[p][testGroups[k]] = star;
      for (const i of rows) series[p][i] = matrix[i][star];
    });
  });
  return {
    nSplits: splits.length,
    paths: series.map((rets, p) => {
      let sum = 0; let q = 0;
      for (const v of rets) { sum += v; q += v * v; }
      return { sharpe: sharpeOf(sum, q, nObs, periodsPerYear), picks: picks[p] };
    }),
  };
}

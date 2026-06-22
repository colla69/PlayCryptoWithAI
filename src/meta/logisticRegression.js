/**
 * Minimal logistic regression (Phase 5 meta-overlay).
 *
 * Pure JS, zero dependencies. Batch gradient descent with L2 regularisation and
 * z-score feature standardisation (stored in the model so inference matches
 * training exactly). Used to learn P(win) for a candidate trade from its
 * entry-time feature vector.
 *
 * This is the upper bound on ML complexity in this repo by design — logistic
 * regression is interpretable, robust on small samples, and cheap to ship as a
 * handful of coefficients. No deep learning (see plan "Out of scope").
 *
 * Model JSON shape (data/meta_overlay.json):
 *   { featureOrder:[...], weights:[...], bias:n, mean:[...], std:[...],
 *     trainedAt, nSamples, threshold, metrics:{...} }
 */

export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Column-wise mean/std for z-score standardisation (std floored to avoid /0). */
export function standardiseFit(X) {
  const n = X.length;
  const d = n ? X[0].length : 0;
  const mean = new Array(d).fill(0);
  const std = new Array(d).fill(0);
  for (const row of X) for (let j = 0; j < d; j++) mean[j] += row[j];
  for (let j = 0; j < d; j++) mean[j] /= (n || 1);
  for (const row of X) for (let j = 0; j < d; j++) std[j] += (row[j] - mean[j]) ** 2;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / (n || 1)) || 1;
  return { mean, std };
}

export function standardiseApply(x, mean, std) {
  return x.map((v, j) => (v - mean[j]) / (std[j] || 1));
}

/**
 * Train a logistic regression classifier.
 * @param {number[][]} X        — feature rows
 * @param {number[]}   y        — labels (0/1)
 * @param {object} [opts]
 * @returns {{ weights:number[], bias:number, mean:number[], std:number[], nSamples:number }}
 */
export function trainLogistic(X, y, { lr = 0.1, epochs = 500, l2 = 0.01 } = {}) {
  const n = X.length;
  const d = n ? X[0].length : 0;
  if (!n || !d) return { weights: new Array(d).fill(0), bias: 0, mean: new Array(d).fill(0), std: new Array(d).fill(1), nSamples: 0 };

  const { mean, std } = standardiseFit(X);
  const Z = X.map((row) => standardiseApply(row, mean, std));
  const weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;
    for (let i = 0; i < n; i++) {
      let z = bias;
      for (let j = 0; j < d; j++) z += weights[j] * Z[i][j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * Z[i][j];
      gradB += err;
    }
    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias, mean, std, nSamples: n };
}

/** Predict P(label=1) for a raw (unstandardised) feature vector. */
export function predictProba(model, x) {
  if (!model || !Array.isArray(model.weights)) return 0.5;
  const z = standardiseApply(x, model.mean, model.std);
  let acc = model.bias ?? 0;
  for (let j = 0; j < model.weights.length; j++) acc += model.weights[j] * (z[j] ?? 0);
  return sigmoid(acc);
}

/** Log loss on a held-out set (lower is better). */
export function logLoss(model, X, y) {
  if (!X.length) return NaN;
  const eps = 1e-12;
  let sum = 0;
  for (let i = 0; i < X.length; i++) {
    const p = Math.min(1 - eps, Math.max(eps, predictProba(model, X[i])));
    sum += -(y[i] * Math.log(p) + (1 - y[i]) * Math.log(1 - p));
  }
  return sum / X.length;
}

/** Accuracy at a probability threshold. */
export function accuracy(model, X, y, threshold = 0.5) {
  if (!X.length) return NaN;
  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = predictProba(model, X[i]) >= threshold ? 1 : 0;
    if (pred === y[i]) correct++;
  }
  return correct / X.length;
}

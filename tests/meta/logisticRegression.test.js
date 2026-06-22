import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  sigmoid, trainLogistic, predictProba, logLoss, accuracy, standardiseFit,
} from '../../src/meta/logisticRegression.js';

describe('logisticRegression — sigmoid', () => {
  test('sigmoid(0) = 0.5', () => assert.ok(Math.abs(sigmoid(0) - 0.5) < 1e-12));
  test('monotonic and bounded', () => {
    assert.ok(sigmoid(10) > 0.99 && sigmoid(10) < 1);
    assert.ok(sigmoid(-10) < 0.01 && sigmoid(-10) > 0);
  });
});

describe('logisticRegression — standardisation', () => {
  test('std floored to 1 for constant columns', () => {
    const { std } = standardiseFit([[5], [5], [5]]);
    assert.equal(std[0], 1);
  });
});

describe('logisticRegression — training', () => {
  test('learns a separable 1-D boundary', () => {
    // y = 1 when x > 0
    const X = [], y = [];
    for (let v = -5; v <= 5; v += 0.5) { X.push([v]); y.push(v > 0 ? 1 : 0); }
    const model = trainLogistic(X, y, { epochs: 1000, lr: 0.3 });
    assert.ok(predictProba(model, [3]) > 0.8, 'high x → high P');
    assert.ok(predictProba(model, [-3]) < 0.2, 'low x → low P');
    assert.ok(accuracy(model, X, y, 0.5) > 0.9);
  });

  test('empty input returns a safe zero model', () => {
    const m = trainLogistic([], []);
    assert.equal(m.nSamples, 0);
    assert.equal(predictProba(m, [1, 2, 3]), 0.5);
  });

  test('logLoss decreases for a confident correct model', () => {
    const X = [[2], [2], [-2], [-2]], y = [1, 1, 0, 0];
    const model = trainLogistic(X, y, { epochs: 1000, lr: 0.3 });
    assert.ok(logLoss(model, X, y) < 0.4);
  });
});

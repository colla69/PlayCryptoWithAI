/**
 * CPCV and PBO (src/backtester/overfitting.js, section E item 3). The splits were
 * checked once against skfolio 1.12.2 `CombinatorialPurgedCV` (six sizes, purges and
 * embargoes: identical indices and path ids) and PBO against a NumPy CSCV written from
 * Bailey et al. (2017) (equal to 1e-15); these fixtures pin the cases that can be
 * worked by hand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combinations, cpcvSplits, cpcvPathIds, cpcvNPaths, cpcvSelection, pboCscv,
} from '../../src/backtester/overfitting.js';
import { annualizedSharpe } from '../../src/backtester/metrics.js';

/** Deterministic noise in [-a, a] (LCG), so the fixtures need no random seed. */
function noise(seed, a) {
  let s = seed >>> 0;
  return () => { s = (1664525 * s + 1013904223) >>> 0; return (s / 2 ** 32 * 2 - 1) * a; };
}

test('combinations: lexicographic, C(16, 8) = 12,870', () => {
  assert.deepEqual(combinations(4, 2), [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]]);
  assert.equal(combinations(16, 8).length, 12_870);
});

test('cpcvSplits: skfolio docstring case, 12 rows, 3 groups, 2 test, purge 1', () => {
  const splits = cpcvSplits({ nObs: 12, nGroups: 3, nTestGroups: 2, purge: 1 });
  assert.deepEqual(splits.map((s) => s.testGroups), [[0, 1], [0, 2], [1, 2]]);
  // purge 1 row on each side of every test block (row 8 after; rows 4 and 7; row 3)
  assert.deepEqual(splits.map((s) => s.train), [[9, 10, 11], [5, 6], [0, 1, 2]]);
  assert.deepEqual(splits[1].tests, [[0, 1, 2, 3], [8, 9, 10, 11]]);
  assert.deepEqual(cpcvPathIds(3, 2), [[0, 0], [1, 0], [1, 1]]);
  assert.equal(cpcvNPaths(3, 2), 2);
});

test('cpcvSplits: the embargo only follows a test block; the last group takes the remainder', () => {
  const [first] = cpcvSplits({ nObs: 13, nGroups: 3, nTestGroups: 2, purge: 0, embargo: 2 });
  assert.deepEqual(first.tests[1], [4, 5, 6, 7]);
  assert.deepEqual(first.train, [10, 11, 12]);
  const last = cpcvSplits({ nObs: 13, nGroups: 3, nTestGroups: 2 }).at(-1);
  assert.deepEqual(last.tests[1], [8, 9, 10, 11, 12]);
});

test('cpcvSplits: rejects settings skfolio rejects', () => {
  assert.throws(() => cpcvSplits({ nObs: 100, nGroups: 2, nTestGroups: 1 }), /nGroups/);
  assert.throws(() => cpcvSplits({ nObs: 100, nGroups: 5, nTestGroups: 5 }), /nTestGroups/);
  assert.throws(() => cpcvSplits({ nObs: 20, nGroups: 5, nTestGroups: 2, purge: 2, embargo: 1 }), /purge \+ embargo/);
});

test('cpcvSelection: a trial that is best on every group is traded on every path', () => {
  const r = noise(1, 0.01);
  const matrix = Array.from({ length: 200 }, () => [r(), r() + 0.02, r()]);
  const { paths, nSplits } = cpcvSelection(matrix, { nGroups: 5, nTestGroups: 2, purge: 2, embargo: 2 });
  assert.equal(nSplits, 10);
  assert.equal(paths.length, 4);
  for (const p of paths) {
    assert.deepEqual(p.picks, [1, 1, 1, 1, 1]);
    assert.ok(Math.abs(p.sharpe - annualizedSharpe(matrix.map((row) => row[1]))) < 1e-9);
  }
});

test('pboCscv: a dominant trial never overfits', () => {
  const r = noise(2, 0.01);
  const matrix = Array.from({ length: 160 }, () => [r(), r(), r() + 0.03, r()]);
  const res = pboCscv(matrix, { nBlocks: 8 });
  assert.equal(res.nCombos, 70);
  assert.equal(res.pbo, 0);
  assert.equal(res.probLoss, 0);
  assert.deepEqual(res.picks, [0, 0, 70, 0]);
  assert.ok(Math.abs(res.meanOosRank[2] - 4 / 5) < 1e-12);
});

test('pboCscv: a pure reversal is always overfit (PBO 1)', () => {
  // trial 1 = −trial 0, and each trial's block means sum to zero: whichever wins one
  // half has the mirror-image Sharpe on the other half and ranks last there (no four
  // of the means sum to zero, so no half is a tie)
  const means = [17, -2, 5, -3, -7, 11, -4, -17].map((m) => m * 1e-3);
  const matrix = means.flatMap((m) => [m + 0.004, m - 0.004, m + 0.004, m - 0.004].map((v) => [v, -v]));
  const res = pboCscv(matrix, { nBlocks: 8 });
  assert.equal(res.pbo, 1);
  assert.ok(res.slope < 0);
});

test('pboCscv: input checks', () => {
  assert.throws(() => pboCscv([[0, 1]], { nBlocks: 3 }), /even/);
  assert.throws(() => pboCscv(Array.from({ length: 10 }, () => [0, 1]), { nBlocks: 8 }), /too few/);
  assert.throws(() => pboCscv([[0, 1], [0]], { nBlocks: 2 }), /ragged/);
  assert.throws(() => pboCscv([[0], [1]]), /2 trials/);
});

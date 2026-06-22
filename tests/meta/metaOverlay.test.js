import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURE_ORDER, buildFeatureVector, evaluateGate, winProbability } from '../../src/meta/metaOverlay.js';

describe('metaOverlay — feature vector', () => {
  test('vector length matches FEATURE_ORDER', () => {
    assert.equal(buildFeatureVector({}).length, FEATURE_ORDER.length);
  });

  test('regime one-hot encodes correctly', () => {
    const v = buildFeatureVector({ regime: 'BEAR_TREND' });
    const idx = FEATURE_ORDER.indexOf('reg_bear_trend');
    assert.equal(v[idx], 1);
    assert.equal(v[FEATURE_ORDER.indexOf('reg_bull_trend')], 0);
  });

  test('missing / non-finite values default to 0', () => {
    const v = buildFeatureVector({ aggConfidence: 'x', adx: undefined });
    assert.equal(v[FEATURE_ORDER.indexOf('aggConfidence')], 0);
    assert.equal(v[FEATURE_ORDER.indexOf('adx')], 0);
  });
});

describe('metaOverlay — gate', () => {
  test('no model → always passes (no-op gate)', () => {
    const r = evaluateGate(null, { aggConfidence: 0.6 });
    assert.equal(r.pass, true);
    assert.equal(r.pWin, null);
    assert.equal(winProbability(null, {}), 1);
  });

  test('pass = P(win) >= threshold', () => {
    // A trivial model: weight only on aggConfidence, standardised mean 0 std 1.
    const model = {
      featureOrder: FEATURE_ORDER,
      weights: FEATURE_ORDER.map((n) => (n === 'aggConfidence' ? 10 : 0)),
      bias: -5,
      mean: FEATURE_ORDER.map(() => 0),
      std: FEATURE_ORDER.map(() => 1),
    };
    const hi = evaluateGate(model, { aggConfidence: 1 }, 0.55);
    const lo = evaluateGate(model, { aggConfidence: 0 }, 0.55);
    assert.equal(hi.pass, true);
    assert.equal(lo.pass, false);
    assert.ok(hi.pWin > lo.pWin);
  });
});

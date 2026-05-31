/**
 * Position Sizing Chain — Unit Tests
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyATRSizing, applyMacroFilter, applyRegimeSizing, applyConfSizing, computePositionSize } from '../../src/core/positionSizing.js';
import { makeFlat } from '../helpers.js';

describe('Position Sizing: ATR', () => {
  test('disabled config returns base unchanged', () => {
    const result = applyATRSizing(0.15, makeFlat(100, 50), 0.03, { enabled: false });
    assert.equal(result, 0.15);
  });

  test('null medianATRPct returns base unchanged', () => {
    const result = applyATRSizing(0.15, makeFlat(100, 50), null, { enabled: true, period: 14 });
    assert.equal(result, 0.15);
  });
});

describe('Position Sizing: Macro Filter', () => {
  test('bull market returns base unchanged', () => {
    assert.equal(applyMacroFilter(0.15, true, { enabled: true, sizeReduceFactor: 0.5 }), 0.15);
  });

  test('bear market halves position', () => {
    assert.equal(applyMacroFilter(0.15, false, { enabled: true, sizeReduceFactor: 0.5 }), 0.075);
  });

  test('disabled returns base unchanged', () => {
    assert.equal(applyMacroFilter(0.15, false, { enabled: false }), 0.15);
  });
});

describe('Position Sizing: Confidence', () => {
  test('high confidence scales up', () => {
    const result = applyConfSizing(0.15, 0.95, { enabled: true, mid: 0.65, max: 1.5, min: 0.6 });
    assert.ok(result > 0.15, `${result} should be > 0.15`);
  });

  test('low confidence scales down', () => {
    const result = applyConfSizing(0.15, 0.3, { enabled: true, mid: 0.65, max: 1.5, min: 0.6 });
    assert.ok(result < 0.15, `${result} should be < 0.15`);
  });

  test('disabled returns base unchanged', () => {
    assert.equal(applyConfSizing(0.15, 0.3, { enabled: false }), 0.15);
  });
});

describe('Position Sizing: Full Chain', () => {
  test('all disabled returns base', () => {
    const result = computePositionSize({
      basePct: 0.15,
      candles: makeFlat(100, 50),
      medianATRPct: null,
      btcMacroBull: true,
      confidence: 0.7,
      mtfSizeFactor: 1.0,
      config: { atr: { enabled: false }, macroFilter: { enabled: false }, regimeSizing: { enabled: false }, confSizing: { enabled: false } },
    });
    assert.equal(result, 0.15);
  });

  test('MTF size factor applies', () => {
    const result = computePositionSize({
      basePct: 0.15,
      candles: makeFlat(100, 50),
      medianATRPct: null,
      btcMacroBull: true,
      confidence: 0.7,
      mtfSizeFactor: 0.5,
      config: { atr: { enabled: false }, macroFilter: { enabled: false }, regimeSizing: { enabled: false }, confSizing: { enabled: false } },
    });
    assert.equal(result, 0.075);
  });
});

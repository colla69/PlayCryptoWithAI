/**
 * Phase 2 — Smoke tests for the 5 new orthogonal strategies.
 *
 * Each test verifies the strategy contract:
 *   - Returns { name, signal, confidence, reason } (signal ∈ BUY/SELL/HOLD)
 *   - Confidence is a finite number in [0, 1]
 *   - Returns HOLD when not enough candles
 *   - Excludes the forming candle (the last candle in the input array)
 *
 * Light scenario tests cover the "happy path" trigger conditions so we'd
 * notice if any strategy quietly stopped firing.  Heavier scenario coverage
 * is left for the per-symbol optimizer's training pass.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeCandles, makeTrend } from '../helpers.js';
import {
  DonchianStrategy,
  VWAPSigmaStrategy,
  VolumeSurgeStrategy,
  IchimokuStrategy,
  PinBarStrategy,
} from '../../src/strategies/index.js';

// ── Shape contract ────────────────────────────────────────────────────────────

const SIGNALS = new Set(['BUY', 'SELL', 'HOLD']);

function assertShape(r, expectedName) {
  assert.equal(typeof r, 'object', 'result is an object');
  assert.notEqual(r, null, 'result is not null');
  assert.equal(r.name, expectedName, `name === ${expectedName}`);
  assert.ok(SIGNALS.has(r.signal), `signal in {BUY,SELL,HOLD}, got ${r.signal}`);
  assert.equal(typeof r.confidence, 'number', 'confidence is a number');
  assert.ok(Number.isFinite(r.confidence), 'confidence is finite');
  assert.ok(r.confidence >= 0 && r.confidence <= 1, `confidence in [0,1], got ${r.confidence}`);
  assert.equal(typeof r.reason, 'string', 'reason is a string');
  assert.ok(r.reason.length > 0, 'reason is non-empty');
}

/** Builds a candle with explicit OHLCV (defaults flat). */
function candle({ open = 100, high = 100, low = 100, close = 100, volume = 1000, timestamp = 0 } = {}) {
  return { open, high, low, close, volume, timestamp };
}

// ── DonchianStrategy ──────────────────────────────────────────────────────────

describe('DonchianStrategy', () => {
  test('returns HOLD with low confidence when not enough candles', () => {
    const s = new DonchianStrategy({ period: 20 });
    const r = s.analyze(makeCandles([100, 101, 102]));
    assertShape(r, 'Donchian');
    assert.equal(r.signal, 'HOLD');
  });

  test('contract shape on a flat market', () => {
    const s = new DonchianStrategy();
    // 30 candles plus a forming one = 31 total
    const r = s.analyze(makeCandles(Array.from({ length: 31 }, () => 100)));
    assertShape(r, 'Donchian');
  });

  test('fires BUY on upper breakout with volume confirmation', () => {
    const s = new DonchianStrategy({ period: 10, volumeMultiple: 1.2, volumePeriod: 10 });
    const flat = Array.from({ length: 12 }, (_, i) => candle({
      open: 100, high: 101, low: 99, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    // Closed breakout candle (the bar evaluated as the "current closed")
    flat.push(candle({ open: 101, high: 110, low: 101, close: 110, volume: 5000, timestamp: 12_000 }));
    // Forming candle (excluded by analyze)
    flat.push(candle({ open: 110, high: 111, low: 109, close: 110, volume: 100, timestamp: 13_000 }));
    const r = s.analyze(flat);
    assertShape(r, 'Donchian');
    assert.equal(r.signal, 'BUY', `expected BUY, got ${r.signal} (${r.reason})`);
    assert.ok(r.confidence >= 0.5, `confidence too low: ${r.confidence}`);
  });

  test('blocks upper breakout when volume insufficient', () => {
    const s = new DonchianStrategy({ period: 10, volumeMultiple: 1.5, volumePeriod: 10 });
    const flat = Array.from({ length: 12 }, (_, i) => candle({
      open: 100, high: 101, low: 99, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    flat.push(candle({ open: 101, high: 110, low: 101, close: 110, volume: 900, timestamp: 12_000 }));
    flat.push(candle({ open: 110, high: 111, low: 109, close: 110, volume: 100, timestamp: 13_000 }));
    const r = s.analyze(flat);
    assertShape(r, 'Donchian');
    assert.equal(r.signal, 'HOLD');
  });

  test('excludes the forming candle (mutating last candle does not change verdict)', () => {
    const s = new DonchianStrategy({ period: 10 });
    const base = makeCandles(Array.from({ length: 30 }, () => 100));
    const r1 = s.analyze(base);
    // Mutate the forming candle wildly — it must not affect the signal
    const mutated = [...base];
    mutated[mutated.length - 1] = candle({
      open: 50, high: 200, low: 1, close: 200, volume: 999_999, timestamp: 99_999,
    });
    const r2 = s.analyze(mutated);
    assert.equal(r1.signal, r2.signal, 'forming candle leaked into decision');
  });
});

// ── VWAPSigmaStrategy ─────────────────────────────────────────────────────────

describe('VWAPSigmaStrategy', () => {
  test('returns HOLD when not enough candles', () => {
    const s = new VWAPSigmaStrategy({ period: 20 });
    const r = s.analyze(makeCandles([100, 100, 100]));
    assertShape(r, 'VWAPSigma');
    assert.equal(r.signal, 'HOLD');
  });

  test('contract shape on uptrend', () => {
    const s = new VWAPSigmaStrategy({ period: 20, stdDevMult: 2 });
    const r = s.analyze(makeTrend(100, 130, 30));
    assertShape(r, 'VWAPSigma');
  });

  test('fires SELL on extreme up-stretch beyond band', () => {
    const s = new VWAPSigmaStrategy({ period: 20, stdDevMult: 1 });
    // Calm period followed by a sharp spike on the last closed bar
    const calm = Array.from({ length: 20 }, (_, i) => candle({
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    calm.push(candle({ open: 100, high: 120, low: 100, close: 120, volume: 1000, timestamp: 20_000 }));
    calm.push(candle({ open: 120, high: 121, low: 119, close: 120, volume: 100, timestamp: 21_000 }));
    const r = s.analyze(calm);
    assertShape(r, 'VWAPSigma');
    assert.equal(r.signal, 'SELL', `expected SELL, got ${r.signal} (${r.reason})`);
  });

  test('fires BUY on extreme down-stretch beyond band', () => {
    const s = new VWAPSigmaStrategy({ period: 20, stdDevMult: 1 });
    const calm = Array.from({ length: 20 }, (_, i) => candle({
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    calm.push(candle({ open: 100, high: 100, low: 80, close: 80, volume: 1000, timestamp: 20_000 }));
    calm.push(candle({ open: 80, high: 81, low: 79, close: 80, volume: 100, timestamp: 21_000 }));
    const r = s.analyze(calm);
    assertShape(r, 'VWAPSigma');
    assert.equal(r.signal, 'BUY', `expected BUY, got ${r.signal} (${r.reason})`);
  });
});

// ── VolumeSurgeStrategy ───────────────────────────────────────────────────────

describe('VolumeSurgeStrategy', () => {
  test('returns HOLD when not enough candles', () => {
    const s = new VolumeSurgeStrategy({ period: 20 });
    const r = s.analyze(makeCandles([100, 101]));
    assertShape(r, 'VolumeSurge');
    assert.equal(r.signal, 'HOLD');
  });

  test('contract shape on a flat market', () => {
    const s = new VolumeSurgeStrategy({ period: 10 });
    const r = s.analyze(makeCandles(Array.from({ length: 20 }, () => 100)));
    assertShape(r, 'VolumeSurge');
  });

  test('fires BUY on green candle with surge volume', () => {
    const s = new VolumeSurgeStrategy({ period: 10, multiplier: 2.0 });
    const calm = Array.from({ length: 10 }, (_, i) => candle({
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    calm.push(candle({ open: 100, high: 105, low: 100, close: 105, volume: 5000, timestamp: 10_000 }));
    calm.push(candle({ open: 105, high: 106, low: 104, close: 105, volume: 100, timestamp: 11_000 }));
    const r = s.analyze(calm);
    assertShape(r, 'VolumeSurge');
    assert.equal(r.signal, 'BUY', `expected BUY, got ${r.signal} (${r.reason})`);
  });

  test('fires SELL on red candle with surge volume', () => {
    const s = new VolumeSurgeStrategy({ period: 10, multiplier: 2.0 });
    const calm = Array.from({ length: 10 }, (_, i) => candle({
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    calm.push(candle({ open: 100, high: 100, low: 95, close: 95, volume: 5000, timestamp: 10_000 }));
    calm.push(candle({ open: 95, high: 96, low: 94, close: 95, volume: 100, timestamp: 11_000 }));
    const r = s.analyze(calm);
    assertShape(r, 'VolumeSurge');
    assert.equal(r.signal, 'SELL', `expected SELL, got ${r.signal} (${r.reason})`);
  });

  test('HOLD when no surge despite directional candle', () => {
    const s = new VolumeSurgeStrategy({ period: 10, multiplier: 2.0 });
    const calm = Array.from({ length: 10 }, (_, i) => candle({
      open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000, timestamp: i * 1000,
    }));
    calm.push(candle({ open: 100, high: 105, low: 100, close: 105, volume: 1100, timestamp: 10_000 }));
    calm.push(candle({ open: 105, high: 106, low: 104, close: 105, volume: 100, timestamp: 11_000 }));
    const r = s.analyze(calm);
    assertShape(r, 'VolumeSurge');
    assert.equal(r.signal, 'HOLD');
  });
});

// ── IchimokuStrategy ──────────────────────────────────────────────────────────

describe('IchimokuStrategy', () => {
  test('returns HOLD when not enough candles', () => {
    const s = new IchimokuStrategy();
    const r = s.analyze(makeCandles(Array.from({ length: 30 }, () => 100)));
    assertShape(r, 'Ichimoku');
    assert.equal(r.signal, 'HOLD');
  });

  test('contract shape with enough candles', () => {
    const s = new IchimokuStrategy();
    const r = s.analyze(makeCandles(Array.from({ length: 60 }, () => 100)));
    assertShape(r, 'Ichimoku');
  });

  test('fires BUY on sustained uptrend with price above cloud and TK bullish', () => {
    const s = new IchimokuStrategy();
    const r = s.analyze(makeTrend(100, 200, 80));
    assertShape(r, 'Ichimoku');
    assert.equal(r.signal, 'BUY', `expected BUY, got ${r.signal} (${r.reason})`);
  });

  test('fires SELL on sustained downtrend with price below cloud and TK bearish', () => {
    const s = new IchimokuStrategy();
    const r = s.analyze(makeTrend(200, 100, 80));
    assertShape(r, 'Ichimoku');
    assert.equal(r.signal, 'SELL', `expected SELL, got ${r.signal} (${r.reason})`);
  });
});

// ── PinBarStrategy ────────────────────────────────────────────────────────────

describe('PinBarStrategy', () => {
  test('returns HOLD when not enough candles', () => {
    const s = new PinBarStrategy();
    const r = s.analyze([]);
    assertShape(r, 'PinBar');
    assert.equal(r.signal, 'HOLD');
  });

  test('contract shape on a flat market', () => {
    const s = new PinBarStrategy();
    const r = s.analyze(makeCandles(Array.from({ length: 5 }, () => 100)));
    assertShape(r, 'PinBar');
  });

  test('fires BUY on a bullish pin bar (long lower wick, close in upper half)', () => {
    const s = new PinBarStrategy();
    const candles = [
      candle({ open: 100, high: 101, low: 99,  close: 100, volume: 1000 }),
      // Bullish pin: open near close, but a deep lower wick
      candle({ open: 99,  high: 100, low: 90,  close: 99.5, volume: 1000 }),
      // Forming candle (excluded)
      candle({ open: 99.5, high: 100, low: 99, close: 100,   volume: 100 }),
    ];
    const r = s.analyze(candles);
    assertShape(r, 'PinBar');
    assert.equal(r.signal, 'BUY', `expected BUY, got ${r.signal} (${r.reason})`);
  });

  test('fires SELL on a bearish pin bar (long upper wick, close in lower half)', () => {
    const s = new PinBarStrategy();
    const candles = [
      candle({ open: 100, high: 101, low: 99,  close: 100, volume: 1000 }),
      // Bearish pin: long upper wick, close near low
      candle({ open: 100.5, high: 110, low: 100, close: 100.5, volume: 1000 }),
      candle({ open: 100.5, high: 101, low: 100, close: 100.7, volume: 100 }),
    ];
    const r = s.analyze(candles);
    assertShape(r, 'PinBar');
    assert.equal(r.signal, 'SELL', `expected SELL, got ${r.signal} (${r.reason})`);
  });

  test('HOLD on a normal candle (no pin)', () => {
    const s = new PinBarStrategy();
    const candles = [
      candle({ open: 100, high: 102, low: 98,  close: 100, volume: 1000 }),
      candle({ open: 100, high: 105, low: 99,  close: 104, volume: 1000 }),
      candle({ open: 104, high: 105, low: 103, close: 104, volume: 100 }),
    ];
    const r = s.analyze(candles);
    assertShape(r, 'PinBar');
    assert.equal(r.signal, 'HOLD');
  });
});

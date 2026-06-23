/**
 * Shared Trader Utilities — Unit Tests
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcTrailingStop,
  calcBreakEven,
  calcExitSignal,
  calcATRStopPrices,
  calcPartialExit,
} from '../../src/executor/traderUtils.js';

describe('calcTrailingStop', () => {
  test('no trailing configured → no update', () => {
    const pos = { entryPrice: 100, highWaterMark: 105, stopLoss: 90 };
    assert.deepEqual(calcTrailingStop(pos, 110), { shouldUpdate: false });
  });

  test('price below entry → no update', () => {
    const pos = { entryPrice: 100, highWaterMark: 100, stopLoss: 90, trailingStopPct: 0.05 };
    assert.deepEqual(calcTrailingStop(pos, 95), { shouldUpdate: false });
  });

  test('price at new high → updates HWM and stop', () => {
    const pos = { entryPrice: 100, highWaterMark: 105, stopLoss: 95, trailingStopPct: 0.05 };
    const result = calcTrailingStop(pos, 120);
    assert.equal(result.shouldUpdate, true);
    assert.equal(result.newHighWaterMark, 120);
    assert.ok(result.newStopLoss > 95, 'new stop should be higher');
    // 120 * (1 - 0.05) = 114
    assert.equal(result.newStopLoss, 114);
  });

  test('price at new high but new stop not above old → HWM updated, no stop update', () => {
    const pos = { entryPrice: 100, highWaterMark: 105, stopLoss: 115, trailingStopPct: 0.05 };
    const result = calcTrailingStop(pos, 110);
    assert.equal(result.shouldUpdate, false);
    assert.equal(result.newHighWaterMark, 110);
  });
});

describe('calcBreakEven', () => {
  test('trigger pct is 0 → no trigger', () => {
    const pos = { entryPrice: 100, stopLoss: 90 };
    assert.deepEqual(calcBreakEven(pos, 110, 0), { shouldTrigger: false });
  });

  test('stop already above entry → no trigger', () => {
    const pos = { entryPrice: 100, stopLoss: 101 };
    assert.deepEqual(calcBreakEven(pos, 110, 0.05), { shouldTrigger: false });
  });

  test('price not yet at trigger level → no trigger', () => {
    const pos = { entryPrice: 100, stopLoss: 90 };
    assert.deepEqual(calcBreakEven(pos, 104, 0.05), { shouldTrigger: false });
  });

  test('price at trigger level → triggers break-even', () => {
    const pos = { entryPrice: 100, stopLoss: 90 };
    const result = calcBreakEven(pos, 105, 0.05);
    assert.equal(result.shouldTrigger, true);
    // 100 * 1.002 = 100.2
    assert.ok(Math.abs(result.newStopLoss - 100.2) < 0.001);
  });
});

describe('calcExitSignal', () => {
  test('price between SL and TP → no exit', () => {
    const pos = { stopLoss: 90, takeProfit: 120, initialStopLoss: 90 };
    assert.deepEqual(calcExitSignal(pos, 100), { shouldExit: false });
  });

  test('price hits stop loss → exit with stop_loss reason', () => {
    const pos = { stopLoss: 90, takeProfit: 120, initialStopLoss: 90 };
    const result = calcExitSignal(pos, 89);
    assert.equal(result.shouldExit, true);
    assert.equal(result.reason, 'stop_loss');
  });

  test('trailing stop triggered (SL moved above initial) → trailing_stop reason', () => {
    const pos = { stopLoss: 110, takeProfit: 130, initialStopLoss: 90, trailingStopPct: 0.05 };
    const result = calcExitSignal(pos, 109);
    assert.equal(result.shouldExit, true);
    assert.equal(result.reason, 'trailing_stop');
  });

  test('price hits take profit → exit', () => {
    const pos = { stopLoss: 90, takeProfit: 120, initialStopLoss: 90 };
    const result = calcExitSignal(pos, 121);
    assert.equal(result.shouldExit, true);
    assert.equal(result.reason, 'take_profit');
  });
});

describe('calcATRStopPrices', () => {
  test('returns null for missing/invalid atrPct', () => {
    assert.equal(calcATRStopPrices({ fillPrice: 100, atrPct: 0, slMultiplier: 1.5, tpMultiplier: 3 }), null);
    assert.equal(calcATRStopPrices({ fillPrice: 100, atrPct: -0.05, slMultiplier: 1.5, tpMultiplier: 3 }), null);
    assert.equal(calcATRStopPrices({ fillPrice: 100, atrPct: NaN, slMultiplier: 1.5, tpMultiplier: 3 }), null);
  });

  test('basic ATR-derived stops at moderate vol', () => {
    const r = calcATRStopPrices({
      fillPrice: 100, atrPct: 0.04, slMultiplier: 1.5, tpMultiplier: 3,
    });
    // SL pct = 4% × 1.5 = 6% → SL = 94
    // TP pct = 4% × 3   = 12% → TP = 112
    assert.equal(r.slPct, 0.06);
    assert.equal(r.tpPct, 0.12);
    assert.equal(r.stopLossPrice, 94);
    assert.equal(r.takeProfitPrice, 112);
  });

  test('low vol clamps SL to minSlPct', () => {
    const r = calcATRStopPrices({
      fillPrice: 100, atrPct: 0.005, slMultiplier: 1.5, tpMultiplier: 3,
      minSlPct: 0.02, maxSlPct: 0.12, minTpPct: 0.04, maxTpPct: 0.30,
    });
    // raw SL = 0.5% × 1.5 = 0.75% → clamped up to 2%
    assert.equal(r.slPct, 0.02);
    assert.equal(r.stopLossPrice, 98);
  });

  test('high vol clamps SL to maxSlPct', () => {
    const r = calcATRStopPrices({
      fillPrice: 100, atrPct: 0.20, slMultiplier: 1.5, tpMultiplier: 3,
      minSlPct: 0.02, maxSlPct: 0.12, minTpPct: 0.04, maxTpPct: 0.30,
    });
    // raw SL = 20% × 1.5 = 30% → clamped down to 12%
    assert.equal(r.slPct, 0.12);
    // raw TP = 20% × 3 = 60% → clamped down to 30%
    assert.equal(r.tpPct, 0.30);
  });
});

describe('calcPartialExit', () => {
  test('does not fire below trigger', () => {
    const pos = { entryPrice: 100, takeProfit: 112 };
    // 50% of TP target = 100 + 12 × 0.5 = 106
    assert.equal(calcPartialExit(pos, 105, 0.5, 0.5).shouldExit, false);
  });

  test('fires at trigger price', () => {
    const pos = { entryPrice: 100, takeProfit: 112 };
    const r = calcPartialExit(pos, 106, 0.5, 0.5);
    assert.equal(r.shouldExit, true);
    assert.equal(r.fraction, 0.5);
    assert.equal(r.triggerPrice, 106);
  });

  test('does not fire when partialExitDone is true (idempotent)', () => {
    const pos = { entryPrice: 100, takeProfit: 112, partialExitDone: true };
    assert.equal(calcPartialExit(pos, 110, 0.5, 0.5).shouldExit, false);
  });

  test('returns shouldExit=false for invalid fractions', () => {
    const pos = { entryPrice: 100, takeProfit: 112 };
    assert.equal(calcPartialExit(pos, 110, 0, 0.5).shouldExit, false);
    assert.equal(calcPartialExit(pos, 110, 1, 0.5).shouldExit, false);
    assert.equal(calcPartialExit(pos, 110, 0.5, 0).shouldExit, false);
    assert.equal(calcPartialExit(pos, 110, 0.5, 1).shouldExit, false);
  });

  test('returns shouldExit=false when TP <= entry (degenerate)', () => {
    const pos = { entryPrice: 100, takeProfit: 100 };
    assert.equal(calcPartialExit(pos, 200, 0.5, 0.5).shouldExit, false);
  });
});

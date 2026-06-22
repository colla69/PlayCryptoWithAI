import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  tradeReturnFraction, tradeReturns, sharpeOf, sharpeStdErr,
  computeLiveStats, evaluateDrift,
} from '../../src/monitor/driftMonitor.js';

describe('driftMonitor — return extraction', () => {
  test('prefers entry/exit price for per-trade return', () => {
    assert.equal(tradeReturnFraction({ side: 'SELL', entryPrice: 100, exitPrice: 110 }), 0.1);
  });

  test('falls back to pnl / pre-trade balance', () => {
    // pnl 50 on a post-trade balance of 1050 → pre-trade 1000 → +5%
    assert.equal(tradeReturnFraction({ side: 'SELL', pnl: 50, balance: 1050 }), 0.05);
  });

  test('returns null when no usable fields', () => {
    assert.equal(tradeReturnFraction({ side: 'SELL' }), null);
  });

  test('tradeReturns filters by window and to SELLs only', () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const trades = [
      { side: 'SELL', entryPrice: 100, exitPrice: 105, timestamp: now - 1 * day },   // in window
      { side: 'BUY',  entryPrice: 100, exitPrice: 105, timestamp: now - 1 * day },   // ignored (BUY)
      { side: 'SELL', entryPrice: 100, exitPrice: 90,  timestamp: now - 60 * day },  // out of window
    ];
    const rets = tradeReturns(trades, { windowDays: 30, nowMs: now });
    assert.deepEqual(rets, [0.05]);
  });
});

describe('driftMonitor — sharpe math', () => {
  test('sharpeOf returns 0 for <2 samples', () => {
    assert.equal(sharpeOf([0.05]), 0);
  });

  test('sharpeOf = mean/std', () => {
    const s = sharpeOf([0.02, 0.04, 0.06]); // mean 0.04, std 0.02 → 2.0
    assert.ok(Math.abs(s - 2.0) < 1e-9);
  });

  test('sharpeStdErr shrinks with n', () => {
    assert.ok(sharpeStdErr(1, 100) < sharpeStdErr(1, 10));
  });
});

describe('driftMonitor — evaluateDrift', () => {
  test('no alert when reference is null (log-only)', () => {
    const r = evaluateDrift({ liveSharpe: 0.1, refSharpe: null, nLive: 50 });
    assert.equal(r.alert, false);
    assert.match(r.reason, /no reference/);
  });

  test('no alert below minTrades even if divergent', () => {
    const r = evaluateDrift({ liveSharpe: -2, refSharpe: 1, nLive: 3, minTrades: 10 });
    assert.equal(r.alert, false);
    assert.match(r.reason, /not enough/);
  });

  test('alerts when live Sharpe diverges beyond 2 sigma', () => {
    // ref 1.0, n=40 → SE ≈ sqrt(1.5/40) ≈ 0.194; 2σ ≈ 0.39. live 0.0 → drift -1 → ~-5σ
    const r = evaluateDrift({ liveSharpe: 0.0, refSharpe: 1.0, nLive: 40 });
    assert.equal(r.alert, true);
    assert.ok(Math.abs(r.z) > 2);
  });

  test('no alert when live is close to reference', () => {
    const r = evaluateDrift({ liveSharpe: 0.95, refSharpe: 1.0, nLive: 40 });
    assert.equal(r.alert, false);
  });
});

describe('driftMonitor — computeLiveStats', () => {
  test('aggregates win rate, mean, and sharpe', () => {
    const now = Date.now();
    const trades = [
      { side: 'SELL', entryPrice: 100, exitPrice: 110, timestamp: now },
      { side: 'SELL', entryPrice: 100, exitPrice: 90,  timestamp: now },
      { side: 'SELL', entryPrice: 100, exitPrice: 105, timestamp: now },
    ];
    const s = computeLiveStats(trades, { windowDays: 30, nowMs: now });
    assert.equal(s.n, 3);
    assert.ok(Math.abs(s.winRate - 2 / 3) < 1e-9);
  });
});

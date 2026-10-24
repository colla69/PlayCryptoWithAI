/**
 * decisionCore — the entry gates and the asymmetric exit live and the backtester
 * share (plan 2026-10 single-engine rebuild, step 3). Both sides call these
 * functions; these tests pin their behaviour, liveParityInventory.test.js pins
 * that both sides call them.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEntryGates, resolveDecision } from '../../src/core/decisionCore.js';

const H12 = 12 * 60 * 60 * 1000;
const rising = (n, step = H12, pct = 0.01) => Array.from({ length: n }, (_, k) => {
  const open = 100 * (1 + pct) ** k;
  const close = open * (1 + pct);
  return { timestamp: k * step, open, high: close * 1.002, low: open * 0.998, close, volume: 100 };
});
const falling = (n, step = H12) => rising(n, step, -0.01);
const ALL_ON = {
  risk: { weeklyDDBreaker: { enabled: true, lossThreshold: 0.10, cooldownHours: 72 } },
  btcDominance: { enabled: true, blockThresholdPp: 1.0 },
  regime: { enabled: false },
  correlation: { enabled: true, threshold: 0.85 },
  mtfFilter: { enabled: true, alignBars: 16, minAlignScore: 0.3, reduceFactor: 0 },
  mtf4hFilter: { enabled: true, minScore: 0.45, lookback: 21 },
  momentumFilter: { enabled: true, minPct: 0, lookback: 20 },
};
const passing = () => ({
  symbol: 'ETH/USDC',
  config: ALL_ON,
  weeklyDD: { recentTrades: [], referenceEquity: 1000, nowMs: Date.UTC(2026, 0, 10) },
  btcDominance: { value: 60, sma7d: 60, deltaPct: 0 },
  candles: rising(60),
  correlation: { openPositions: [], matrix: {} },
  bars15m: rising(20, 15 * 60 * 1000),
  bars4h: rising(30, 4 * 60 * 60 * 1000),
});

describe('evaluateEntryGates', () => {
  test('passes when every gate is satisfied', () => {
    assert.deepEqual(evaluateEntryGates(passing()), { blockReason: null, gate: null, mtfSizeFactor: 1 });
  });

  test('each gate blocks with its own reason', () => {
    const cases = [
      ['weeklyDDBreaker', { weeklyDD: { recentTrades: [{ side: 'SELL', timestamp: Date.UTC(2026, 0, 9), pnl: -150 }], referenceEquity: 1000, nowMs: Date.UTC(2026, 0, 10) } }],
      ['btcDominance', { btcDominance: { value: 61.5, sma7d: 60, deltaPct: 1.5 } }],
      ['correlation', { correlation: { openPositions: [{ symbol: 'SOL/USDC' }], matrix: { 'ETH/USDC': { 'SOL/USDC': 0.95 }, 'SOL/USDC': { 'ETH/USDC': 0.95 } } } }],
      ['mtf', { bars15m: falling(20, 15 * 60 * 1000) }],
      ['mtf4h', { bars4h: falling(30, 4 * 60 * 60 * 1000) }],
      ['momentum', { candles: falling(60) }],
    ];
    for (const [gate, patch] of cases) {
      const r = evaluateEntryGates({ ...passing(), ...patch });
      assert.equal(r.gate, gate, gate);
      assert.ok(r.blockReason, `${gate} gives a reason`);
    }
  });

  test("reports the first block in live's order", () => {
    const r = evaluateEntryGates({
      ...passing(), bars15m: falling(20, 15 * 60 * 1000), bars4h: falling(30, 4 * 60 * 60 * 1000), candles: falling(60),
    });
    assert.equal(r.gate, 'mtf');
  });

  test('BTC itself is never blocked by the BTC.D gate', () => {
    const r = evaluateEntryGates({ ...passing(), symbol: 'BTC/USDC', btcDominance: { value: 70, sma7d: 60, deltaPct: 10 } });
    assert.equal(r.gate, null);
  });

  test('missing 15m / 4h data passes those gates, as a failed fetch does live', () => {
    assert.equal(evaluateEntryGates({ ...passing(), bars15m: null, bars4h: null }).gate, null);
    assert.equal(evaluateEntryGates({ ...passing(), bars15m: falling(10, 15 * 60 * 1000) }).gate, null, 'fewer than alignBars');
  });

  test('a misaligned 15m with reduceFactor shrinks the size instead of blocking', () => {
    const config = { ...ALL_ON, mtfFilter: { ...ALL_ON.mtfFilter, reduceFactor: 0.5 } };
    const r = evaluateEntryGates({ ...passing(), config, bars15m: falling(20, 15 * 60 * 1000) });
    assert.deepEqual(r, { blockReason: null, gate: null, mtfSizeFactor: 0.5 });
  });
});

describe('resolveDecision', () => {
  const base = { confidence: 0.4, sellVotes: 2, totalVotes: 3, held: true, minConfidence: 0.45 };

  test('a held HOLD with a SELL majority at ≥ 0.7× the threshold becomes SELL', () => {
    const r = resolveDecision({ ...base, decision: 'HOLD' });
    assert.equal(r.decision, 'SELL');
    assert.equal(r.asymmetricExit, true);
    assert.equal(r.sellThreshold, 0.45 * 0.7);
  });

  test('no change without a position, without a majority, below the bar, or on a non-HOLD', () => {
    assert.equal(resolveDecision({ ...base, decision: 'HOLD', held: false }).decision, 'HOLD');
    assert.equal(resolveDecision({ ...base, decision: 'HOLD', sellVotes: 1 }).decision, 'HOLD');
    assert.equal(resolveDecision({ ...base, decision: 'HOLD', confidence: 0.3 }).decision, 'HOLD');
    assert.equal(resolveDecision({ ...base, decision: 'BUY' }).decision, 'BUY');
  });
});

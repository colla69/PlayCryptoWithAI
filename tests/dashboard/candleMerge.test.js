/**
 * dashboardState.updateCandles — merge semantics.
 *
 * The in-memory series returned by getCandles() is what every strategy actually
 * analyses, so a stale bar here corrupts signals directly. The merge used to be
 * first-wins with the existing history placed first, which froze the forming
 * candle captured on one cycle and discarded its closed, corrected version on the
 * next. That is how live drifted away from the backtester (whose on-disk cache is
 * payload-wins) during the 2026-07 soak.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardState } from '../../src/dashboard/dashboardState.js';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-07-08T00:00:00Z');
const bar = (i, close, extra = {}) => ({
  timestamp: T0 + i * 12 * HOUR,
  open: close, high: close, low: close, close,
  volume: 100,
  ...extra,
});

/** A long history plus a short fresh window forces the merge path (not replacement). */
function seed(state, symbol, n = 30) {
  state.updateCandles(symbol, Array.from({ length: n }, (_, i) => bar(i, 100 + i)));
}

describe('updateCandles merge', () => {
  let state;
  beforeEach(() => { state = new DashboardState(); });

  test('a forming candle is corrected by the next fetch, not frozen', () => {
    seed(state, 'TIA/USDC');
    // Cycle 1 sees bar 30 while it is still forming (6h in, close 0.3954).
    state.updateCandles('TIA/USDC', [bar(29, 129), bar(30, 0.3954, { high: 0.40, volume: 12 })]);
    assert.equal(state.getCandles('TIA/USDC').at(-1).close, 0.3954);

    // Cycle 2, 12h later: the same bar has closed at 0.4047.
    state.updateCandles('TIA/USDC', [bar(30, 0.4047, { high: 0.41, volume: 88 }), bar(31, 0.41)]);

    const merged = state.getCandles('TIA/USDC');
    const corrected = merged.find((c) => c.timestamp === T0 + 30 * 12 * HOUR);
    assert.equal(corrected.close, 0.4047, 'closed candle must overwrite the partial snapshot');
    assert.equal(corrected.volume, 88, 'all fields must come from the fresh payload');
  });

  test('exchange payload wins on every overlapping timestamp', () => {
    seed(state, 'BTC/USDC');
    const revised = [bar(27, 999), bar(28, 998), bar(29, 997)];
    state.updateCandles('BTC/USDC', revised);

    const merged = state.getCandles('BTC/USDC');
    for (const r of revised) {
      assert.equal(
        merged.find((c) => c.timestamp === r.timestamp).close, r.close,
        `bar ${r.timestamp} kept the stale value`,
      );
    }
  });

  test('history outside the fresh window is preserved', () => {
    seed(state, 'ETH/USDC', 30);
    state.updateCandles('ETH/USDC', [bar(28, 500), bar(29, 501)]);

    const merged = state.getCandles('ETH/USDC');
    assert.equal(merged.length, 30, 'older bars must survive a short refresh');
    assert.equal(merged[0].close, 100, 'oldest bar untouched');
  });

  test('stays sorted and free of duplicates', () => {
    seed(state, 'SOL/USDC');
    state.updateCandles('SOL/USDC', [bar(31, 131), bar(29, 129), bar(30, 130)]);

    const merged = state.getCandles('SOL/USDC');
    const stamps = merged.map((c) => c.timestamp);
    assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b), 'must be ascending');
    assert.equal(new Set(stamps).size, stamps.length, 'must be deduplicated');
  });

  test('full replacement still applies when the payload is at least as long', () => {
    seed(state, 'ADA/USDC', 5);
    const fresh = Array.from({ length: 8 }, (_, i) => bar(i, 200 + i));
    state.updateCandles('ADA/USDC', fresh);

    const merged = state.getCandles('ADA/USDC');
    assert.equal(merged.length, 8);
    assert.equal(merged[0].close, 200);
  });

  test('ignores malformed input without disturbing history', () => {
    seed(state, 'XRP/USDC', 12);
    const before = state.getCandles('XRP/USDC');
    state.updateCandles('XRP/USDC', null);
    state.updateCandles(null, [bar(0, 1)]);
    assert.deepEqual(state.getCandles('XRP/USDC'), before);
  });
});

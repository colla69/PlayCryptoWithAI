/**
 * Exchange minimum-notional floor in the simulator.
 *
 * liveTrader rejects any BUY whose notional is under the exchange minimum. The
 * simulator did not, so backtests "filled" orders Binance would have refused —
 * which is why the 2026-06 deployment sweep reported an identical trade count
 * (90 / 116) at every position size. Both now read the same constant from
 * src/exchange/exchangeLimits.js.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';
import { FALLBACK_MIN_NOTIONAL, resolveMinNotional } from '../../src/exchange/exchangeLimits.js';

const sim = (overrides = {}) => new BacktestSimulator({
  initialBalance: 1000, stopLossPct: 0.05, takeProfitPct: 0.12,
  feePct: 0, slippagePct: 0, ...overrides,
});

describe('resolveMinNotional', () => {
  test('never returns less than our own floor', () => {
    assert.equal(resolveMinNotional({ minNotional: 5 }), FALLBACK_MIN_NOTIONAL);
    assert.equal(resolveMinNotional(undefined), FALLBACK_MIN_NOTIONAL);
    assert.equal(resolveMinNotional({}), FALLBACK_MIN_NOTIONAL);
  });

  test('honours a stricter exchange minimum', () => {
    assert.equal(resolveMinNotional({ minNotional: 25 }), 25);
  });
});

describe('simulator min-notional floor', () => {
  test('rejects a BUY below the floor and counts it', () => {
    const s = sim();
    // 1000 x 0.005 = $5 — under $11.
    const r = s.execute('BTC/USDC', 'BUY', 100, { positionPct: 0.005 });
    assert.equal(r, null, 'order under the floor must not fill');
    assert.equal(s.positions.size, 0);
    assert.equal(s.minNotionalRejections, 1, 'rejection must be counted, not swallowed');
    assert.equal(s.balance, 1000, 'balance untouched by a rejected order');
  });

  test('fills a BUY at or above the floor', () => {
    const s = sim();
    s.execute('BTC/USDC', 'BUY', 100, { positionPct: 0.02 }); // $20
    assert.equal(s.positions.size, 1);
    assert.equal(s.minNotionalRejections, 0);
  });

  test('the boundary is inclusive', () => {
    const s = sim({ initialBalance: 1100 });
    s.execute('BTC/USDC', 'BUY', 100, { positionPct: 0.01 }); // exactly $11
    assert.equal(s.positions.size, 1, '$11 must be accepted, not rejected');
  });

  test('defaults to the shared constant', () => {
    assert.equal(sim().minNotional, FALLBACK_MIN_NOTIONAL);
  });

  test('research override can disable the floor', () => {
    const s = sim({ minNotional: 0 });
    s.execute('BTC/USDC', 'BUY', 100, { positionPct: 0.005 }); // $5
    assert.equal(s.positions.size, 1, 'minNotional:0 models a frictionless exchange');
    assert.equal(s.minNotionalRejections, 0);
  });

  test('a small account loses trades a large one keeps — the effect the old sim hid', () => {
    const small = sim({ initialBalance: 150 });
    const large = sim({ initialBalance: 1000 });
    for (const s of [small, large]) s.execute('BTC/USDC', 'BUY', 100, { positionPct: 0.05 });

    assert.equal(small.positions.size, 0, '$7.50 is under the floor');
    assert.equal(large.positions.size, 1, '$50 clears it');
    assert.equal(small.minNotionalRejections, 1);
  });
});

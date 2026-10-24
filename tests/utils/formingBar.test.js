/**
 * withFormingBar() — live must decide on the same closed bars whether or not the
 * exchange has printed the new bar yet (follow-ups plan, item 5).
 *
 * The 2026-10 live reconciliation found 36 signals where a thin pair had no new bar
 * 3–5 s after the close: the series ended at the bar that just closed, every strategy
 * dropped it as "forming", and live decided one bar late. The parity cases below
 * prove that "closed bars + placeholder" gives exactly what "closed bars + the real
 * forming bar" gives, for every strategy and for the live aggregator.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { withFormingBar } from '../../src/utils/formingBar.js';
import SignalAggregator from '../../src/engine/signalAggregator.js';
import { buildStrategiesForSymbol, getSignalConfigForSymbol } from '../../src/utils/strategyBuilder.js';
import * as strategies from '../../src/strategies/index.js';

const H12 = 12 * 60 * 60 * 1000;
const OPEN = Date.UTC(2026, 9, 8, 0, 0, 0); // a 12h period open
const NOW = OPEN + 4_000;                   // the cycle, 4 s after the close

/** Deterministic random-walk 12h series whose last bar opens at OPEN (the forming bar). */
function series(n = 400, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2 ** 31; return s / 2 ** 31; };
  const out = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open * (1 + (rnd() - 0.5) * 0.06);
    const high = Math.max(open, close) * (1 + rnd() * 0.02);
    const low = Math.min(open, close) * (1 - rnd() * 0.02);
    out.push({ timestamp: OPEN - (n - 1 - i) * H12, open, high, low, close, volume: 1000 + rnd() * 5000 });
    price = close;
  }
  return out;
}

describe('withFormingBar', () => {
  test('leaves a series that already has the forming bar unchanged', () => {
    const full = series();
    assert.equal(withFormingBar(full, '12h', NOW), full);
  });

  test('adds a flat placeholder when the newest bar is the one that just closed', () => {
    const closedOnly = series().slice(0, -1);
    const before = closedOnly.length;
    const out = withFormingBar(closedOnly, '12h', NOW);
    assert.equal(closedOnly.length, before, 'input must not be changed');
    assert.equal(out.length, before + 1);
    const p = out.at(-1);
    assert.equal(p.timestamp, OPEN);
    assert.equal(p.placeholder, true);
    assert.equal(p.close, closedOnly.at(-1).close);
    assert.equal(p.high, p.low);
  });

  test('does not hide a gap: a newest bar two periods old is left alone', () => {
    const twoLate = series().slice(0, -2);
    assert.equal(withFormingBar(twoLate, '12h', NOW), twoLate);
  });

  test('passes through empty input and an unknown timeframe', () => {
    assert.deepEqual(withFormingBar([], '12h', NOW), []);
    const closedOnly = series().slice(0, -1);
    assert.equal(withFormingBar(closedOnly, 'bogus', NOW), closedOnly);
  });
});

describe('placeholder ≡ real forming bar (every strategy drops the last bar)', () => {
  const full = series();
  const patched = withFormingBar(full.slice(0, -1), '12h', NOW);

  for (const [name, Strategy] of Object.entries(strategies)) {
    if (typeof Strategy !== 'function' || !name.endsWith('Strategy')) continue;
    test(`${name} gives the same result`, () => {
      const a = new Strategy({}).analyze(full);
      const b = new Strategy({}).analyze(patched);
      assert.deepEqual(b, a);
    });
  }

  test('the live aggregator decides the same for every configured symbol', () => {
    for (const symbol of config.symbols) {
      const signalConfig = getSignalConfigForSymbol(symbol, config.signals);
      const a = new SignalAggregator(buildStrategiesForSymbol(symbol), signalConfig).aggregate(full, symbol, signalConfig);
      const b = new SignalAggregator(buildStrategiesForSymbol(symbol), signalConfig).aggregate(patched, symbol, signalConfig);
      assert.equal(b.decision, a.decision, symbol);
      assert.equal(b.confidence, a.confidence, symbol);
    }
  });

  test('without the placeholder the decision input really shifts (the bug this fixes)', () => {
    const closedOnly = full.slice(0, -1);
    const differs = Object.entries(strategies)
      .filter(([n, S]) => typeof S === 'function' && n.endsWith('Strategy'))
      .some(([, S]) => JSON.stringify(new S({}).analyze(closedOnly)) !== JSON.stringify(new S({}).analyze(full)));
    assert.ok(differs, 'expected at least one strategy to change when the just-closed bar is dropped');
  });
});

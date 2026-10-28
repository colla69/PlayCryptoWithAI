import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';

// The user's rule: no trade's stop sits more than 10% below entry. The SL/TP × 1.5 retune
// (`4b2f365`) pushed 18 traded coins to 10.5% and TRX to 18% without anyone noticing; this
// fails on the next widening instead (plan doc § I/I2).
const MAX_STOP = 0.10;

function stopsIn(node, path = 'config', out = []) {
  if (!node || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    const p = `${path}.${k}`;
    if ((k === 'stopLossPct' || k === 'maxStopPct') && typeof v === 'number') out.push([p, v]);
    else stopsIn(v, p, out);
  }
  return out;
}

test('no configured stop is more than 10% below entry', () => {
  const stops = stopsIn(config);
  assert.ok(stops.length > 37, `expected the global, per-symbol and satellite stops, found ${stops.length}`);
  const tooWide = stops.filter(([, v]) => !(v > 0 && v <= MAX_STOP));
  assert.deepEqual(tooWide, [], 'stops wider than the 10% rule (or not positive)');
});

test('every traded symbol resolves to a stop within the rule', () => {
  for (const sym of config.symbols) {
    const sl = config.perSymbol?.[sym]?.stopLossPct ?? config.risk.stopLossPct;
    assert.ok(sl > 0 && sl <= MAX_STOP, `${sym}: stop ${sl}`);
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeGauges, gaugesAsOf, revisionStats } from '../../src/backtester/gaugeSnapshots.js';

const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const series = (n, f) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, ...f(i) }));

test('exchangeGauges: 30-day supply change and 7-day net inflow of the newest row', () => {
  const rows = series(31, (i) => ({ sply: 100 + i, fin: 10, fout: i >= 24 ? 12 : 10 }));
  const g = exchangeGauges(rows);
  assert.equal(g.t, T0 + 30 * DAY);
  assert.ok(Math.abs(g.d30 - (130 / 100 - 1)) < 1e-12);
  assert.equal(g.net7, -14); // last 7 rows each net −2
});

test('exchangeGauges: null gauges when the window is incomplete', () => {
  const g = exchangeGauges(series(5, () => ({ sply: 1, fin: 1, fout: 0 })));
  assert.equal(g.d30, null);
  assert.equal(g.net7, null);
  assert.equal(exchangeGauges([]), null);
});

test('gaugesAsOf: uses the newest snapshot at or before t, never a later one', () => {
  const early = { recordedAt: T0 + 40 * DAY, rows: series(31, () => ({ sply: 100, fin: 1, fout: 0 })) };
  const late = { recordedAt: T0 + 41 * DAY, rows: series(31, () => ({ sply: 100, fin: 0, fout: 1 })) };
  const snaps = [early, late];
  assert.equal(gaugesAsOf(snaps, T0 + 40.5 * DAY).net7, 7);
  assert.equal(gaugesAsOf(snaps, T0 + 41 * DAY).net7, -7);
  assert.equal(gaugesAsOf(snaps, T0 + 39 * DAY), null);
});

test('gaugesAsOf: a missed recording is a gap, not a stale value', () => {
  const snaps = [{ recordedAt: T0, rows: series(31, () => ({ sply: 1, fin: 0, fout: 0 })) }];
  assert.notEqual(gaugesAsOf(snaps, T0 + 2 * DAY), null);
  assert.equal(gaugesAsOf(snaps, T0 + 2 * DAY + 1), null);
});

test('revisionStats: largest relative change from the first published value', () => {
  const a = { recordedAt: T0, rows: [{ t: T0, sply: 100, fin: 10, fout: 10 }] };
  const b = { recordedAt: T0 + DAY, rows: [{ t: T0, sply: 103, fin: 10, fout: 8 }, { t: T0 + DAY, sply: 1, fin: 1, fout: 1 }] };
  const r = revisionStats([a, b]);
  assert.equal(r.comparisons, 1);
  assert.ok(Math.abs(r.maxRelChange.sply - 0.03) < 1e-12);
  assert.ok(Math.abs(r.maxRelChange.fout - 0.2) < 1e-12);
  assert.equal(r.maxRelChange.fin, 0);
});

/**
 * NASDAQ trend feed — pure risk-off computation for the TSM core macro overlay.
 * Covers EMA trend detection, the 24h availability lag (no lookahead on daily
 * closes), and neutral behavior on missing/short data.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeEquityRiskOff } from '../../src/data/nasdaqTrend.js';

const DAY = 86_400_000;
const rows = (values) => values.map((v, i) => ({ t: i * DAY, v }));

describe('nasdaqTrend: computeEquityRiskOff', () => {
  test('rising market → risk-on (above EMA)', () => {
    const r = rows(Array.from({ length: 150 }, (_, i) => 100 + i));
    const out = computeEquityRiskOff(r, { emaDays: 100, asOfMs: 151 * DAY });
    assert.equal(out.available, true);
    assert.equal(out.above, true);
  });

  test('falling market → risk-off (below EMA)', () => {
    const r = rows(Array.from({ length: 150 }, (_, i) => 300 - i));
    const out = computeEquityRiskOff(r, { emaDays: 100, asOfMs: 151 * DAY });
    assert.equal(out.available, true);
    assert.equal(out.above, false);
  });

  test('24h lag: today\'s close is invisible until tomorrow', () => {
    const r = rows([...Array.from({ length: 149 }, (_, i) => 100 + i), 1]); // crash on the last day
    const tLast = 149 * DAY;
    const before = computeEquityRiskOff(r, { emaDays: 100, asOfMs: tLast + DAY / 2 });
    assert.equal(before.above, true, 'crash row not yet visible');
    const after = computeEquityRiskOff(r, { emaDays: 100, asOfMs: tLast + DAY + 1 });
    assert.equal(after.above, false, 'crash row visible next day');
  });

  test('short or missing data → unavailable, neutral above=true', () => {
    assert.equal(computeEquityRiskOff(rows([1, 2, 3]), { emaDays: 100, asOfMs: 10 * DAY }).available, false);
    assert.equal(computeEquityRiskOff(null, { emaDays: 100 }).available, false);
    assert.equal(computeEquityRiskOff(null, { emaDays: 100 }).above, true);
  });
});

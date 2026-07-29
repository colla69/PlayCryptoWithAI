/**
 * Candle-freshness guard.
 *
 * Locks in the behaviour that was missing during the 2026-07 soak: thin or
 * delisted markets (LSK, TON, GMX) kept returning klines that never advanced,
 * and the live loop fed those frozen bars to the aggregator for weeks because
 * it only checked for an EMPTY fetch.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  timeframeMs, candleSeriesAgeMs, checkCandleFreshness, formatAge,
} from '../../src/utils/candleFreshness.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-29T00:00:03Z');

/** Series whose newest bar closed `ageMs` before NOW. */
const seriesEndingAt = (ageMs) => [
  { timestamp: NOW - ageMs - 12 * HOUR, close: 1 },
  { timestamp: NOW - ageMs, close: 1 },
];

describe('timeframeMs', () => {
  test('parses the timeframes the bot uses', () => {
    assert.equal(timeframeMs('15m'), 900_000);
    assert.equal(timeframeMs('4h'), 4 * HOUR);
    assert.equal(timeframeMs('12h'), 12 * HOUR);
    assert.equal(timeframeMs('1d'), 24 * HOUR);
    assert.equal(timeframeMs('1w'), 7 * 24 * HOUR);
  });

  test('returns null for junk rather than guessing', () => {
    for (const bad of ['', '12', 'h', '0h', '12x', null, undefined, '-3h']) {
      assert.equal(timeframeMs(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
  });
});

describe('candleSeriesAgeMs', () => {
  test('measures from the newest bar', () => {
    assert.equal(candleSeriesAgeMs(seriesEndingAt(5 * HOUR), NOW), 5 * HOUR);
  });

  test('returns null for empty or timestamp-less series', () => {
    assert.equal(candleSeriesAgeMs([], NOW), null);
    assert.equal(candleSeriesAgeMs(undefined, NOW), null);
    assert.equal(candleSeriesAgeMs([{ close: 1 }], NOW), null);
  });
});

describe('checkCandleFreshness', () => {
  test('a forming candle at candle-close+3s is fresh', () => {
    // The normal live case: cycle fires 3 s after the boundary, newest bar is
    // the just-opened one.
    const { stale } = checkCandleFreshness(seriesEndingAt(3_000), '12h', 2, NOW);
    assert.equal(stale, false);
  });

  test('a not-yet-published forming bar (1 period old) is still fresh', () => {
    const { stale, agePeriods } = checkCandleFreshness(seriesEndingAt(12 * HOUR), '12h', 2, NOW);
    assert.equal(stale, false);
    assert.equal(agePeriods, 1);
  });

  test('exactly at the limit is not stale; past it is', () => {
    assert.equal(checkCandleFreshness(seriesEndingAt(24 * HOUR), '12h', 2, NOW).stale, false);
    assert.equal(checkCandleFreshness(seriesEndingAt(24 * HOUR + 1), '12h', 2, NOW).stale, true);
  });

  test('flags the real frozen series from the 2026-07 soak', () => {
    // TON stopped advancing 2026-06-30; the bot kept scoring it every cycle.
    const tonAge = NOW - Date.parse('2026-06-30T00:00:00Z');
    const { stale, agePeriods } = checkCandleFreshness(seriesEndingAt(tonAge), '12h', 2, NOW);
    assert.equal(stale, true);
    assert.ok(agePeriods > 50, `expected a badly stale series, got ${agePeriods} periods`);
  });

  test('never invents a block for empty series or unknown timeframes', () => {
    // Callers handle "no candles" separately — this must not double-report.
    assert.equal(checkCandleFreshness([], '12h', 2, NOW).stale, false);
    assert.equal(checkCandleFreshness(seriesEndingAt(999 * HOUR), 'nonsense', 2, NOW).stale, false);
  });

  test('falls back to 2 periods when maxPeriods is missing or nonsensical', () => {
    for (const bad of [undefined, null, 0, -1, NaN]) {
      assert.equal(
        checkCandleFreshness(seriesEndingAt(36 * HOUR), '12h', bad, NOW).stale, true,
        `expected default limit to apply for ${String(bad)}`,
      );
    }
  });

  test('scales with the timeframe', () => {
    // 90 min is fresh on 12h candles but long stale on 15m ones.
    assert.equal(checkCandleFreshness(seriesEndingAt(90 * 60_000), '12h', 2, NOW).stale, false);
    assert.equal(checkCandleFreshness(seriesEndingAt(90 * 60_000), '15m', 2, NOW).stale, true);
  });
});

describe('formatAge', () => {
  test('renders human-readable ages', () => {
    assert.equal(formatAge(3 * 86_400_000), '3.0d');
    assert.equal(formatAge(5 * HOUR), '5.0h');
    assert.equal(formatAge(12 * 60_000), '12m');
    assert.equal(formatAge(null), 'unknown');
  });
});

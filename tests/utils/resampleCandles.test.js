/**
 * 4h → 12h resampling.
 *
 * Rebuilding deep 12h history from the 4h caches is only defensible if the
 * aggregation is exact — Binance serves ~390 days of 12h klines for these USDC
 * pairs but the 4h series reaches 2020. A wrong bucket boundary or a partial
 * bucket would silently corrupt every indicator computed from the result.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resampleCandles, diffAgainstActual } from '../../src/utils/resampleCandles.js';

const H = 3_600_000;
const T0 = Date.parse('2026-07-01T00:00:00Z'); // on the 12h grid

const bar = (ts, o, h, l, c, v = 10) => ({ timestamp: ts, open: o, high: h, low: l, close: c, volume: v });

/** Three 4h bars covering one 12h bucket starting at `start`. */
const bucket = (start, specs) => specs.map((s, i) => bar(start + i * 4 * H, ...s));

describe('resampleCandles 4h → 12h', () => {
  test('aggregates OHLCV correctly', () => {
    const src = bucket(T0, [
      [100, 110, 95, 105, 10],
      [105, 130, 100, 120, 20],
      [120, 125, 90, 115, 30],
    ]);
    const { candles, dropped } = resampleCandles(src, '4h', '12h');

    assert.equal(candles.length, 1);
    assert.equal(dropped, 0);
    assert.deepEqual(candles[0], {
      timestamp: T0,
      open: 100,   // first bar's open
      high: 130,   // max across the bucket
      low: 90,     // min across the bucket
      close: 115,  // last bar's close
      volume: 60,  // sum
    });
  });

  test('buckets align to the 00:00 / 12:00 UTC grid', () => {
    const src = [...bucket(T0, [[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]),
                 ...bucket(T0 + 12 * H, [[4, 4, 4, 4], [5, 5, 5, 5], [6, 6, 6, 6]])];
    const { candles } = resampleCandles(src, '4h', '12h');

    assert.deepEqual(candles.map((c) => new Date(c.timestamp).toISOString()), [
      '2026-07-01T00:00:00.000Z',
      '2026-07-01T12:00:00.000Z',
    ]);
    assert.equal(candles[0].close, 3);
    assert.equal(candles[1].open, 4);
  });

  test('drops an incomplete bucket rather than emitting a wrong bar', () => {
    // Only 2 of the 3 bars for the second bucket — e.g. mid-formation tail.
    const src = [...bucket(T0, [[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]),
                 bar(T0 + 12 * H, 4, 4, 4, 4), bar(T0 + 16 * H, 5, 9, 5, 5)];
    const { candles, dropped } = resampleCandles(src, '4h', '12h');

    assert.equal(candles.length, 1, 'partial bucket must not produce a candle');
    assert.equal(dropped, 2);
    assert.equal(candles[0].timestamp, T0);
  });

  test('handles unsorted input', () => {
    const src = bucket(T0, [[1, 1, 1, 1], [2, 9, 0, 2], [3, 3, 3, 3]]).reverse();
    const { candles } = resampleCandles(src, '4h', '12h');
    assert.equal(candles[0].open, 1, 'open must come from the earliest bar');
    assert.equal(candles[0].close, 3, 'close must come from the latest bar');
    assert.equal(candles[0].high, 9);
    assert.equal(candles[0].low, 0);
  });

  test('rejects conversions that are not whole multiples or not coarser', () => {
    assert.throws(() => resampleCandles([], '4h', '4h'), /coarser/);
    assert.throws(() => resampleCandles([], '12h', '4h'), /coarser/);
    assert.throws(() => resampleCandles([], '1h', '90m'), /unparseable|whole multiple/);
    assert.throws(() => resampleCandles([], 'bogus', '12h'), /unparseable/);
  });

  test('empty input yields empty output', () => {
    assert.deepEqual(resampleCandles([], '4h', '12h'), { candles: [], dropped: 0 });
  });
});

describe('diffAgainstActual', () => {
  const resampled = [bar(T0, 100, 130, 90, 115, 60)];

  test('reports no mismatch when the aggregate matches the exchange', () => {
    const { compared, mismatches } = diffAgainstActual(resampled, [bar(T0, 100, 130, 90, 115, 60)]);
    assert.equal(compared, 1);
    assert.deepEqual(mismatches, []);
  });

  test('flags an OHLC divergence with the offending field', () => {
    const { mismatches } = diffAgainstActual(resampled, [bar(T0, 100, 131, 90, 115, 60)]);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].field, 'high');
    assert.equal(mismatches[0].actual, 131);
  });

  test('ignores timestamps with no counterpart', () => {
    const { compared, mismatches } = diffAgainstActual(resampled, [bar(T0 + 12 * H, 1, 1, 1, 1, 1)]);
    assert.equal(compared, 0, 'non-overlapping bars are not comparable');
    assert.deepEqual(mismatches, []);
  });

  test('tolerates exchange volume rounding but catches real divergence', () => {
    assert.deepEqual(diffAgainstActual(resampled, [bar(T0, 100, 130, 90, 115, 60.00000001)]).mismatches, []);
    assert.equal(diffAgainstActual(resampled, [bar(T0, 100, 130, 90, 115, 66)]).mismatches[0].field, 'volume');
  });
});

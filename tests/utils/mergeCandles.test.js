/**
 * mergeCandles — the shared payload-wins merge, plus the guard that keeps it
 * shared.
 *
 * Getting the merge direction wrong has silently corrupted the candle series
 * four times, each in a separately hand-rolled merge. The behavioural tests
 * below pin the direction; the structural test at the bottom is the one that
 * matters long-term, because it fails when someone writes a FIFTH copy instead
 * of calling this function.
 *
 * The 2026-08-10 instance: initializeHistoricalData merged the startup fetch
 * into the disk cache with `fresh.filter((c) => !seen.has(c.timestamp))` —
 * first-wins. Because the seed also re-persists what it loaded, every boot
 * re-froze the previous boot's still-forming bar. 36 of 37 symbols carried
 * frozen 12h bars on the restart dates 2026-07-02 / 07-29 / 07-30; BTC's
 * 07-29 12:00 bar held a low of 64157.23 against a true 63203.28.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { mergeCandles, CANDLE_WINDOW } from '../../src/utils/mergeCandles.js';

const T0 = Date.parse('2026-07-29T00:00:00Z');
const HALF_DAY = 43_200_000;
const bar = (i, close, extra = {}) => ({
  timestamp: T0 + i * HALF_DAY,
  open: close, high: close, low: close, close, volume: 100, ...extra,
});

describe('mergeCandles — payload wins', () => {
  test('the exchange copy replaces a frozen partial bar', () => {
    // What a boot persisted: bar 2 captured seconds after it opened.
    const cached = [bar(0, 100), bar(1, 101), bar(2, 64168.50, { low: 64157.23, volume: 146 })];
    // What the exchange returns once it has closed.
    const fresh = [bar(2, 63921.05, { low: 63203.28, volume: 3032 }), bar(3, 63900)];

    const merged = mergeCandles(cached, fresh);
    const corrected = merged.find((c) => c.timestamp === T0 + 2 * HALF_DAY);

    assert.equal(corrected.close, 63921.05, 'closed bar must overwrite the partial one');
    assert.equal(corrected.low, 63203.28, 'every field comes from the payload, not just close');
    assert.equal(corrected.volume, 3032);
  });

  test('history outside the payload window survives', () => {
    const cached = Array.from({ length: 40 }, (_, i) => bar(i, 100 + i));
    const merged = mergeCandles(cached, [bar(39, 999), bar(40, 1000)]);

    assert.equal(merged.length, 41);
    assert.equal(merged[0].close, 100, 'oldest bar untouched');
    assert.equal(merged.at(-1).close, 1000);
  });

  test('output is ascending and deduplicated regardless of input order', () => {
    const merged = mergeCandles([bar(3, 1), bar(1, 2)], [bar(2, 3), bar(0, 4), bar(3, 5)]);
    const stamps = merged.map((c) => c.timestamp);

    assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));
    assert.equal(new Set(stamps).size, stamps.length);
    assert.equal(merged.at(-1).close, 5, 'payload wins even when it arrives out of order');
  });

  test('trims to the window, keeping the newest bars', () => {
    const cached = Array.from({ length: CANDLE_WINDOW + 50 }, (_, i) => bar(i, i));
    const merged = mergeCandles(cached, []);

    assert.equal(merged.length, CANDLE_WINDOW);
    assert.equal(merged.at(-1).close, CANDLE_WINDOW + 49, 'newest kept');
  });

  test('cap 0 disables trimming', () => {
    const cached = Array.from({ length: CANDLE_WINDOW + 10 }, (_, i) => bar(i, i));
    assert.equal(mergeCandles(cached, [], { cap: 0 }).length, CANDLE_WINDOW + 10);
  });

  test('tolerates malformed input without dropping good bars', () => {
    const merged = mergeCandles(
      [bar(0, 1), null, { timestamp: 'nope' }],
      [bar(1, 2), undefined, { close: 5 }],
    );
    assert.equal(merged.length, 2);
  });

  test('either side missing is not an error', () => {
    assert.deepEqual(mergeCandles(null, null), []);
    assert.equal(mergeCandles(undefined, [bar(0, 1)]).length, 1);
    assert.equal(mergeCandles([bar(0, 1)], undefined).length, 1);
  });
});

/**
 * The structural guard. Every previous break was a hand-rolled merge that looked
 * fine in review, so assert on the call sites rather than the behaviour.
 */
describe('no candle merge may be hand-rolled', () => {
  const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
  const MERGE_SITES = ['src/main.js', 'src/dashboard/dashboardState.js'];

  for (const file of MERGE_SITES) {
    test(`${file} merges through the shared helper`, () => {
      assert.match(
        read(file), /mergeCandles\(/,
        `${file} combines candle series and must call mergeCandles() — a local `
        + 'merge is how this bug returned four times.',
      );
    });

    test(`${file} contains no first-wins timestamp filter`, () => {
      const src = read(file);
      // The exact shape of the 2026-08-10 bug: drop payload bars already seen.
      assert.doesNotMatch(
        src, /\.filter\(\s*\(?\s*c\w*\s*\)?\s*=>\s*!\s*seen\.has\(/,
        `${file} filters out already-seen timestamps — that is first-wins, and it `
        + 'discards the exchange\'s corrected copy of a still-forming bar.',
      );
    });
  }
});

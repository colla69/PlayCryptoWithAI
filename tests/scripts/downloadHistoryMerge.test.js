/**
 * downloadHistory merge semantics.
 *
 * The fifth instance of this codebase's recurring first-wins bug, and the one
 * that corrupted the research data itself rather than a live decision.
 *
 * The downloader appended only timestamps it had never seen, so the LAST cached
 * bar — still forming when it was written — was frozen permanently and the
 * exchange's corrected version was discarded on every later run. BTC's
 * 2026-06-24 04:00 4h bar sat at close 62839.11 while the next bar opened at
 * 62591.50 (a break in the open/close chain found nowhere else) with ~40% of its
 * true volume, until `--repair` re-fetched it.
 *
 * The merge itself is exercised here as a pure function; the script is a
 * top-level await CLI and is not importable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const H = 3_600_000;
const bar = (ts, close, volume) => ({ timestamp: ts, open: close, high: close, low: close, close, volume });

/** The merge downloadHistory.js performs (payload-wins), extracted verbatim. */
function mergeDownloaded(cached, fresh, cutoff = 0) {
  const byTimestamp = new Map();
  for (const c of cached) byTimestamp.set(c.timestamp, c);
  let corrected = 0;
  for (const c of fresh) {
    if (byTimestamp.has(c.timestamp)) corrected++;
    byTimestamp.set(c.timestamp, c);
  }
  const merged = [...byTimestamp.values()]
    .filter((c) => c.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
  return { merged, corrected, added: fresh.length - corrected };
}

describe('downloadHistory merge', () => {
  test('the exchange payload overwrites a frozen partial bar', () => {
    // Reproduces the real BTC 4h case.
    const cached = [bar(0, 62664.09, 355.02), bar(4 * H, 62839.11, 229.22)]; // 2nd was mid-formation
    const fresh = [bar(4 * H, 62591.49, 585.93), bar(8 * H, 62851.95, 553.84)];

    const { merged, corrected, added } = mergeDownloaded(cached, fresh);
    const repaired = merged.find((c) => c.timestamp === 4 * H);

    assert.equal(repaired.close, 62591.49, 'closed bar must replace the partial snapshot');
    assert.equal(repaired.volume, 585.93);
    assert.equal(corrected, 1);
    assert.equal(added, 1);
  });

  test('history outside the fetched window is preserved', () => {
    const cached = [bar(0, 1, 1), bar(4 * H, 2, 2), bar(8 * H, 3, 3)];
    const { merged } = mergeDownloaded(cached, [bar(12 * H, 4, 4)]);

    assert.equal(merged.length, 4);
    assert.equal(merged[0].close, 1, 'oldest bar untouched');
  });

  test('stays sorted and deduplicated regardless of input order', () => {
    const { merged } = mergeDownloaded([bar(8 * H, 3, 3), bar(0, 1, 1)], [bar(4 * H, 2, 2), bar(0, 9, 9)]);
    const stamps = merged.map((c) => c.timestamp);

    assert.deepEqual(stamps, [0, 4 * H, 8 * H]);
    assert.equal(merged[0].close, 9, 'payload still wins on an out-of-order collision');
  });

  test('the retention cutoff drops only bars older than it', () => {
    const cached = [bar(0, 1, 1), bar(4 * H, 2, 2), bar(8 * H, 3, 3)];
    const { merged } = mergeDownloaded(cached, [], 4 * H);

    assert.deepEqual(merged.map((c) => c.timestamp), [4 * H, 8 * H]);
  });

  test('an empty payload leaves the cache intact', () => {
    const cached = [bar(0, 1, 1), bar(4 * H, 2, 2)];
    const { merged, corrected, added } = mergeDownloaded(cached, []);

    assert.equal(merged.length, 2);
    assert.equal(corrected, 0);
    assert.equal(added, 0);
  });
});

/**
 * Candle cache — merge-preserving save.
 *
 * Regression for a real incident: the trading loop persists its capped
 * in-memory window (~2500 bars); a blind overwrite truncated the 6-year 12h
 * research backfill on a paper boot. saveCachedCandles must keep disk bars
 * older than the payload while letting the payload win from its start onward.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { saveCachedCandles, loadCachedCandles } from '../../src/exchange/candleCache.js';

const SYM = 'TESTCACHE/XX';
const FILE = new URL('../../data/candles/TESTCACHE_XX_12h.json', import.meta.url);
const mk = (ts, close = 1) => ({ timestamp: ts, open: 1, high: 1, low: 1, close, volume: 0 });

describe('candleCache: merge-preserving save', () => {
  after(async () => { await fs.rm(FILE, { force: true }); });

  test('capped re-save does not truncate older disk history', async () => {
    await fs.rm(FILE, { force: true });
    const deep = Array.from({ length: 100 }, (_, i) => mk(i * 1000));
    await saveCachedCandles(SYM, '12h', deep);

    // Bot-style save: only the last 10 bars survive the in-memory cap, plus 2 fresh ones
    const capped = [...deep.slice(-10), mk(100_000), mk(101_000)];
    await saveCachedCandles(SYM, '12h', capped);

    const merged = await loadCachedCandles(SYM, '12h');
    assert.equal(merged.length, 102, 'older history preserved + fresh appended');
    assert.equal(merged[0].timestamp, 0);
    assert.equal(merged.at(-1).timestamp, 101_000);
    for (let i = 1; i < merged.length; i++) {
      assert.ok(merged[i].timestamp > merged[i - 1].timestamp, 'strictly increasing, no seam dupes');
    }
  });

  test('overlapping payload wins over stale disk bars', async () => {
    await fs.rm(FILE, { force: true });
    await saveCachedCandles(SYM, '12h', [mk(0), mk(1000), mk(2000)]);
    await saveCachedCandles(SYM, '12h', [mk(1000, 9), mk(2000), mk(3000)]);

    const merged = await loadCachedCandles(SYM, '12h');
    assert.equal(merged.length, 4);
    assert.equal(merged[1].close, 9, 'exchange-corrected bar replaces the stale one');
  });

  test('empty payload does not wipe the cache file', async () => {
    await fs.rm(FILE, { force: true });
    await saveCachedCandles(SYM, '12h', [mk(0), mk(1000)]);
    await saveCachedCandles(SYM, '12h', []);
    const merged = await loadCachedCandles(SYM, '12h');
    assert.equal(merged.length, 2);
  });
});

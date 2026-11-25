import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFearGreedHistory, getFearGreedValue } from '../../src/data/fearGreed.js';

const DAY = 86_400_000;
const TODAY = Date.UTC(2026, 10, 25);
const NOW = TODAY + 3_000;

/** A cache file holding `data`, written an hour ago. */
function cacheWith(data) {
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fg-')), 'fearGreed.json');
  if (data) fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: NOW - 3_600_000, data }));
  return cachePath;
}
const api = (rows) => async () => ({ json: async () => ({ data: rows.map(([ts, value]) => ({ timestamp: String(ts / 1000), value: String(value) })) }) });
const offline = async () => { throw new Error('offline'); };

describe('loadFearGreedHistory', () => {
  test('a recently written cache without today is refetched', async () => {
    const cachePath = cacheWith([{ ts: TODAY - DAY, value: 10 }]);
    const data = await loadFearGreedHistory({ now: NOW, cachePath, fetchImpl: api([[TODAY, 13], [TODAY - DAY, 10]]) });
    assert.equal(getFearGreedValue(data, NOW), 13);
    assert.equal(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).data.length, 2);
  });

  test('a cache holding today is served without a request', async () => {
    const cachePath = cacheWith([{ ts: TODAY, value: 13 }]);
    const data = await loadFearGreedHistory({ now: NOW, cachePath, fetchImpl: offline });
    assert.equal(getFearGreedValue(data, NOW), 13);
  });

  test('a failed or empty fetch returns the cache; null without one', async () => {
    const old = [{ ts: TODAY - DAY, value: 10 }];
    assert.deepEqual(await loadFearGreedHistory({ now: NOW, cachePath: cacheWith(old), fetchImpl: offline }), old);
    assert.deepEqual(await loadFearGreedHistory({ now: NOW, cachePath: cacheWith(old), fetchImpl: api([]) }), old);
    assert.equal(await loadFearGreedHistory({ now: NOW, cachePath: cacheWith(null), fetchImpl: offline }), null);
  });
});

/**
 * DVOL feed for the sleeve's vol targeting (section E1).
 *
 * Live scenarios: first boot backfills the whole history page by page; a cycle
 * whose cache already holds the bar that just closed makes no request; a refresh
 * overwrites a cached bar with the exchange's copy (payload-wins); the forming bar
 * and impossible values never reach the cache; an outage keeps the cache.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDvolHistory, readDvolCache } from '../../src/data/dvolFeed.js';
import { replayEngine } from '../../src/backtester/engineReplay.js';
import config from '../../config/default.js';

const H12 = 43_200_000;
const NOW = Date.UTC(2026, 9, 27, 12, 0, 3);           // 3 s after a 12h close
const LAST_CLOSED = Date.UTC(2026, 9, 27, 0, 0, 0);    // open of the bar that just closed
const FORMING = Date.UTC(2026, 9, 27, 12, 0, 0);

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvol-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const bar = (t, c) => [t, c, c, c, c];
// A fake Deribit: serves `series[currency]` newest-last, `pageSize` rows a page, paging backwards.
function fakeDeribit(series, { pageSize = 1000 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    const q = new URL(url).searchParams;
    const cur = q.get('currency'); const from = Number(q.get('start_timestamp')); const end = Number(q.get('end_timestamp'));
    calls.push({ cur, from, end });
    const rows = series[cur].filter((r) => r[0] >= from && r[0] <= end);
    const page = rows.slice(-pageSize);
    const continuation = rows.length > pageSize ? page[0][0] - 1 : null;
    return { json: async () => ({ result: { data: page, continuation } }) };
  };
  return { fetchImpl, calls };
}

describe('loadDvolHistory', () => {
  test('first boot backfills every page; the forming bar and impossible closes are dropped', async () => {
    const cachePath = path.join(dir, 'a.json');
    const btc = []; for (let t = LAST_CLOSED - 9 * H12; t <= FORMING; t += H12) btc.push(bar(t, 50));
    btc[2] = bar(btc[2][0], 9999);                       // corrupt value
    const eth = btc.map(([t]) => bar(t, 70));
    const { fetchImpl, calls } = fakeDeribit({ BTC: btc, ETH: eth }, { pageSize: 4 });
    const d = await loadDvolHistory({ now: NOW, cachePath, fetchImpl });
    assert.ok(calls.filter((c) => c.cur === 'BTC').length >= 3, 'paged backwards');
    assert.equal(d.BTC.at(-1).timestamp, LAST_CLOSED, 'forming bar not stored');
    assert.equal(d.BTC.length, 9, '10 closed bars minus the corrupt one');
    assert.ok(d.BTC.every((r) => r.close === 50));
    assert.deepEqual(readDvolCache(cachePath).ETH.length, 10);
  });

  test('a cache holding the bar that just closed makes no request', async () => {
    const cachePath = path.join(dir, 'b.json');
    const rows = [{ timestamp: LAST_CLOSED, close: 55 }];
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: NOW - 1000, BTC: rows, ETH: rows }));
    const { fetchImpl, calls } = fakeDeribit({ BTC: [], ETH: [] });
    const d = await loadDvolHistory({ now: NOW, cachePath, fetchImpl });
    assert.equal(calls.length, 0);
    assert.equal(d.BTC[0].close, 55);
  });

  test('a refresh overwrites the cached copy of a bar (payload-wins) and keeps older history', async () => {
    const cachePath = path.join(dir, 'c.json');
    const old = Date.UTC(2025, 0, 1);
    const cached = [{ timestamp: old, close: 40 }, { timestamp: LAST_CLOSED - H12, close: 61 }];
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 0, BTC: cached, ETH: cached }));
    const serve = [bar(LAST_CLOSED - H12, 62), bar(LAST_CLOSED, 63), bar(FORMING, 64)];
    const { fetchImpl, calls } = fakeDeribit({ BTC: serve, ETH: serve });
    const d = await loadDvolHistory({ now: NOW, cachePath, fetchImpl });
    assert.ok(calls.every((c) => c.from > old), 'incremental window, not a full backfill');
    assert.deepEqual(d.BTC.map((r) => r.close), [40, 62, 63]);
  });

  test('an outage keeps the cache', async () => {
    const cachePath = path.join(dir, 'd.json');
    const rows = [{ timestamp: LAST_CLOSED - H12, close: 58 }];
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: 0, BTC: rows, ETH: rows }));
    const d = await loadDvolHistory({ now: NOW, cachePath, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.equal(d.BTC[0].close, 58);
  });
});

test('replay refuses to run the sleeve without DVOL rows when the config enables it', async () => {
  await assert.rejects(
    replayEngine({
      symbolCandles: {}, fromTs: 0, toTs: 0, initialBalance: 100,
      cfg: { ...config, tsmCore: { ...config.tsmCore, enabled: true, impliedVol: { enabled: true } } },
    }),
    /impliedVol is enabled but no impliedVolRows/,
  );
});

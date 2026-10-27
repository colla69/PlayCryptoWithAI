import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSnapshots, recordSnapshots, snapshotDir } from '../../src/data/gaugeRecorder.js';

const NOW = Date.parse('2026-10-27T22:00:00Z');
const H = 3_600_000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gauge-rec-'));

const okFetch = (calls = []) => async (url) => {
  calls.push(url);
  return {
    ok: true,
    json: async () => ({ data: [
      { time: '2026-10-26T00:00:00.000000000Z', SplyExNtv: '2600000', FlowInExNtv: '30000', FlowOutExNtv: '29000' },
      { time: '2026-10-25T00:00:00.000000000Z', SplyExNtv: '2599000', FlowInExNtv: '31000', FlowOutExNtv: 'x' },
    ] }),
  };
};

test('records one snapshot per asset, rows sorted and unparseable rows dropped', async () => {
  const dir = tmp();
  const res = await recordSnapshots({ now: NOW, dir, fetchImpl: okFetch() });
  assert.deepEqual(res.map((r) => r.status), ['recorded', 'recorded']);
  const btc = readSnapshots('btc', dir);
  assert.equal(btc.length, 1);
  assert.equal(btc[0].recordedAt, NOW);
  assert.deepEqual(btc[0].rows, [{ t: Date.parse('2026-10-26T00:00:00Z'), sply: 2600000, fin: 30000, fout: 29000 }]);
});

test('skips an asset recorded less than minGapMs ago (restarts do not pile up)', async () => {
  const dir = tmp();
  await recordSnapshots({ now: NOW, dir, fetchImpl: okFetch() });
  const calls = [];
  const res = await recordSnapshots({ now: NOW + 10 * H, dir, minGapMs: 20 * H, fetchImpl: okFetch(calls) });
  assert.deepEqual(res.map((r) => r.status), ['skipped', 'skipped']);
  assert.equal(calls.length, 0);
  const later = await recordSnapshots({ now: NOW + 21 * H, dir, minGapMs: 20 * H, fetchImpl: okFetch() });
  assert.deepEqual(later.map((r) => r.status), ['recorded', 'recorded']);
  assert.equal(readSnapshots('eth', dir).length, 2);
});

test('a failed fetch is reported, never thrown, and writes nothing', async () => {
  const dir = tmp();
  const res = await recordSnapshots({ now: NOW, dir, fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.deepEqual(res.map((r) => r.status), ['failed', 'failed']);
  assert.match(res[0].error, /429/);
  assert.deepEqual(readSnapshots('btc', dir), []);
});

test('a line cut short by a crash does not block later snapshots', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'cm_exchange_btc.jsonl'), '{"recordedAt":1,"asset":"btc","ro');
  const res = await recordSnapshots({ now: NOW, dir, minGapMs: 20 * H, fetchImpl: okFetch() });
  assert.equal(res[0].status, 'recorded');
  assert.equal(readSnapshots('btc', dir).length, 1);
});

test('the default directory resolves through runtimeDir(), outside the checkout in tests', () => {
  assert.ok(!snapshotDir().startsWith(process.cwd()));
});

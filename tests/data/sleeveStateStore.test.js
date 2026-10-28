import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSleeveState, saveSleeveState, sleeveStateFile } from '../../src/data/sleeveStateStore.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sleeve-state-')), 'tsm_sleeve_state.json');
const T = Date.parse('2026-10-28T12:00:00Z');

test('round trip: the gate and the last-sell times come back as written', () => {
  const file = tmpFile();
  const state = { rebuyGate: new Map([['BTC/USDC#core', true]]), lastExitAt: new Map([['BTC/USDC#core', T], ['ETH/USDC#core', T - 1000]]) };
  assert.equal(saveSleeveState(state, file, T), true);
  const back = loadSleeveState(file);
  assert.deepEqual([...back.rebuyGate.keys()], ['BTC/USDC#core']);
  assert.deepEqual([...back.lastExitAt], [['BTC/USDC#core', T], ['ETH/USDC#core', T - 1000]]);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'the temp file is renamed away');
});

test('an absent file is an empty state', () => {
  const back = loadSleeveState(tmpFile());
  assert.equal(back.rebuyGate.size, 0);
  assert.equal(back.lastExitAt.size, 0);
});

test('a corrupt or unknown file never throws and starts empty', () => {
  for (const body of ['{"version":1,"rebuyGate":["BTC/USDC#co', '{"version":2,"rebuyGate":["BTC/USDC#core"]}', 'null']) {
    const file = tmpFile();
    fs.writeFileSync(file, body);
    const back = loadSleeveState(file);
    assert.equal(back.rebuyGate.size, 0, body);
    assert.equal(back.lastExitAt.size, 0, body);
  }
});

test('entries that are not core keys or valid times are dropped', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    rebuyGate: ['BTC/USDC#core', 'BTC/USDC', 42, '#core'],
    lastExitAt: { 'ETH/USDC#core': T, 'SOL/USDC#core': 'yesterday', 'XRP/USDC': T, 'BNB/USDC#core': -1 },
  }));
  const back = loadSleeveState(file);
  assert.deepEqual([...back.rebuyGate.keys()], ['BTC/USDC#core']);
  assert.deepEqual([...back.lastExitAt], [['ETH/USDC#core', T]]);
});

test('a failed write reports false and leaves the previous file intact', () => {
  const file = tmpFile();
  const good = { rebuyGate: new Map([['BTC/USDC#core', true]]), lastExitAt: new Map() };
  saveSleeveState(good, file, T);
  fs.mkdirSync(`${file}.tmp`); // the temp path is a directory: writing it fails
  assert.equal(saveSleeveState({ rebuyGate: new Map(), lastExitAt: new Map() }, file, T), false);
  assert.deepEqual([...loadSleeveState(file).rebuyGate.keys()], ['BTC/USDC#core']);
});

test('the default file resolves through runtimeDir(), outside the checkout in tests', () => {
  assert.ok(!sleeveStateFile().startsWith(process.cwd()));
});

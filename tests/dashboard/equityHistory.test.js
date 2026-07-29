/**
 * Daily equity snapshots.
 *
 * These are the valuation points time-weighted return chains between. A missing
 * or wrong point silently distorts the strategy's measured performance, so the
 * two rules that matter are: one row per UTC day, and never record a failed
 * balance fetch (which surfaces as 0) as a wiped-out account.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { recordEquitySnapshot, loadEquityHistory } from '../../src/dashboard/equityHistory.js';

// The module resolves its file from process.cwd(), so isolate each test in a tmp dir.
let tmp; let cwd;
beforeEach(() => {
  cwd = process.cwd();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'equity-'));
  process.chdir(tmp);
});
afterEach(() => {
  process.chdir(cwd);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const DAY = 86_400_000;
const T = Date.parse('2026-07-29T09:00:00Z');

describe('recordEquitySnapshot', () => {
  test('writes a point and reads it back', () => {
    assert.equal(recordEquitySnapshot(189.43, T), true);
    const h = loadEquityHistory();
    assert.equal(h.length, 1);
    assert.equal(h[0].equity, 189.43);
    assert.equal(h[0].date, '2026-07-29');
  });

  test('keeps one row per UTC day, holding the latest value', () => {
    recordEquitySnapshot(100, T);
    recordEquitySnapshot(110, T + 3_600_000);
    recordEquitySnapshot(120, T + 7_200_000);

    const h = loadEquityHistory();
    assert.equal(h.length, 1, 'same UTC day must not append');
    assert.equal(h[0].equity, 120, 'latest valuation of the day wins');
  });

  test('appends across day boundaries and stays ascending', () => {
    recordEquitySnapshot(100, T);
    recordEquitySnapshot(105, T + DAY);
    recordEquitySnapshot(103, T + 2 * DAY);

    const h = loadEquityHistory();
    assert.equal(h.length, 3);
    assert.deepEqual(h.map((p) => p.equity), [100, 105, 103]);
    assert.ok(h.every((p, i) => i === 0 || p.timestamp > h[i - 1].timestamp));
  });

  test('refuses non-positive or malformed equity', () => {
    // A failed balance fetch reports 0 — recording it would look like a wipeout
    // and corrupt every TWR sub-period that spans it.
    for (const bad of [0, -5, NaN, null, undefined, 'abc']) {
      assert.equal(recordEquitySnapshot(bad, T), false, `should refuse ${String(bad)}`);
    }
    assert.deepEqual(loadEquityHistory(), []);
  });

  test('missing or corrupt file reads as empty rather than throwing', () => {
    assert.deepEqual(loadEquityHistory(), []);
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'data', 'equity_history.json'), '{not json');
    assert.deepEqual(loadEquityHistory(), []);
  });
});

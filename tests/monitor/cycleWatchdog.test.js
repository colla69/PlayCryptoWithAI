/**
 * Cycle watchdog.
 *
 * Encodes the July 2026 incident: an 18h host-suspend stall produced zero
 * alerts because a dead loop emits no error — only the ABSENCE of cycles
 * signals it. The latch must fire exactly once per incident and re-arm on
 * recovery so the NEXT stall alerts too.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkCycleGap, updateWatchdogLatch } from '../../src/monitor/cycleWatchdog.js';

const H = 3_600_000;
const PERIOD = 12 * H;
const T0 = Date.parse('2026-07-03T12:00:00Z');

describe('checkCycleGap', () => {
  test('a cycle within the period is healthy', () => {
    assert.equal(checkCycleGap({ lastCycleAt: T0, now: T0 + PERIOD, periodMs: PERIOD }).stale, false);
  });

  test('tolerates scheduling slack up to the factor', () => {
    // 13.8h on a 12h period (factor 1.15) is the boundary.
    assert.equal(checkCycleGap({ lastCycleAt: T0, now: T0 + 13.7 * H, periodMs: PERIOD }).stale, false);
    assert.equal(checkCycleGap({ lastCycleAt: T0, now: T0 + 13.9 * H, periodMs: PERIOD }).stale, true);
  });

  test('the July 2026 stall (18h gap) is flagged well inside the incident', () => {
    const { stale, gapMs } = checkCycleGap({ lastCycleAt: T0, now: T0 + 18.2 * H, periodMs: PERIOD });
    assert.equal(stale, true);
    assert.ok(gapMs > 18 * H);
  });

  test('before the first completed cycle nothing is stale (no boot spam)', () => {
    assert.equal(checkCycleGap({ lastCycleAt: null, now: T0, periodMs: PERIOD }).stale, false);
    assert.equal(checkCycleGap({ lastCycleAt: undefined, now: T0, periodMs: PERIOD }).stale, false);
  });

  test('a nonsensical factor falls back to the default instead of disabling', () => {
    assert.equal(checkCycleGap({ lastCycleAt: T0, now: T0 + 14 * H, periodMs: PERIOD, factor: 0 }).stale, true);
    assert.equal(checkCycleGap({ lastCycleAt: T0, now: T0 + 14 * H, periodMs: PERIOD, factor: NaN }).stale, true);
  });
});

describe('updateWatchdogLatch', () => {
  test('fires once per incident, stays quiet while it persists, re-arms on recovery', () => {
    const state = { alerted: false };

    // Incident begins → one alert.
    assert.deepEqual(updateWatchdogLatch(state, true), { fire: true, recovered: false });
    // Still stale on later checks → silence, not spam.
    assert.deepEqual(updateWatchdogLatch(state, true), { fire: false, recovered: false });
    assert.deepEqual(updateWatchdogLatch(state, true), { fire: false, recovered: false });
    // Cycles resume → recovery notice, latch re-armed.
    assert.deepEqual(updateWatchdogLatch(state, false), { fire: false, recovered: true });
    // Second incident later → fires again.
    assert.deepEqual(updateWatchdogLatch(state, true), { fire: true, recovered: false });
  });

  test('healthy steady state never fires anything', () => {
    const state = { alerted: false };
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(updateWatchdogLatch(state, false), { fire: false, recovered: false });
    }
  });
});

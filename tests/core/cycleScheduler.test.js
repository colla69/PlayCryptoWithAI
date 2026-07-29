/**
 * Candle-close scheduler.
 *
 * Regression cover for the 2026-07 soak: the loop drifted to 06:09/18:09 UTC —
 * 6h09m past candle close — and stayed there for 48 consecutive cycles because
 * the old code handed off to a fixed `setInterval` after awaiting the first run
 * and never resynced to the clock.
 *
 * Driven by a fake clock + fake timer so a 6-hour stall is free to simulate.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createAlignedScheduler, nextCandleClose } from '../../src/core/cycleScheduler.js';

const HOUR = 3_600_000;
const BUF = 3_000;
const at = (iso) => Date.parse(iso);

/**
 * Minimal fake environment: a clock you advance by running the single pending
 * timer, mirroring how Node would fire it.
 */
function makeHarness({ start, timeframe = '12h', runDurationMs = 0 }) {
  let clock = start;
  let pending = null;
  let nextId = 1;
  const fired = [];

  const scheduler = createAlignedScheduler({
    timeframe,
    now: () => clock,
    setTimeoutFn: (fn, delay) => {
      pending = { fn, dueAt: clock + delay, id: nextId };
      return nextId++;
    },
    clearTimeoutFn: (id) => { if (pending?.id === id) pending = null; },
    run: async () => {
      fired.push(clock);
      clock += runDurationMs; // the cycle takes time to complete
    },
  });

  return {
    scheduler,
    fired,
    get clock() { return clock; },
    get pendingDueAt() { return pending?.dueAt ?? null; },
    /** Advance to the pending timer's due time and run it. */
    async tick() {
      if (!pending) throw new Error('no pending timer');
      const { fn } = pending;
      clock = Math.max(clock, pending.dueAt);
      pending = null;
      await fn();
    },
  };
}

describe('nextCandleClose', () => {
  test('12h candles land on 00:00 and 12:00 UTC + buffer', () => {
    assert.equal(nextCandleClose('12h', at('2026-07-15T03:17:00Z')), at('2026-07-15T12:00:00Z') + BUF);
    assert.equal(nextCandleClose('12h', at('2026-07-15T18:42:00Z')), at('2026-07-16T00:00:00Z') + BUF);
  });

  test('exactly on a boundary schedules that close, not the next', () => {
    assert.equal(nextCandleClose('12h', at('2026-07-15T12:00:00Z')), at('2026-07-15T12:00:00Z') + BUF);
  });

  test('just past a boundary rolls to the following one', () => {
    assert.equal(nextCandleClose('12h', at('2026-07-15T12:00:04Z')), at('2026-07-16T00:00:00Z') + BUF);
  });

  test('other timeframes align to their own grid', () => {
    assert.equal(nextCandleClose('4h', at('2026-07-15T05:30:00Z')), at('2026-07-15T08:00:00Z') + BUF);
    assert.equal(nextCandleClose('15m', at('2026-07-15T05:31:00Z')), at('2026-07-15T05:45:00Z') + BUF);
  });

  test('an unparseable timeframe retries in a minute instead of hanging', () => {
    const now = at('2026-07-15T05:31:00Z');
    assert.equal(nextCandleClose('bogus', now), now + 60_000);
  });
});

describe('createAlignedScheduler', () => {
  test('fires at candle close and keeps firing there', async () => {
    const h = makeHarness({ start: at('2026-07-15T03:00:00Z') });
    h.scheduler.start();
    for (let i = 0; i < 4; i++) await h.tick();

    assert.deepEqual(h.fired.map((t) => new Date(t).toISOString()), [
      '2026-07-15T12:00:03.000Z',
      '2026-07-16T00:00:03.000Z',
      '2026-07-16T12:00:03.000Z',
      '2026-07-17T00:00:03.000Z',
    ]);
  });

  test('a slow cycle does not shift the schedule (the 2026-07 bug)', async () => {
    // The run itself takes 6h09m — exactly the offset the live loop acquired.
    const h = makeHarness({ start: at('2026-07-15T03:00:00Z'), runDurationMs: 6 * HOUR + 9 * 60_000 });
    h.scheduler.start();
    for (let i = 0; i < 3; i++) await h.tick();

    // Every fire is still on a candle boundary — the old setInterval handoff
    // would have locked to 18:09, 06:09, 18:09…
    for (const t of h.fired) {
      const d = new Date(t);
      assert.equal(d.getUTCMinutes(), 0, `fired at ${d.toISOString()} — drifted off close`);
      assert.ok([0, 12].includes(d.getUTCHours()), `fired at ${d.toISOString()} — drifted off close`);
    }
  });

  test('recovers alignment after a stall that skips a whole cycle', async () => {
    // Simulate the observed 18h gap: the process is frozen past a boundary.
    const h = makeHarness({ start: at('2026-07-03T11:00:00Z') });
    h.scheduler.start();
    await h.tick();                       // fires 12:00:03
    assert.equal(new Date(h.fired[0]).toISOString(), '2026-07-03T12:00:03.000Z');

    // Timer was due 00:00:03 but the host was suspended until 06:09.
    assert.equal(h.pendingDueAt, at('2026-07-04T00:00:00Z') + BUF);
    await h.tick();

    // The next schedule is re-derived from the clock, so it snaps back to 12:00
    // instead of inheriting a 06:09 phase forever.
    assert.equal(h.pendingDueAt, at('2026-07-04T12:00:00Z') + BUF);
  });

  test('a throwing cycle is reported but never stops the loop', async () => {
    const errors = [];
    let clock = at('2026-07-15T03:00:00Z');
    let pending = null;
    const scheduler = createAlignedScheduler({
      timeframe: '12h',
      now: () => clock,
      setTimeoutFn: (fn, delay) => { pending = { fn, dueAt: clock + delay }; return 1; },
      clearTimeoutFn: () => { pending = null; },
      run: async () => { throw new Error('exchange down'); },
      onError: (err) => errors.push(err.message),
    });
    scheduler.start();
    for (let i = 0; i < 2; i++) {
      const { fn, dueAt } = pending;
      clock = dueAt;
      pending = null;
      await fn();
    }

    assert.deepEqual(errors, ['exchange down', 'exchange down']);
    assert.equal(pending.dueAt, at('2026-07-16T12:00:00Z') + BUF, 'loop must keep scheduling after failures');
  });

  test('stop() halts the loop and isStopped prevents rescheduling', async () => {
    let clock = at('2026-07-15T03:00:00Z');
    let pending = null;
    let stopped = false;
    const fired = [];
    const scheduler = createAlignedScheduler({
      timeframe: '12h',
      now: () => clock,
      setTimeoutFn: (fn, delay) => { pending = { fn, dueAt: clock + delay }; return 1; },
      clearTimeoutFn: () => { pending = null; },
      run: async () => { fired.push(clock); stopped = true; },
      isStopped: () => stopped,
    });
    scheduler.start();

    const { fn, dueAt } = pending;
    clock = dueAt;
    pending = null;
    await fn();

    assert.equal(fired.length, 1);
    assert.equal(pending, null, 'must not reschedule once shutting down');
  });

  test('start() schedules without running immediately', () => {
    const h = makeHarness({ start: at('2026-07-15T03:00:00Z') });
    h.scheduler.start();
    assert.deepEqual(h.fired, []);
    assert.equal(h.pendingDueAt, at('2026-07-15T12:00:00Z') + BUF);
  });
});

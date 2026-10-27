/**
 * The venue veto (src/risk/exchangeEvents.js) on the events that hit the universe in
 * 2026: VANRY tagged 07-03 and delisted 08-17; LSK/USDC removed 06-12 (LSK itself
 * stays on Binance); a tag later lifted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exchangeEventState } from '../../src/risk/exchangeEvents.js';

const T = (iso) => Date.parse(iso);
const DAY = 86_400_000;
const EVENTS = [
  { coin: 'LSK', kind: 'pair_removal', pair: 'LSK/USDC', announcedAt: T('2026-06-09T08:30:00Z'), effectiveAt: T('2026-06-12T03:00:00Z') },
  { coin: 'VANRY', kind: 'monitoring_tag', announcedAt: T('2026-07-03T06:00:00Z'), effectiveAt: T('2026-07-03T06:00:00Z') },
  { coin: 'VANRY', kind: 'token_delist', announcedAt: T('2026-08-03T03:30:00Z'), effectiveAt: T('2026-08-17T00:00:00Z') },
  { coin: 'GMX', kind: 'pair_removal', pair: 'GMX/FDUSD', announcedAt: T('2026-07-07T09:15:00Z'), effectiveAt: T('2026-07-10T03:00:00Z') },
  { coin: 'FLOW', kind: 'monitoring_tag', announcedAt: T('2026-01-02T00:00:00Z') },
  { coin: 'FLOW', kind: 'monitoring_tag_removed', announcedAt: T('2026-03-06T07:00:00Z') },
];
const none = { blockEntry: false, exitHeld: false, reason: null };

test('nothing before the notice is published', () => {
  assert.deepEqual(exchangeEventState(EVENTS, 'LSK', T('2026-06-09T08:29:59Z')), none);
});

test('a USDC-pair removal blocks entries and sells, from the notice', () => {
  const s = exchangeEventState(EVENTS, 'LSK', T('2026-06-09T12:00:03Z'));
  assert.equal(s.blockEntry, true);
  assert.equal(s.exitHeld, true);
  assert.match(s.reason, /LSK\/USDC removal announced 2026-06-09/);
});

test('a removal of a pair in another quote asset is not ours', () => {
  assert.deepEqual(exchangeEventState(EVENTS, 'GMX', T('2026-07-08T00:00:00Z')), none);
});

test('a monitoring tag blocks entries but does not sell', () => {
  const s = exchangeEventState(EVENTS, 'VANRY', T('2026-07-10T00:00:00Z'));
  assert.deepEqual([s.blockEntry, s.exitHeld], [true, false]);
  assert.match(s.reason, /monitoring tag since 2026-07-03/);
});

test('the delisting after the tag sells', () => {
  const s = exchangeEventState(EVENTS, 'VANRY', T('2026-08-03T12:00:03Z'));
  assert.deepEqual([s.blockEntry, s.exitHeld], [true, true]);
  assert.match(s.reason, /token delisting/);
});

test('a removal ends a week after it takes effect (the stale guard owns the halt; a relisted pair trades again)', () => {
  assert.equal(exchangeEventState(EVENTS, 'LSK', T('2026-06-12T03:00:00Z') + 7 * DAY - 1).blockEntry, true);
  assert.equal(exchangeEventState(EVENTS, 'LSK', T('2026-06-12T03:00:00Z') + 7 * DAY).blockEntry, false);
});

test('a lifted tag stops blocking; the result does not depend on event order', () => {
  assert.equal(exchangeEventState(EVENTS, 'FLOW', T('2026-02-01T00:00:00Z')).blockEntry, true);
  assert.deepEqual(exchangeEventState(EVENTS, 'FLOW', T('2026-03-07T00:00:00Z')), none);
  assert.deepEqual(exchangeEventState([...EVENTS].reverse(), 'FLOW', T('2026-03-07T00:00:00Z')), none);
  const retagged = [...EVENTS, { coin: 'FLOW', kind: 'monitoring_tag', announcedAt: T('2026-05-01T00:00:00Z') }];
  assert.equal(exchangeEventState(retagged.reverse(), 'FLOW', T('2026-05-02T00:00:00Z')).blockEntry, true);
});

test('no events, no veto', () => {
  assert.deepEqual(exchangeEventState(null, 'BTC', Date.now()), none);
});

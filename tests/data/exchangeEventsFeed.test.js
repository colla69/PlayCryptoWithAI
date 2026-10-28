/**
 * Binance venue-event feed (section E item 2): titles and bodies as Binance wrote
 * them for the four coins that left the universe in 2026 (LSK/USDC and GMX/USDC
 * removed, TON renamed, VANRY tagged then delisted), and the refresh contract — once
 * per 4h period, a body only for a pair-removal notice, an outage keeps the cache.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseNotice, needsBody, bodyText, ingestNotices, loadExchangeEvents, readExchangeEventsCache,
} from '../../src/data/exchangeEventsFeed.js';
import { replayEngine } from '../../src/backtester/engineReplay.js';
import config from '../../config/default.js';

let dir;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xevents-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const T = (iso) => Date.parse(iso);
const summary = (events) => events.map((e) => `${e.kind}:${e.coin}${e.pair ? `:${e.pair}` : ''}`);

describe('parseNotice', () => {
  test('a monitoring tag list, with a removal in the same title', () => {
    const ev = parseNotice({
      code: 'a', releaseDate: T('2026-03-06T07:00:00Z'),
      title: 'Binance Will Extend the Monitoring Tag to Include COS, DEGO, FORTH, FUN, HOOK, LRC, MBOX, OXT & WIF, Remove the Monitoring Tag for FLOW, and Remove the Seed Tag for ONDO & VIRTUAL on 2026-03-06',
    });
    assert.deepEqual(summary(ev), [
      ...['COS', 'DEGO', 'FORTH', 'FUN', 'HOOK', 'LRC', 'MBOX', 'OXT', 'WIF'].map((c) => `monitoring_tag:${c}`),
      'monitoring_tag_removed:FLOW',
    ]);
    assert.ok(ev.every((e) => e.announcedAt === T('2026-03-06T07:00:00Z')));
  });

  test('the Seed Tag clause is not the Monitoring Tag', () => {
    const ev = parseNotice({ code: 'b', releaseDate: 1, title: 'Binance Will Remove the Monitoring Tag for ZEC and the Seed Tag for ENA, PYTH, TAO & W on 2025-07-09' });
    assert.deepEqual(summary(ev), ['monitoring_tag_removed:ZEC']);
  });

  test('a one-letter ticker is a coin', () => {
    const ev = parseNotice({ code: 'c', releaseDate: 1, title: 'Binance Will Delist COS, D, HIGH, MBOX on 2026-06-19' });
    assert.deepEqual(summary(ev), ['token_delist:COS', 'token_delist:D', 'token_delist:HIGH', 'token_delist:MBOX']);
    assert.equal(ev[0].effectiveAt, T('2026-06-19T00:00:00Z'));
  });

  test('a pair removal reads the USDC pairs and their time from the body', () => {
    const title = 'Notice of Removal of Spot Trading Pairs - 2026-06-12';
    assert.ok(needsBody(title));
    const text = 'Fellow Binancians,\nAt 2026-06-12 03:00 (UTC): ALPHA/BTC, LSK/USDC, MAV/FDUSD and T/USDC\nUSDC/PLN is not a USDC-quoted pair.\n';
    const ev = parseNotice({ code: 'd', releaseDate: T('2026-06-09T08:30:00Z'), title, text });
    assert.deepEqual(summary(ev), ['pair_removal:LSK:LSK/USDC', 'pair_removal:T:T/USDC']);
    assert.ok(ev.every((e) => e.effectiveAt === T('2026-06-12T03:00:00Z')));
  });

  test('other notices yield nothing', () => {
    for (const title of [
      'Binance Futures Will Delist PTBUSDT and MITOUSDT USDⓈ-M Perpetual Contracts (2026-10-23)',
      'Binance Will Support the Toncoin (TON) Rebranding to Gram (GRAM)',
      'Binance Will Delist All American-Style Daily Options',
    ]) assert.deepEqual(parseNotice({ code: 'x', releaseDate: 1, title }), [], title);
  });

  test('bodyText flattens the CMS node tree, one line per paragraph', () => {
    const body = JSON.stringify({ node: 'root', child: [
      { node: 'element', tag: 'p', child: [{ node: 'text', text: 'At 2026-07-10 03:00 (UTC): ' }, { node: 'text', text: 'GMX/USDC' }] },
      { node: 'element', tag: 'p', child: [{ node: 'text', text: 'next' }] },
    ] });
    assert.equal(bodyText(body), 'At 2026-07-10 03:00 (UTC): GMX/USDC\nnext\n');
  });
});

/** A fake CMS: list pages by catalog, bodies by code; records every URL. */
function fakeCms({ lists, bodies = {}, failBodies = false }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const q = new URL(url).searchParams;
    if (url.includes('/detail/')) {
      if (failBodies) return { ok: false, status: 429, json: async () => ({}) };
      const text = bodies[q.get('articleCode')];
      return { ok: true, json: async () => ({ data: { body: JSON.stringify({ node: 'element', tag: 'p', child: [{ node: 'text', text }] }) } }) };
    }
    const articles = lists[q.get('catalogId')] ?? [];
    return { ok: true, json: async () => ({ data: { catalogs: [{ articles }] } }) };
  };
  return { fetchImpl, calls };
}

const LSK_NOTICE = { code: 'lsk', title: 'Notice of Removal of Spot Trading Pairs - 2026-06-12', releaseDate: T('2026-06-09T08:30:00Z') };
const VANRY_TAG = { code: 'tag', title: 'Binance Will Extend the Monitoring Tag to Include AEUR, PYR, SCRT & VANRY on 2026-07-03', releaseDate: T('2026-07-03T06:00:00Z') };

describe('loadExchangeEvents', () => {
  test('first read: both catalogs, one body for the pair-removal notice, cached', async () => {
    const cachePath = path.join(dir, 'a.json');
    const { fetchImpl, calls } = fakeCms({ lists: { 161: [LSK_NOTICE], 49: [VANRY_TAG] }, bodies: { lsk: 'At 2026-06-12 03:00 (UTC): LSK/USDC' } });
    const d = await loadExchangeEvents({ now: T('2026-07-03T12:00:03Z'), cachePath, fetchImpl });
    assert.deepEqual(summary(d.events), ['pair_removal:LSK:LSK/USDC', 'monitoring_tag:AEUR', 'monitoring_tag:PYR', 'monitoring_tag:SCRT', 'monitoring_tag:VANRY']);
    assert.equal(calls.filter((u) => u.includes('/detail/')).length, 1);
    assert.deepEqual(readExchangeEventsCache(cachePath).events, d.events);
  });

  test('within the same 4h period no request is made; the next period re-reads, and a seen notice is not parsed twice', async () => {
    const cachePath = path.join(dir, 'b.json');
    const { fetchImpl, calls } = fakeCms({ lists: { 161: [LSK_NOTICE], 49: [] }, bodies: { lsk: 'At 2026-06-12 03:00 (UTC): LSK/USDC' } });
    await loadExchangeEvents({ now: T('2026-06-10T00:00:03Z'), cachePath, fetchImpl });
    const n = calls.length;
    await loadExchangeEvents({ now: T('2026-06-10T03:59:00Z'), cachePath, fetchImpl });
    assert.equal(calls.length, n, 'same 4h period: served from the cache');
    const d = await loadExchangeEvents({ now: T('2026-06-10T04:00:03Z'), cachePath, fetchImpl });
    assert.equal(calls.length, n + 2, 'next period: the two list pages, no body');
    assert.equal(d.events.length, 1);
  });

  test('a body that fails stays unseen and is retried at the next refresh', async () => {
    const cachePath = path.join(dir, 'c.json');
    const failing = fakeCms({ lists: { 161: [LSK_NOTICE], 49: [] }, failBodies: true });
    const d1 = await loadExchangeEvents({ now: T('2026-06-10T00:00:03Z'), cachePath, fetchImpl: failing.fetchImpl });
    assert.equal(d1.events.length, 0);
    const ok = fakeCms({ lists: { 161: [LSK_NOTICE], 49: [] }, bodies: { lsk: 'At 2026-06-12 03:00 (UTC): LSK/USDC' } });
    const d2 = await loadExchangeEvents({ now: T('2026-06-10T04:00:03Z'), cachePath, fetchImpl: ok.fetchImpl });
    assert.deepEqual(summary(d2.events), ['pair_removal:LSK:LSK/USDC']);
  });

  test('an outage keeps the cache', async () => {
    const cachePath = path.join(dir, 'd.json');
    const cached = { fetchedAt: 0, events: [{ coin: 'LSK', kind: 'pair_removal', pair: 'LSK/USDC', announcedAt: 1 }], seen: ['lsk'] };
    fs.writeFileSync(cachePath, JSON.stringify(cached));
    const d = await loadExchangeEvents({ now: T('2026-06-10T00:00:03Z'), cachePath, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual(d.events, cached.events);
  });

  test('ingestNotices sorts events by announcement time', async () => {
    const d = await ingestNotices({ events: [], seen: [] }, [VANRY_TAG, { ...VANRY_TAG, code: 'older', releaseDate: 5 }]);
    assert.ok(d.events.every((e, i) => i === 0 || e.announcedAt >= d.events[i - 1].announcedAt));
  });
});

test('replay refuses to run without events when the config enables the veto', async () => {
  await assert.rejects(
    replayEngine({ symbolCandles: {}, fromTs: 0, toTs: 0, initialBalance: 100, cfg: { ...config, tsmCore: { enabled: false }, exchangeEvents: { enabled: true } } }),
    /exchangeEvents is enabled but no events were passed/,
  );
});

// Security review 2026-10-28: a misread notice sells a held coin, so only spot delistings and
// the pairs on a removal's "At <date> (UTC):" lines count. On the 2023–26 history these rules
// read the same 45 delisting notices and 44 USDC pair removals as before.
describe('parseNotice refuses what is not a spot delisting', () => {
  test('margin, futures and other product delistings yield nothing', () => {
    for (const title of [
      'Binance Will Delist BTC Isolated Margin Pairs on 2026-11-05',
      'Binance Will Delist ETH Perpetual Contracts on 2026-11-05',
      'Binance Will Delist BNB, SOL Cross Margin Pairs on 2026-11-05',
    ]) assert.deepEqual(parseNotice({ code: 'm', releaseDate: 1, title }), [], title);
  });
  test('a bare ticker list, with or without names, still reads', () => {
    const ev = parseNotice({ code: 'n', releaseDate: 1, title: 'Binance Will Delist ACX, LSK & SLX (SLIMEX) on 2026-06-12' });
    assert.deepEqual(ev.map((e) => e.coin), ['ACX', 'LSK', 'SLX']);
  });
  test('a pair named outside an "At … (UTC)" line is not a removal', () => {
    const ev = parseNotice({
      code: 'o', releaseDate: 1, title: 'Notice of Removal of Spot Trading Pairs - 2026-11-01',
      text: 'At 2026-11-03 03:00 (UTC): LSK/USDC, ACX/BTC\nUsers can still trade ETH/USDC and BTC/USDC.\n',
    });
    assert.deepEqual(ev.map((e) => e.pair), ['LSK/USDC']);
    assert.equal(ev[0].effectiveAt, Date.parse('2026-11-03T03:00:00Z'));
  });
});

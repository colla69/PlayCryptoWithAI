/**
 * PaperTrader satellite orders — the paper shadow of the satellite order path.
 *
 * Live scenarios covered: a resting limit locks its cash and fills at its price when a
 * risk-loop tick trades at or under it; it expires unfilled; a filled position exits by
 * the shared rules on ticks (stop, break-even, time limit); the scalper's risk check
 * leaves it alone; a restart restores it with its exit plan.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 26, 8, 0, 0);
const plan = { breakEvenAtR: 1, targetR: null, timeLimitMs: 48 * H, tiers: null };
const trader = () => new PaperTrader({ initialBalance: 1000, maxPositionPct: 0.25, stopLossPct: 0.05, takeProfitPct: 0.1 });
const place = (t) => t.placeSatelliteOrder('ETH/USDC#bo', { limitPrice: 99, validUntil: T0 + 4 * H, sizeUsd: 125, stopPrice: 96, plan });

describe('paper satellites', () => {
  test('a resting limit locks its cash; a tick at the limit fills it at the limit', () => {
    const t = trader(); place(t);
    assert.equal(t.getStatus().balance, 875);
    assert.equal(calcEquityFromStatus(t.getStatus()), 1000);
    assert.equal(t.satelliteTick('ETH/USDC#bo', 99.4, { now: T0 + 60_000 }), null);
    const fill = t.satelliteTick('ETH/USDC#bo', 98.7, { now: T0 + 120_000 });
    assert.equal(fill.side, 'BUY');
    assert.equal(fill.entryPrice, 99);
    assert.equal(fill.stopLoss, 96);
    assert.equal(t.getStatus().reserved, undefined);
    assert.equal(t.getStatus().positions[0].isSatellite, true);
  });

  test('unfilled by validUntil → cancelled, cash back', () => {
    const t = trader(); place(t);
    assert.equal(t.satelliteTick('ETH/USDC#bo', 98, { now: T0 + 4 * H }), null);
    assert.equal(t.pendingSatelliteKeys().length, 0);
    assert.equal(t.getStatus().balance, 1000);
  });

  test('ticks run the exit plan: break-even after +1R, then out at the entry', () => {
    const t = trader(); place(t);
    t.satelliteTick('ETH/USDC#bo', 99, { now: T0 + 60_000 });
    assert.equal(t.satelliteTick('ETH/USDC#bo', 102.5, { now: T0 + 2 * H }), null); // 99 + 3 = 102
    const exit = t.satelliteTick('ETH/USDC#bo', 98.9, { now: T0 + 3 * H });
    assert.equal(exit.reason, 'sat_breakeven');
    assert.equal(exit.exitPrice, 98.9);
  });

  test('the time limit sells at the tick price', () => {
    const t = trader(); place(t);
    t.satelliteTick('ETH/USDC#bo', 99, { now: T0 });
    assert.equal(t.satelliteTick('ETH/USDC#bo', 100.5, { now: T0 + 48 * H }).reason, 'sat_time');
  });

  test("the scalper's checkRisk does not touch a satellite position", () => {
    const t = trader(); place(t);
    t.satelliteTick('ETH/USDC#bo', 99, { now: T0 });
    assert.equal(t.checkRisk('ETH/USDC#bo', 50), null);
    assert.equal(t.positions.size, 1);
  });

  test('a restart restores the position with its plan from the fill record', () => {
    const t = trader(); place(t);
    const fill = t.satelliteTick('ETH/USDC#bo', 99, { now: T0 });
    const t2 = trader();
    t2.restorePosition(fill);
    const pos = t2.positions.get('ETH/USDC#bo');
    assert.equal(pos.isSatellite, true);
    assert.equal(pos.timeLimitAt, T0 + 48 * H);
    assert.equal(pos.breakEvenAt, 102);
    assert.equal(t2.satelliteTick('ETH/USDC#bo', 95.5, { now: T0 + H }).reason, 'sat_stop');
  });
});

/**
 * LiveTrader satellite orders against a fake exchange with limit orders — the real-money
 * path of the satellite strategies.
 *
 * Live scenarios covered: a GTC limit buy locks its USDC (equity still counts it) and
 * becomes a position with its exit plan once Binance reports it filled; expiry cancels it,
 * keeping a part fill; an exit sells with an IOC limit capped 0.3% under the price, and
 * only what that leaves sells at market; a restart reloads the resting order, restores the
 * satellite with its moved stop, and the scalper restore never adopts satellite coins.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';
import { runtimeDir } from '../../src/utils/runtimePaths.js';

const H = 3_600_000;
const KEY = 'BTC/USDC#bo';
const plan = { breakEvenAtR: 1, targetR: null, timeLimitMs: 48 * H, tiers: null };

class FakeLimitExchange {
  constructor() {
    this.free = { USDC: 1000, BTC: 0 }; this.locked = 0; this.price = 100; this.n = 0;
    this.orders = new Map(); this.iocFillShare = 1; this.calls = []; this.fillOnCancel = 0; this.cancelFailures = 0;
  }
  async fetchBalance() { return { free: { ...this.free }, used: { USDC: this.locked }, total: { ...this.free } }; }
  async amountToPrecision(_s, q) { return Number(Number(q).toFixed(6)); }
  async priceToPrecision(_s, p) { return Number(Number(p).toFixed(2)); }
  async getMarketLimits() { return { minQty: 0, minNotional: 0 }; }
  async fetchTicker() { return { last: this.price }; }
  async fetchOpenOrders() { return []; }
  async createOrder(_s, type, side, qty, price, params = {}) {
    this.calls.push({ type, side, qty, price, params });
    const id = `o${++this.n}`;
    if (type === 'limit' && side === 'buy') {
      this.free.USDC -= qty * price; this.locked += qty * price;
      this.orders.set(id, { id, status: 'open', amount: qty, filled: 0, price, average: null });
      return { ...this.orders.get(id) };
    }
    const fillQty = type === 'limit' ? Number((qty * this.iocFillShare).toFixed(6)) : qty;
    const at = type === 'limit' ? price : this.price;
    this.free.BTC -= fillQty; this.free.USDC += fillQty * at;
    return { id, status: 'closed', amount: qty, filled: fillQty, average: fillQty ? at : null };
  }
  /** The book fills `qty` of a resting buy at its price. */
  fill(id, qty) {
    const o = this.orders.get(id); o.filled += qty; o.average = o.price;
    this.locked -= qty * o.price; this.free.BTC += qty;
    if (o.filled >= o.amount) o.status = 'closed';
  }
  async fetchOrderStatus(id) { return { ...this.orders.get(id) }; }
  async cancelOrder(id) {
    this.calls.push({ type: 'cancel', id });
    if (this.cancelFailures-- > 0) throw new Error('cancel unavailable');
    if (this.fillOnCancel > 0) { this.fill(id, this.fillOnCancel); this.fillOnCancel = 0; }
    const o = this.orders.get(id); o.status = 'canceled';
    const rest = (o.amount - o.filled) * o.price; this.locked -= rest; this.free.USDC += rest;
  }
}

const dataDir = runtimeDir('data');
beforeEach(() => {
  for (const f of ['satellite_orders.json', 'position_state.json', 'position_state.json.bak']) fs.rmSync(path.join(dataDir, f), { force: true });
});
const trader = (ex) => new LiveTrader({ maxPositionPct: 0.25, stopLossPct: 0.05, takeProfitPct: 0.1, maxOpenPositions: 4, quoteCurrency: 'USDC' }, ex);
const order = (now) => ({ limitPrice: 99.5, validUntil: now + 4 * H, sizeUsd: 125, stopPrice: 96.5, plan });

describe('live satellites: the resting limit buy', () => {
  test('a GTC limit locks its USDC; Binance reports it filled → a position with its plan', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    assert.equal(ex.calls[0].params.timeInForce, 'GTC');
    assert.equal(placed.limitPrice, 99.5);
    const st = await t.getStatus();
    assert.equal(st.reserved, placed.reserve);
    assert.ok(Math.abs(calcEquityFromStatus(st) - 1000) < 0.01);
    assert.equal(await t.satelliteTick(KEY, 100, { now: now + 60_000 }), null); // still resting
    ex.fill(placed.orderId, placed.qty);
    const fill = await t.satelliteTick(KEY, 99.4, { now: now + 120_000 });
    assert.equal(fill.side, 'BUY');
    assert.equal(fill.entryPrice, 99.5);
    assert.equal(fill.stopLoss, 96.5);
    assert.equal(t.pendingSatelliteKeys().length, 0);
    assert.equal((await t.getStatus()).positions[0].isSatellite, true);
  });

  test('expiry cancels the order; nothing filled → no position, cash back', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    await t.placeSatelliteOrder(KEY, order(now));
    assert.equal(await t.satelliteTick(KEY, 101, { now: now + 4 * H }), null);
    assert.equal(t.pendingSatelliteKeys().length, 0);
    assert.equal(t.positions.size, 0);
    assert.ok(Math.abs(ex.free.USDC - 1000) < 0.01);
  });

  test('a part fill is managed immediately; polling and expiry never duplicate it', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    const fill = await t.satelliteTick(KEY, 99.8, { now: now + H });
    assert.equal(fill.qty, 0.5);
    assert.equal(t.positions.get(KEY).qty, 0.5);
    assert.equal((await t.getStatus()).reserved, Number(((placed.qty - 0.5) * 99.5).toFixed(2)));
    assert.equal(await t.satelliteTick(KEY, 99.8, { now: now + 2 * H }), null);
    assert.equal(await t.satelliteTick(KEY, 100.2, { now: now + 4 * H }), null);
    assert.equal(t.positions.get(KEY).qty, 0.5);
    assert.equal(t.pendingSatelliteKeys().length, 0);
  });

  test('a stop protects a partial fill before expiry and cancels the remainder first', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    await t.satelliteTick(KEY, 99.8, { now: now + H });
    ex.price = 96;
    const exit = await t.satelliteTick(KEY, 96, { now: now + 2 * H });
    assert.equal(exit.reason, 'sat_stop');
    assert.equal(exit.qty, 0.5);
    assert.equal(ex.calls.at(-2).type, 'cancel');
    assert.equal(ex.calls.at(-1).side, 'sell');
    assert.equal(t.pendingSatelliteKeys().length, 0);
    assert.equal(t.positions.size, 0);
  });

  test('a fill racing cancellation is included in the stop exit', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    await t.satelliteTick(KEY, 99.8, { now: now + H });
    ex.fillOnCancel = 0.2; ex.price = 96;
    const exit = await t.satelliteTick(KEY, 96, { now: now + 2 * H });
    assert.equal(exit.qty, 0.7);
    assert.equal(t.positions.size, 0);
    assert.ok(Math.abs(ex.free.BTC) < 1e-8);
  });

  test('a partial fill already below its stop exits on the first observation', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5); ex.price = 96;
    const exit = await t.satelliteTick(KEY, 96, { now });
    assert.equal(exit.reason, 'sat_stop');
    assert.equal(exit.qty, 0.5);
    assert.equal(t.pendingSatelliteKeys().length, 0);
  });

  test('a failed cancel does not prevent protection; later fills retain the exit intent', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    await t.satelliteTick(KEY, 99.8, { now });
    ex.cancelFailures = 1; ex.price = 96;
    assert.equal((await t.satelliteTick(KEY, 96, { now: now + H })).qty, 0.5);
    assert.equal(t.pendingSatelliteKeys().length, 1);
    ex.fill(placed.orderId, 0.2); ex.price = 100;
    const later = await t.satelliteTick(KEY, 100, { now: now + 2 * H });
    assert.equal(later.reason, 'sat_stop');
    assert.equal(later.qty, 0.2);
    assert.equal(t.pendingSatelliteKeys().length, 0);
    assert.equal(t.positions.size, 0);
  });

  test('overlapping polls credit a fill only once', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    const results = await Promise.all([t.satelliteTick(KEY, 99.8, { now }), t.satelliteTick(KEY, 99.8, { now })]);
    assert.equal(results.filter((r) => r?.side === 'BUY').length, 1);
    assert.equal(t.positions.get(KEY).qty, 0.5);
  });
});

describe('live satellites: exits', () => {
  async function filled() {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, placed.qty);
    await t.satelliteTick(KEY, 99.5, { now });
    return { ex, t, now, qty: placed.qty };
  }

  test('a stop sells with an IOC limit 0.3% under the price', async () => {
    const { ex, t, now, qty } = await filled();
    ex.price = 96;
    const exit = await t.satelliteTick(KEY, 96, { now: now + H });
    assert.equal(exit.reason, 'sat_stop');
    const sell = ex.calls.at(-1);
    assert.equal(sell.type, 'limit');
    assert.equal(sell.params.timeInForce, 'IOC');
    assert.equal(sell.price, Number((96 * 0.997).toFixed(2)));
    assert.equal(exit.qty, qty);
    assert.equal(t.positions.size, 0);
  });

  test('what the IOC limit leaves sells at market — the catastrophe fallback', async () => {
    const { ex, t, now, qty } = await filled();
    ex.price = 95; ex.iocFillShare = 0.4;
    const exit = await t.satelliteTick(KEY, 95, { now: now + H });
    assert.equal(ex.calls.at(-1).type, 'market');
    assert.ok(Math.abs(exit.qty - qty) < 1e-6);
    assert.equal(t.positions.size, 0);
  });

  test("the scalper's risk check leaves a satellite alone", async () => {
    const { t } = await filled();
    assert.equal(await t.checkRisk(KEY, 50), null);
    assert.equal(t.positions.size, 1);
  });

  test('overlapping stop ticks cannot sell the same position twice', async () => {
    const { ex, t, now } = await filled();
    ex.price = 96;
    const results = await Promise.all([t.satelliteTick(KEY, 96, { now: now + H }), t.satelliteTick(KEY, 96, { now: now + H })]);
    assert.equal(results.filter((r) => r?.side === 'SELL').length, 1);
    assert.ok(Math.abs(ex.free.BTC) < 1e-8);
  });
});

describe('live satellites: restart', () => {
  test('a transient Windows rename lock does not lose the saved resting order', async (ctx) => {
    const rename = fs.renameSync;
    let locked = false;
    ctx.mock.method(fs, 'renameSync', (from, to) => {
      if (!locked && to === path.join(dataDir, 'satellite_orders.json')) {
        locked = true;
        throw Object.assign(new Error('temporary destination lock'), { code: 'EPERM' });
      }
      return rename(from, to);
    });
    const ex = new FakeLimitExchange(); const now = Date.now();
    await trader(ex).placeSatelliteOrder(KEY, order(now));
    assert.equal(locked, true);
    assert.deepEqual(trader(ex).pendingSatelliteKeys(), [KEY]);
  });

  test('a partial position and its pending remainder restore without double-counting later fills', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, 0.5);
    await t.satelliteTick(KEY, 99.8, { now });
    const t2 = trader(ex);
    await t2.restorePositionsFromExchange(['BTC/USDC'], async () => ({ last: 99.8 }), () => ({}), []);
    assert.equal(t2.positions.get(KEY).qty, 0.5);
    assert.equal(t2.positions.has('BTC/USDC'), false);
    ex.fill(placed.orderId, 0.2);
    const nextFill = await t2.satelliteTick(KEY, 99.8, { now: now + 2 * H });
    assert.equal(nextFill.qty, 0.2);
    assert.equal(t2.positions.get(KEY).qty, 0.7);
    assert.equal(await t2.satelliteTick(KEY, 99.8, { now: now + 3 * H }), null);
  });

  test('a crash after the position write but before the order write does not credit the fill again', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    const oldOrderState = fs.readFileSync(path.join(dataDir, 'satellite_orders.json'));
    ex.fill(placed.orderId, 0.5);
    await t.satelliteTick(KEY, 99.8, { now });
    fs.writeFileSync(path.join(dataDir, 'satellite_orders.json'), oldOrderState);
    const t2 = trader(ex);
    await t2.restorePositionsFromExchange(['BTC/USDC'], async () => ({ last: 99.8 }), () => ({}), []);
    assert.equal(await t2.satelliteTick(KEY, 99.8, { now: now + H }), null);
    assert.equal(t2.positions.get(KEY).qty, 0.5);
  });

  test('a resting order is reloaded from its state file', async () => {
    const ex = new FakeLimitExchange(); const now = Date.now();
    const placed = await trader(ex).placeSatelliteOrder(KEY, order(now));
    const t2 = trader(ex);
    assert.deepEqual(t2.pendingSatelliteKeys(), [KEY]);
    ex.fill(placed.orderId, placed.qty);
    assert.equal((await t2.satelliteTick(KEY, 99.5, { now: now + H })).side, 'BUY');
  });

  test('a satellite position restores with its moved stop; the scalper restore does not adopt its coins', async () => {
    const ex = new FakeLimitExchange(); const t = trader(ex); const now = Date.now();
    const placed = await t.placeSatelliteOrder(KEY, order(now));
    ex.fill(placed.orderId, placed.qty);
    await t.satelliteTick(KEY, 99.5, { now });
    await t.satelliteTick(KEY, 103, { now: now + H }); // past +1R: stop to entry
    const t2 = trader(ex);
    await t2.restorePositionsFromExchange(['BTC/USDC'], async () => ({ last: 103 }), () => ({}), []);
    const pos = t2.positions.get(KEY);
    assert.equal(pos.isSatellite, true);
    assert.equal(pos.stopLoss, 99.5);
    assert.equal(pos.takeProfit, Infinity);
    assert.equal(pos.timeLimitAt, t.positions.get(KEY).timeLimitAt);
    assert.equal(t2.positions.has('BTC/USDC'), false);
  });
});

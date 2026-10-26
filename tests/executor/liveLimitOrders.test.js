/**
 * LiveTrader sends no naked market orders: every scalper and sleeve order is an IOC
 * limit capped `risk.limitCapPct` (0.5%) past the price, against a fake exchange that
 * fills IOC limits only within their price.
 *
 * Live scenarios covered: a scalper buy fills at the book within the cap; a price that
 * ran past the cap buys nothing (no market fallback on a buy); a part fill opens the
 * part; a stop sells with an IOC limit under the price and sends only what that leaves
 * to market; a failed market fallback keeps the unsold rest as the position; the cap
 * never locks more quote than is free; the sleeve trims with the same capped sell.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { runtimeDir } from '../../src/utils/runtimePaths.js';

const SYM = 'BTC/USDC';
const RISK = { maxPositionPct: 0.15, stopLossPct: 0.05, takeProfitPct: 0.20, trailingStopPct: 0, maxOpenPositions: 4 };

/** IOC limits fill a share of their qty at the book price, if the book is within the limit. */
class FakeBook {
  constructor() {
    this.free = { USDC: 1000, BTC: 0 }; this.price = 100; this.n = 0; this.calls = [];
    this.buyFillShare = 1; this.sellFillShare = 1; this.marketFails = false;
  }
  async fetchBalance() { return { free: { ...this.free }, total: { ...this.free } }; }
  async amountToPrecision(_s, q) { return Number(Number(q).toFixed(6)); }
  async priceToPrecision(_s, p) { return Number(Number(p).toFixed(2)); }
  async getMarketLimits() { return { minQty: 0, minNotional: 0 }; }
  async fetchTicker() { return { last: this.price }; }
  async fetchOpenOrders() { return []; }
  async createOrder(_s, type, side, qty, limit, params = {}) {
    this.calls.push({ type, side, qty, price: limit, params });
    const id = `o${++this.n}`;
    if (type === 'market' && this.marketFails) throw new Error('market order rejected');
    let filled = qty;
    if (type === 'limit') {
      const within = side === 'buy' ? this.price <= limit : this.price >= limit;
      filled = within ? Number((qty * (side === 'buy' ? this.buyFillShare : this.sellFillShare)).toFixed(6)) : 0;
    }
    if (side === 'buy') { this.free.USDC -= filled * this.price; this.free.BTC += filled; }
    else { this.free.USDC += filled * this.price; this.free.BTC -= filled; }
    return { id, status: filled > 0 ? 'closed' : 'expired', amount: qty, filled, average: filled > 0 ? this.price : null };
  }
}

const dataDir = runtimeDir('data');
beforeEach(() => {
  for (const f of ['satellite_orders.json', 'position_state.json', 'position_state.json.bak']) fs.rmSync(path.join(dataDir, f), { force: true });
});
const trader = (ex, risk = RISK) => new LiveTrader({ ...risk, quoteCurrency: 'USDC' }, ex);

describe('live limit orders: buys', () => {
  test('a scalper BUY is an IOC limit capped 0.5% over the price, never a market order', async () => {
    const ex = new FakeBook(); const t = trader(ex);
    const opened = await t.execute(SYM, 'BUY', 100, RISK);
    assert.deepEqual(ex.calls[0], { type: 'limit', side: 'buy', qty: 1.5, price: 100.5, params: { timeInForce: 'IOC' } });
    assert.equal(opened.qty, 1.5);
    assert.equal(opened.entryPrice, 100);
    assert.equal(ex.calls.some((c) => c.type === 'market'), false);
  });

  test('a price that ran past the cap buys nothing — no market fallback on a buy', async () => {
    const ex = new FakeBook(); const t = trader(ex);
    ex.price = 101; // the cycle priced 100; the book is now over 100.5
    assert.equal(await t.execute(SYM, 'BUY', 100, RISK), null);
    assert.equal(t.positions.size, 0);
    assert.equal(ex.calls.length, 1);
    assert.equal(ex.free.USDC, 1000);
  });

  test('a part fill opens the part', async () => {
    const ex = new FakeBook(); const t = trader(ex);
    ex.buyFillShare = 0.5;
    const opened = await t.execute(SYM, 'BUY', 100, RISK);
    assert.equal(opened.qty, 0.75);
    assert.equal(t.positions.get(SYM).qty, 0.75);
  });

  test('the cap never locks more quote than is free (a sleeve buy of the whole balance)', async () => {
    const ex = new FakeBook(); const t = trader(ex);
    await t.openCorePosition('BTC/USDC#core', 100, 1000);
    const buy = ex.calls[0];
    assert.equal(buy.price, 100.5);
    assert.ok(buy.qty * buy.price <= 1000, `locks ${buy.qty * buy.price}`);
    assert.ok(buy.qty > 9.94, `buys ${buy.qty}, about all the balance allows`);
    assert.equal(t.positions.get('BTC/USDC#core').isCore, true);
  });

  test('risk.limitCapPct sets the cap', async () => {
    const ex = new FakeBook(); const t = trader(ex, { ...RISK, limitCapPct: 0.01 });
    await t.execute(SYM, 'BUY', 100, RISK);
    assert.equal(ex.calls[0].price, 101);
  });
});

describe('live limit orders: sells', () => {
  async function held() {
    const ex = new FakeBook(); const t = trader(ex);
    await t.execute(SYM, 'BUY', 100, RISK);
    ex.calls.length = 0;
    return { ex, t };
  }

  test('a stop sells with an IOC limit capped 0.5% under the price', async () => {
    const { ex, t } = await held();
    ex.price = 94.9;
    const exit = await t.checkRisk(SYM, 94.9);
    assert.equal(exit.reason, 'stop_loss');
    assert.deepEqual(ex.calls[0], { type: 'limit', side: 'sell', qty: 1.5, price: 94.43, params: { timeInForce: 'IOC' } });
    assert.equal(ex.calls.length, 1);
    assert.equal(exit.qty, 1.5);
    assert.equal(t.positions.size, 0);
  });

  test('what the IOC limit leaves sells at market — the catastrophe fallback', async () => {
    const { ex, t } = await held();
    ex.price = 104; ex.sellFillShare = 0.4;
    const exit = await t.execute(SYM, 'SELL', 104, RISK);
    assert.equal(ex.calls[0].type, 'limit');
    assert.equal(ex.calls.at(-1).type, 'market');
    assert.equal(ex.calls.at(-1).qty, 0.9);
    assert.equal(exit.qty, 1.5);
    assert.equal(exit.pnl, 6);
    assert.equal(t.positions.size, 0);
  });

  test('a failed market fallback keeps the unsold rest as the position', async () => {
    const { ex, t } = await held();
    ex.price = 104; ex.sellFillShare = 0.4; ex.marketFails = true;
    const exit = await t.execute(SYM, 'SELL', 104, RISK);
    assert.equal(exit.qty, 0.6);
    assert.equal(exit.pnl, 2.4);
    assert.equal(t.positions.get(SYM).qty, 0.9);
  });

  test('a sell the limit cannot fill and the market rejects closes nothing', async () => {
    const { ex, t } = await held();
    ex.price = 104; ex.sellFillShare = 0; ex.marketFails = true;
    assert.equal(await t.execute(SYM, 'SELL', 104, RISK), null);
    assert.equal(t.positions.get(SYM).qty, 1.5);
  });

  test('the sleeve trims with the same capped sell', async () => {
    const ex = new FakeBook(); const t = trader(ex);
    await t.openCorePosition('BTC/USDC#core', 100, 500);
    ex.calls.length = 0;
    const trim = await t.resizeCorePosition('BTC/USDC#core', 100, -100);
    assert.deepEqual(ex.calls[0], { type: 'limit', side: 'sell', qty: 1, price: 99.5, params: { timeInForce: 'IOC' } });
    assert.equal(trim.qty, 1);
    assert.equal(trim.price, 100);
  });
});

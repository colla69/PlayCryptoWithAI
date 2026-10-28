/**
 * Satellite order contract: the simulator, PaperTrader and LiveTrader (fake exchange) run
 * the same script of prices and must agree on every fill and exit — the guard that the
 * three order adapters keep one set of satellite rules (src/engine/satellites.js).
 *
 * Each script is a list of ticks; the simulator meets each as a flat 15m bar
 * (open = high = low = close), the traders as a risk-loop price. Fees and slippage are off
 * so only the rules are compared. A tick on an hour's close carries that hour's RSI.
 */
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { runtimeDir } from '../../src/utils/runtimePaths.js';

const H = 3_600_000;
const M15 = 900_000;
const T0 = Date.UTC(2026, 9, 26, 8, 0, 0);
const KEY = 'ETH/USDC#bo';
const ORDER = { limitPrice: 99.5, validUntil: T0 + 4 * H, sizeUsd: 125, stopPrice: 96.5 };
const tiers = [{ minProfit: 0.01, rsiBelow: 35 }, { minProfit: 0.02, rsiBelow: 45 }, { minProfit: 0.04, rsiBelow: 55 }];
const planOf = (over = {}) => ({ breakEvenAtR: 1, targetR: null, timeLimitMs: 48 * H, tiers, ...over });

/** The fake exchange fills a resting buy when the price trades at or under it, and an IOC sell at the price. */
class Exchange {
  constructor() { this.free = { USDC: 1000, ETH: 0 }; this.price = 100; this.orders = new Map(); this.n = 0; }
  async fetchBalance() { return { free: { ...this.free }, total: { ...this.free } }; }
  async amountToPrecision(_s, q) { return Number(Number(q).toFixed(8)); }
  async priceToPrecision(_s, p) { return Number(Number(p).toFixed(8)); }
  async getMarketLimits() { return { minQty: 0, minNotional: 0 }; }
  async fetchTicker() { return { last: this.price }; }
  async createOrder(_s, type, side, qty, price) {
    const id = `o${++this.n}`;
    if (type === 'limit' && side === 'buy') {
      this.free.USDC -= qty * price;
      this.orders.set(id, { id, status: 'open', amount: qty, filled: 0, price, average: null });
      return { ...this.orders.get(id) };
    }
    this.free.ETH -= qty; this.free.USDC += qty * this.price;
    return { id, status: 'closed', amount: qty, filled: qty, average: this.price };
  }
  touch(price) {
    this.price = price;
    for (const o of this.orders.values()) {
      if (o.status === 'open' && price <= o.price) { o.status = 'closed'; o.filled = o.amount; o.average = o.price; this.free.ETH += o.amount; }
    }
  }
  async fetchOrderStatus(id) { return { ...this.orders.get(id) }; }
  async cancelOrder(id) { const o = this.orders.get(id); o.status = 'canceled'; this.free.USDC += (o.amount - o.filled) * o.price; }
}

beforeEach(() => {
  for (const f of ['satellite_orders.json', 'position_state.json', 'position_state.json.bak']) fs.rmSync(path.join(runtimeDir('data'), f), { force: true });
});

/** Runs one script on each adapter; returns [{fill, exit}] per adapter. */
async function runAll(ticks, plan) {
  const out = [];
  // simulator
  {
    const s = new BacktestSimulator({ initialBalance: 1000, feePct: 0, slippagePct: 0 });
    s.setTimestamp(T0);
    s.placeSatelliteOrder(KEY, { ...ORDER, plan, slippagePct: 0 });
    out.push(await walk((tk) => s.replaySatelliteBar(KEY, { timestamp: tk.t, open: tk.p, high: tk.p, low: tk.p, close: tk.p }, { rsi: tk.rsi ?? null }), ticks));
  }
  // paper
  {
    const p = new PaperTrader({ initialBalance: 1000, maxPositionPct: 0.25, stopLossPct: 0.05, takeProfitPct: 0.1 });
    p.placeSatelliteOrder(KEY, { ...ORDER, plan });
    out.push(await walk((tk) => p.satelliteTick(KEY, tk.p, ctx(tk)), ticks));
  }
  // live
  {
    const ex = new Exchange();
    const l = new LiveTrader({ maxPositionPct: 0.25, stopLossPct: 0.05, takeProfitPct: 0.1, maxOpenPositions: 4, quoteCurrency: 'USDC' }, ex);
    await l.placeSatelliteOrder(KEY, { ...ORDER, plan });
    out.push(await walk(async (tk) => { ex.touch(tk.p); return l.satelliteTick(KEY, tk.p, ctx(tk)); }, ticks));
  }
  return out;
}
// The simulator reads an hour close from the bar's time; the traders are told.
const ctx = (tk) => ({ now: tk.t, rsi: tk.rsi ?? null, hourClosed: (tk.t + M15) % H === 0 });
async function walk(step, ticks) {
  let fill = null; let exit = null;
  for (const tk of ticks) {
    const r = await step(tk);
    if (r?.side === 'BUY') fill = Number(r.entryPrice);
    else if (r && (r.exitTime != null || r.side === 'SELL')) { exit = { reason: r.reason, price: Number(r.exitPrice) }; break; }
  }
  return { fill, exit };
}
// ticks every 15 minutes from T0
const script = (prices, rsiAt = {}) => prices.map((p, k) => ({ t: T0 + (k + 1) * M15, p, ...(rsiAt[k] != null && { rsi: rsiAt[k] }) }));

describe('satellite contract: simulator ≡ paper ≡ live', () => {
  // [ticks, the simulator's expected outcome] — pinned, so three adapters that all fail
  // the same way cannot pass by agreeing
  const cases = {
    'filled, then stopped': [script([100, 99.4, 98, 96.4]), { fill: 99.5, exit: { reason: 'sat_stop', price: 96.4 } }],
    'filled, break-even after +1R, then out at entry': [script([99.5, 101, 102.6, 101, 99.4]), { fill: 99.5, exit: { reason: 'sat_breakeven', price: 99.4 } }],
    'filled, tier exit after an hour close under RSI 45 at +2.5%': [script([99.4, 100.5, 102, 102, 101.9, 101.8], { 2: 40 }), { fill: 99.5, exit: { reason: 'sat_tier', price: 102 } }],
    'never filled, expires': [script(Array(17).fill(100)), { fill: null, exit: null }],
  };
  for (const [name, [ticks, expected]] of Object.entries(cases)) {
    test(name, async () => {
      const [sim, paper, live] = await runAll(ticks, planOf());
      assert.deepEqual(sim, expected, `simulator: ${JSON.stringify(sim)}`);
      assert.deepEqual(paper, sim, `paper ≠ simulator: ${JSON.stringify({ sim, paper })}`);
      assert.deepEqual(live, sim, `live ≠ simulator: ${JSON.stringify({ sim, live })}`);
    });
  }
  test('2R target and the time limit agree too', async () => {
    const target = await runAll(script([99.5, 102, 105.6]), planOf({ targetR: 2, tiers: null }));
    assert.equal(target[0].exit.reason, 'sat_target');
    assert.deepEqual(target[1], target[0]); assert.deepEqual(target[2], target[0]);
    const timed = await runAll(script([99.5, 100, 100.2, 100.3, 100.4]), planOf({ timeLimitMs: H, tiers: null }));
    assert.equal(timed[0].exit.reason, 'sat_time');
    assert.deepEqual(timed[1], timed[0]); assert.deepEqual(timed[2], timed[0]);
  });
});

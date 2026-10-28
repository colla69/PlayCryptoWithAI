/**
 * One order contract (plan 2026-10 single-engine rebuild, step 4).
 *
 * LiveTrader, PaperTrader and BacktestSimulator are the three order handlers. The
 * engine calls them the same way — execute(symbol, decision, price, …) at a cycle,
 * checkRisk(symbol, price) on every price tick — so the same calls must give the same
 * trades. LiveTrader runs against a fake exchange that fills market orders at the
 * tick price. Fees and slippage are 0 here: live's recorded P&L excludes fees, paper
 * has none, the simulator models them (a separate, documented difference).
 *
 * Found while writing this: paper used a hardcoded $10 floor where live and the
 * simulator use the shared $11 (exchangeLimits.js); the last scenario pins it.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';

const RISK = {
  maxPositionPct: 0.15, stopLossPct: 0.05, takeProfitPct: 0.20, trailingStopPct: 0,
  breakEvenTriggerPct: 0.10, maxOpenPositions: 4,
};
const SYM = 'BTC/USDC';

class FakeExchange {
  constructor(quote) { this.free = { USDC: quote, BTC: 0 }; this.price = 0; this.n = 0; }
  async fetchBalance() { return { free: { ...this.free }, total: { ...this.free } }; }
  async amountToPrecision(_s, qty) { return Number(Number(qty).toFixed(8)); }
  async getMarketLimits() { return { minQty: 0, minNotional: 0 }; }
  async fetchTicker() { return { last: this.price }; }
  async fetchOpenOrders() { return []; }
  async createOrder(_s, _type, side, qty) {
    const cost = qty * this.price;
    if (side === 'buy') { this.free.USDC -= cost; this.free.BTC += qty; }
    else { this.free.USDC += cost; this.free.BTC -= qty; }
    return { id: `fake-${++this.n}`, average: this.price, filled: qty, status: 'closed' };
  }
}

/** Each handler behind the same three calls. */
function handlers(quote, risk = RISK) {
  const exchange = new FakeExchange(quote);
  const live = new LiveTrader({ ...risk, quoteCurrency: 'USDC' }, exchange);
  const paper = new PaperTrader({ ...risk, initialBalance: quote });
  const sim = new BacktestSimulator({ ...risk, initialBalance: quote, feePct: 0, slippagePct: 0 });
  return [
    { name: 'live', open: (p) => { exchange.price = p; return live.execute(SYM, 'BUY', p, risk); },
      tick: (p) => { exchange.price = p; return live.checkRisk(SYM, p); },
      sell: (p) => { exchange.price = p; return live.execute(SYM, 'SELL', p, risk); } },
    { name: 'paper', open: async (p) => paper.execute(SYM, 'BUY', p, risk),
      tick: async (p) => paper.checkRisk(SYM, p),
      sell: async (p) => paper.execute(SYM, 'SELL', p, risk) },
    { name: 'simulator', open: async (p) => sim.execute(SYM, 'BUY', p),
      tick: async (p) => sim.checkRisk(SYM, p),
      sell: async (p) => sim.execute(SYM, 'SELL', p) },
  ];
}

/** Runs one script on every handler; returns each handler's normalized outcome. */
async function play(script, quote = 1000, risk = RISK) {
  const out = {};
  for (const h of handlers(quote, risk)) {
    const opened = await h.open(script.open);
    let closed = null;
    for (const p of script.ticks ?? []) {
      closed = await h.tick(p);
      if (closed) break;
    }
    if (!closed && script.sell != null) closed = await h.sell(script.sell);
    out[h.name] = {
      opened: opened ? Number(Number(opened.qty).toFixed(8)) : null,
      reason: closed?.reason ?? null,
      exitPrice: closed ? Number(closed.exitPrice ?? closed.price) : null,
      pnl: closed ? Number(Number(closed.pnl).toFixed(2)) : null,
    };
  }
  return out;
}

const sameEverywhere = (out) => {
  assert.deepEqual(out.paper, out.live, 'paper ≡ live');
  assert.deepEqual(out.simulator, out.live, 'simulator ≡ live');
  return out.live;
};

describe('order contract: live ≡ paper ≡ simulator', () => {
  test('a tick through the stop closes at that tick', async () => {
    const r = sameEverywhere(await play({ open: 100, ticks: [98, 94.9] }));
    assert.deepEqual(r, { opened: 1.5, reason: 'stop_loss', exitPrice: 94.9, pnl: -7.65 });
  });

  test('a tick through the target closes at that tick', async () => {
    const r = sameEverywhere(await play({ open: 100, ticks: [110, 121] }));
    assert.equal(r.reason, 'take_profit');
    assert.equal(r.exitPrice, 121);
  });

  test('break-even locks at the trigger, then exits at entry × 1.002 or below', async () => {
    const r = sameEverywhere(await play({ open: 100, ticks: [111, 105, 100.1] }));
    assert.deepEqual(r, { opened: 1.5, reason: 'stop_loss', exitPrice: 100.1, pnl: 0.15 });
  });

  test('a strategy SELL closes at the cycle price', async () => {
    const r = sameEverywhere(await play({ open: 100, ticks: [103], sell: 104 }));
    assert.deepEqual(r, { opened: 1.5, reason: 'strategy_sell', exitPrice: 104, pnl: 6 });
  });

  test('a trailing stop follows the high and closes when crossed', async () => {
    const risk = { ...RISK, trailingStopPct: 0.10, takeProfitPct: 5, breakEvenTriggerPct: 0 };
    const r = sameEverywhere(await play({ open: 100, ticks: [130, 125, 116.9] }, 1000, risk));
    assert.equal(r.reason, 'trailing_stop');
    assert.equal(r.exitPrice, 116.9);
  });

  test('an armed trailing stop waits for the arm level, then trails', async () => {
    // Trail 3%, arm at +5%: 104 then a dip to 101.5 stops nothing (unarmed, a plain
    // trail would sit at 100.88); 110 arms it at 106.7; 106 closes.
    const risk = { ...RISK, trailingStopPct: 0.03, trailArmPct: 0.05, takeProfitPct: 5, breakEvenTriggerPct: 0 };
    const r = sameEverywhere(await play({ open: 100, ticks: [104, 101.5, 110, 106] }, 1000, risk));
    assert.deepEqual(r, { opened: 1.5, reason: 'trailing_stop', exitPrice: 106, pnl: 9 });
  });

  test('every handler refuses an order under the shared $11 floor', async () => {
    // 15% of $70 = $10.50: paper's old hardcoded $10 floor took it, live never would.
    const r = sameEverywhere(await play({ open: 100, ticks: [94] }, 70));
    assert.deepEqual(r, { opened: null, reason: null, exitPrice: null, pnl: null });
  });
});

describe('order contract: the min-notional bump', () => {
  const bumpRisk = { ...RISK, minNotionalBump: { enabled: true, minRatio: 0.5 } };

  test('an order under the floor but over half of it is bought at the floor, on every handler', async () => {
    // 15% of $70 = $10.50 < $11 → bumped to $11 × 1.005 = $11.055 → 0.11055 at 100.
    const r = sameEverywhere(await play({ open: 100, ticks: [94] }, 70, bumpRisk));
    assert.equal(r.opened, 0.11055);
    assert.equal(r.reason, 'stop_loss');
  });

  test('an order under half the floor is still refused', async () => {
    // 15% of $30 = $4.50 < $5.50.
    const r = sameEverywhere(await play({ open: 100, ticks: [94] }, 30, bumpRisk));
    assert.equal(r.opened, null);
  });

  test('off by default', async () => {
    const r = sameEverywhere(await play({ open: 100, ticks: [94] }, 70));
    assert.equal(r.opened, null);
  });
});

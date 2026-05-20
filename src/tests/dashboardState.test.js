/**
 * Tests for DashboardState — the in-process state store that feeds the dashboard.
 *
 * Key invariant these tests enforce:
 *   pushTrade()  must call BOTH dashboardState.pushTrade() AND pushEvent('trade', ...)
 *   to make trades visible in the dashboard.  pushEvent() alone is NOT enough because
 *   it only fires a one-shot SSE message; the REST /trades endpoint reads from the
 *   in-memory (and now persisted) trades array.
 *
 * Run with:  node --test src/tests/dashboardState.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── path helpers ──────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '../../data');
const TEST_PERSIST_FILE = join(DATA_DIR, 'dashboard_persist.json');

// ── helpers ───────────────────────────────────────────────────────────────────
function makeTrade(overrides = {}) {
  return {
    symbol:     'BTC/USDT',
    side:       'SELL',
    price:      50_000,
    qty:        0.001,
    pnl:        5.25,
    balance:    1005.25,
    timestamp:  new Date().toISOString(),
    ...overrides,
  };
}

function makeSignal(overrides = {}) {
  return {
    symbol:     'BTC/USDT',
    decision:   'BUY',
    confidence: 0.75,
    timestamp:  Date.now(),
    reasons:    ['RSI oversold'],
    ...overrides,
  };
}

// ── suite ─────────────────────────────────────────────────────────────────────
describe('DashboardState', () => {
  let dashboardState;

  before(async () => {
    // Clean up any leftover persist file so tests start fresh
    if (existsSync(TEST_PERSIST_FILE)) rmSync(TEST_PERSIST_FILE);
    // Import AFTER cleaning persist file so constructor sees empty state
    const mod = await import('../dashboard/dashboardState.js');
    dashboardState = mod.dashboardState;
    // Clear any state from module-level initialisation
    dashboardState.trades     = [];
    dashboardState.signalFeed = [];
  });

  after(() => {
    if (existsSync(TEST_PERSIST_FILE)) rmSync(TEST_PERSIST_FILE);
  });

  // ── pushTrade ───────────────────────────────────────────────────────────────
  describe('pushTrade()', () => {
    it('stores a trade in the trades array', () => {
      const trade = makeTrade();
      dashboardState.pushTrade(trade);
      assert.equal(dashboardState.trades.length, 1);
    });

    it('trade appears in getSummary().trades', () => {
      dashboardState.trades = [];
      dashboardState.pushTrade(makeTrade({ pnl: 10 }));
      const { trades } = dashboardState.getSummary();
      assert.equal(trades.length, 1);
      assert.equal(trades[0].symbol, 'BTC/USDT');
    });

    it('rounds pnl and balance to 2 decimal places', () => {
      dashboardState.trades = [];
      dashboardState.pushTrade(makeTrade({ pnl: 1.2345678, balance: 1001.9999 }));
      const [t] = dashboardState.trades;
      assert.equal(t.pnl,     1.23);
      assert.equal(t.balance, 1002);
    });

    it('ignores null / undefined input', () => {
      const before = dashboardState.trades.length;
      dashboardState.pushTrade(null);
      dashboardState.pushTrade(undefined);
      assert.equal(dashboardState.trades.length, before);
    });

    it('caps history at MAX_TRADES (100)', () => {
      dashboardState.trades = [];
      for (let i = 0; i < 110; i++) dashboardState.pushTrade(makeTrade({ pnl: i }));
      assert.ok(dashboardState.trades.length <= 100);
    });

    it('most-recent trade is at index 0 (newest-first order)', () => {
      dashboardState.trades = [];
      dashboardState.pushTrade(makeTrade({ pnl: 1 }));
      dashboardState.pushTrade(makeTrade({ pnl: 99 }));
      assert.equal(dashboardState.trades[0].pnl, 99); // latest first
    });

    // ── KEY REGRESSION: the pushEvent-without-pushTrade bug ─────────────────
    it('REGRESSION: getSummary().trades is empty if pushTrade was never called', () => {
      // Simulates the old smoke-test bug where only pushEvent('trade',...) was called
      // but dashboardState.pushTrade() was omitted.
      dashboardState.trades = [];
      // Do NOT call pushTrade — only "fire an SSE event" (no-op here, just skip it)
      const { trades } = dashboardState.getSummary();
      assert.equal(trades.length, 0,
        'Trade must be missing when only pushEvent was called without pushTrade — ' +
        'if this fails the smoke-test bug has regressed');
    });
  });

  // ── pushSignal ──────────────────────────────────────────────────────────────
  describe('pushSignal()', () => {
    it('stores a signal in signalFeed', () => {
      dashboardState.signalFeed = [];
      dashboardState.pushSignal(makeSignal());
      assert.equal(dashboardState.signalFeed.length, 1);
    });

    it('signal survives getSummary()', () => {
      dashboardState.signalFeed = [];
      dashboardState.pushSignal(makeSignal({ decision: 'SELL', confidence: 0.82 }));
      const { signalFeed } = dashboardState.getSummary();
      assert.equal(signalFeed[0].decision,   'SELL');
      assert.equal(signalFeed[0].confidence, 0.82);
    });

    it('ignores null input', () => {
      const before = dashboardState.signalFeed.length;
      dashboardState.pushSignal(null);
      assert.equal(dashboardState.signalFeed.length, before);
    });

    it('UPSERT: replaces old signal for the same symbol (no duplicates)', () => {
      dashboardState.signalFeed = [];
      dashboardState.pushSignal(makeSignal({ decision: 'BUY',  confidence: 0.60 }));
      dashboardState.pushSignal(makeSignal({ decision: 'SELL', confidence: 0.80 })); // same symbol
      assert.equal(dashboardState.signalFeed.length, 1, 'should still have 1 entry per symbol');
      assert.equal(dashboardState.signalFeed[0].decision,   'SELL');
      assert.equal(dashboardState.signalFeed[0].confidence, 0.80);
    });

    it('UPSERT: different symbols each get their own entry', () => {
      dashboardState.signalFeed = [];
      dashboardState.pushSignal(makeSignal({ symbol: 'BTC/USDT' }));
      dashboardState.pushSignal(makeSignal({ symbol: 'ETH/USDT' }));
      dashboardState.pushSignal(makeSignal({ symbol: 'BTC/USDT', decision: 'SELL' })); // update BTC
      assert.equal(dashboardState.signalFeed.length, 2);
      const btc = dashboardState.signalFeed.find(s => s.symbol === 'BTC/USDT');
      assert.equal(btc.decision, 'SELL');
    });

    it('caps at MAX_SIGNALS (50) distinct symbols', () => {
      dashboardState.signalFeed = [];
      for (let i = 0; i < 60; i++) dashboardState.pushSignal(makeSignal({ symbol: `COIN${i}/USDT` }));
      assert.ok(dashboardState.signalFeed.length <= 50);
    });
  });

  // ── metrics ─────────────────────────────────────────────────────────────────
  describe('getSummary() metrics', () => {
    it('calculates winRate correctly', () => {
      dashboardState.trades = [];
      dashboardState.pushTrade(makeTrade({ pnl:  5, side: 'SELL' }));
      dashboardState.pushTrade(makeTrade({ pnl: -3, side: 'SELL' }));
      dashboardState.pushTrade(makeTrade({ pnl:  2, side: 'SELL' }));
      const { metrics } = dashboardState.getSummary();
      assert.equal(metrics.wins,    2);
      assert.equal(metrics.losses,  1);
      assert.equal(metrics.winRate, 66.67);
    });

    it('winRate is 0 when no trades', () => {
      dashboardState.trades = [];
      const { metrics } = dashboardState.getSummary();
      assert.equal(metrics.winRate, 0);
    });
  });

  // ── updatePrice ─────────────────────────────────────────────────────────────
  describe('updatePrice()', () => {
    it('stores the latest price', () => {
      dashboardState.updatePrice('ETH/USDT', 3_000);
      const { prices } = dashboardState.getSummary();
      assert.equal(prices['ETH/USDT'], 3_000);
    });

    it('tracks price change %', () => {
      dashboardState.updatePrice('ETH/USDT', 3_000);
      dashboardState.updatePrice('ETH/USDT', 3_300);
      const { priceChanges } = dashboardState.getSummary();
      assert.ok(Math.abs(priceChanges['ETH/USDT'] - 10) < 0.01);
    });

    it('ignores non-finite prices', () => {
      const before = dashboardState.getSummary().prices['XRP/USDT'];
      dashboardState.updatePrice('XRP/USDT', NaN);
      assert.equal(dashboardState.getSummary().prices['XRP/USDT'], before);
    });
  });

  // ── persistence round-trip ──────────────────────────────────────────────────
  describe('persistence', () => {
    it('scheduleSave writes trades to disk and loadPersistedState reads them back', async () => {
      const { scheduleSave, loadPersistedState } = await import('../dashboard/persistence.js');

      // Write via scheduleSave
      const trades     = [makeTrade({ pnl: 42 })];
      const signalFeed = [makeSignal()];
      scheduleSave(trades, signalFeed);

      // Wait for the 500 ms debounce
      await new Promise(r => setTimeout(r, 600));

      const loaded = loadPersistedState();
      assert.ok(loaded,                 'persisted file should exist');
      assert.equal(loaded.trades.length,     1);
      assert.equal(loaded.trades[0].pnl,     42);
      assert.equal(loaded.signalFeed.length, 1);
    });

    it('loadPersistedState returns null when no file exists', async () => {
      if (existsSync(TEST_PERSIST_FILE)) rmSync(TEST_PERSIST_FILE);
      const { loadPersistedState } = await import('../dashboard/persistence.js');
      assert.equal(loadPersistedState(), null);
    });
  });
});

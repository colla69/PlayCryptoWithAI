/**
 * Risk Manager — Live Trading Scenario Tests
 *
 * Tests simulate real risk situations: daily loss limits, position limits,
 * confidence gates, and day rollovers.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RiskManager } from '../../src/risk/riskManager.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';
import { DEFAULT_RISK } from '../helpers.js';

describe('RiskManager: Confidence Gate', () => {
  test('blocks trade when confidence is below minimum', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.4, status);

    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Confidence'));
  });

  test('allows trade when confidence equals minimum', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.6, status);

    assert.equal(result.allowed, true);
  });

  test('allows trade when confidence exceeds minimum', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.85, status);

    assert.equal(result.allowed, true);
  });

  test('per-symbol confidence override takes priority', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };
    // Global min is 0.6, but symbol override is 0.8
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.7, status, 0.8);

    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('0.80'));
  });
});

describe('RiskManager: Max Open Positions', () => {
  test('blocks BUY when max positions reached', () => {
    const rm = new RiskManager({ ...DEFAULT_RISK, maxOpenPositions: 2 });
    const status = {
      positions: [
        { symbol: 'BTC/USDC' },
        { symbol: 'ETH/USDC' },
      ],
    };
    const result = rm.canTrade('SOL/USDC', 'BUY', 0.9, status);

    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('limit reached'));
  });

  test('allows managing existing position even at max capacity', () => {
    const rm = new RiskManager({ ...DEFAULT_RISK, maxOpenPositions: 2 });
    const status = {
      positions: [
        { symbol: 'BTC/USDC' },
        { symbol: 'ETH/USDC' },
      ],
    };
    // SELL on existing position should always be allowed
    const result = rm.canTrade('BTC/USDC', 'SELL', 0.9, status);

    assert.equal(result.allowed, true);
    assert.ok(result.reason.includes('existing position'));
  });

  test('allows new BUY when below max positions', () => {
    const rm = new RiskManager({ ...DEFAULT_RISK, maxOpenPositions: 3 });
    const status = {
      positions: [{ symbol: 'BTC/USDC' }],
    };
    const result = rm.canTrade('ETH/USDC', 'BUY', 0.8, status);

    assert.equal(result.allowed, true);
  });
});

describe('RiskManager: Daily Loss Limit', () => {
  test('blocks trading after daily loss limit exceeded', () => {
    // initialBalance=200, maxDailyLossPct=0.05 → max daily loss = $10
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };

    // Record losses totaling > $10
    rm.recordTrade(-6);
    rm.recordTrade(-5); // total: -11

    const result = rm.canTrade('BTC/USDC', 'BUY', 0.9, status);
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Daily loss limit'));
  });

  test('allows trading when losses are below limit', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };

    rm.recordTrade(-4); // -$4, limit is $10
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.8, status);

    assert.equal(result.allowed, true);
  });

  test('winning trades offset losses for daily calculation', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { positions: [] };

    rm.recordTrade(-8); // -$8
    rm.recordTrade(5);  // net: -$3, still under $10 limit

    const result = rm.canTrade('BTC/USDC', 'BUY', 0.8, status);
    assert.equal(result.allowed, true);
  });

  test('daily stats are accurate', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    rm.recordTrade(-3);
    rm.recordTrade(7);
    rm.recordTrade(-2);

    const stats = rm.getDailyStats();
    assert.equal(stats.dailyPnL, 2); // -3+7-2 = 2
    assert.equal(stats.tradesCount, 3);
    assert.equal(stats.blocked, false);
  });
});

describe('RiskManager: HOLD Decision', () => {
  test('HOLD always allowed regardless of state', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    rm.recordTrade(-100); // way over daily limit

    const result = rm.canTrade('BTC/USDC', 'HOLD', 0, { positions: [] });
    assert.equal(result.allowed, true);
  });
});

describe('RiskManager: Equity-Scaled Daily Loss Limit', () => {
  // config initialBalance=200 (5% → $10) is only the fallback; a status with
  // live balance/positions rebases the limit to current account equity.

  test('limit scales up with live equity from status', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const status = { balance: 1000, positions: [] }; // 5% → $50 limit

    rm.recordTrade(-11); // over the $10 fallback limit, under $50
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.9, status);
    assert.equal(result.allowed, true);

    rm.recordTrade(-45); // total -56, over $50
    const blocked = rm.canTrade('BTC/USDC', 'BUY', 0.9, status);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.reason.includes('Daily loss limit'));
  });

  test('open position value counts toward equity', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    // 500 cash + 1 × 500 position = 1000 equity → $50 limit
    const status = {
      balance: 500,
      positions: [{ symbol: 'ETH/USDC', qty: 1, currentPrice: 500, entryPrice: 400 }],
    };

    rm.recordTrade(-30); // over $10 fallback, under $50
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.9, status);
    assert.equal(result.allowed, true);
  });

  test('a deposit that grows equity lifts an active block', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    rm.recordTrade(-11); // blocked at the $10 fallback limit

    const before = rm.canTrade('BTC/USDC', 'BUY', 0.9, { balance: 200, positions: [] });
    assert.equal(before.allowed, false);

    const after = rm.canTrade('BTC/USDC', 'BUY', 0.9, { balance: 2000, positions: [] });
    assert.equal(after.allowed, true);
  });

  test('failed balance fetch (equity 0) keeps the last known base', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    rm.canTrade('BTC/USDC', 'BUY', 0.9, { balance: 1000, positions: [] }); // seeds equity

    rm.recordTrade(-11); // under the $50 limit from the seeded equity
    const result = rm.canTrade('BTC/USDC', 'BUY', 0.9, { balance: 0, positions: [] });
    assert.equal(result.allowed, true);
  });
});

describe('calcEquityFromStatus', () => {
  test('sums balance and position market value, prefers currentPrice', () => {
    const equity = calcEquityFromStatus({
      balance: 100,
      positions: [
        { qty: 2, currentPrice: 50, entryPrice: 40 }, // 100
        { qty: 1, entryPrice: 30 },                   // 30 (no currentPrice)
      ],
    });
    assert.equal(equity, 230);
  });

  test('returns 0 for unusable snapshots', () => {
    assert.equal(calcEquityFromStatus({}), 0);
    assert.equal(calcEquityFromStatus({ balance: 0, positions: [] }), 0);
    assert.equal(calcEquityFromStatus({ balance: NaN, positions: [] }), 0);
  });
});

describe('RiskManager: Seed from History', () => {
  test('seeding restores daily PnL from trade history', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const today = new Date().toISOString();

    rm.seedFromHistory([
      { side: 'SELL', pnl: -3, timestamp: today },
      { side: 'SELL', pnl: 5, timestamp: today },
      { side: 'BUY', pnl: 0, timestamp: today }, // BUYs are ignored
    ]);

    const stats = rm.getDailyStats();
    assert.equal(stats.dailyPnL, 2); // -3+5
    assert.equal(stats.tradesCount, 2); // only SELLs count
  });

  test('seeding ignores trades from previous days', () => {
    const rm = new RiskManager(DEFAULT_RISK);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const today = new Date().toISOString();

    rm.seedFromHistory([
      { side: 'SELL', pnl: -50, timestamp: yesterday },
      { side: 'SELL', pnl: -2, timestamp: today },
    ]);

    const stats = rm.getDailyStats();
    assert.equal(stats.dailyPnL, -2); // only today's trade
  });
});

/**
 * Paper Trader — Live Trading Scenario Tests
 *
 * These tests simulate real scenarios that occur during live trading:
 * position opening, SL/TP hits, break-even protection, insufficient balance, etc.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { DEFAULT_RISK } from '../helpers.js';

describe('PaperTrader: Position Opening', () => {
  test('BUY allocates correct percentage of balance', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    const result = trader.execute('BTC/USDC', 'BUY', 60000, DEFAULT_RISK);

    assert.equal(result.side, 'BUY');
    // 200 * 0.15 = 30 USDC allocation
    const expectedAlloc = 200 * 0.15;
    const actualCost = result.qty * 60000;
    assert.ok(Math.abs(actualCost - expectedAlloc) < 1, `Cost ${actualCost} should be ~${expectedAlloc}`);
    // Balance should decrease by the allocation
    assert.ok(trader.getStatus().balance < 200);
  });

  test('BUY sets correct SL and TP levels', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    const result = trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    const status = trader.getStatus();
    const pos = status.positions[0];
    // SL = entry * (1 - 0.065) = 46750
    assert.ok(Math.abs(pos.stopLoss - 50000 * 0.935) < 1);
    // TP = entry * (1 + 0.14) = 57000
    assert.ok(Math.abs(pos.takeProfit - 50000 * 1.14) < 1);
  });

  test('BUY rejected when position already exists for symbol', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    const second = trader.execute('BTC/USDC', 'BUY', 51000, DEFAULT_RISK);

    assert.equal(second, null);
    assert.equal(trader.getStatus().positions.length, 1);
  });

  test('BUY rejected when balance is zero', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 0 });
    const result = trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    assert.equal(result, null);
  });

  test('BUY rejected when order notional below $10 minimum', () => {
    // Balance $50, maxPositionPct 0.15 → allocation = $7.50 < $10
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 50 });
    const result = trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    assert.equal(result, null);
  });

  test('multiple positions for different symbols', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 500 });
    const r1 = trader.execute('BTC/USDC', 'BUY', 60000, DEFAULT_RISK);
    const r2 = trader.execute('ETH/USDC', 'BUY', 3000, DEFAULT_RISK);

    assert.notEqual(r1, null);
    assert.notEqual(r2, null);
    assert.equal(trader.getStatus().positions.length, 2);
  });
});

describe('PaperTrader: Stop Loss Scenarios', () => {
  test('SELL triggers when price hits stop loss', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    // Price drops to SL level (50000 * 0.935 = 46750)
    const result = trader.execute('BTC/USDC', 'HOLD', 46700, DEFAULT_RISK);

    assert.notEqual(result, null);
    assert.equal(result.side, 'SELL');
    assert.equal(result.reason, 'stop_loss');
    assert.ok(result.pnl < 0, 'PnL should be negative on SL');
  });

  test('SELL triggers when price gaps far below SL (flash crash)', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    // Price gaps 20% below entry — simulates flash crash
    const result = trader.execute('BTC/USDC', 'HOLD', 40000, DEFAULT_RISK);

    assert.notEqual(result, null);
    assert.equal(result.reason, 'stop_loss');
    // PnL reflects actual exit price, not SL level
    const expectedPnl = (40000 - 50000) * result.qty;
    assert.ok(Math.abs(result.pnl - expectedPnl) < 0.01);
  });

  test('position survives when price is just above SL', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    // Price is just barely above SL (46750 + a tiny bit)
    const result = trader.execute('BTC/USDC', 'HOLD', 46800, DEFAULT_RISK);
    assert.equal(result, null);
    assert.equal(trader.getStatus().positions.length, 1);
  });
});

describe('PaperTrader: Take Profit Scenarios', () => {
  test('SELL triggers when price hits take profit', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    // Price rises to TP level (50000 * 1.14 = 57000)
    const result = trader.execute('BTC/USDC', 'HOLD', 57100, DEFAULT_RISK);

    assert.notEqual(result, null);
    assert.equal(result.side, 'SELL');
    assert.equal(result.reason, 'take_profit');
    assert.ok(result.pnl > 0, 'PnL should be positive on TP');
  });

  test('position survives when price is just below TP', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);

    const result = trader.execute('BTC/USDC', 'HOLD', 56900, DEFAULT_RISK);
    assert.equal(result, null);
    assert.equal(trader.getStatus().positions.length, 1);
  });
});

describe('PaperTrader: Break-Even Stop', () => {
  test('break-even locks SL at entry+fees after trigger percentage', () => {
    const risk = { ...DEFAULT_RISK, breakEvenTriggerPct: 0.04 };
    const trader = new PaperTrader({ ...risk, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, risk);

    // Price rises 4.5% above entry → triggers break-even (trigger is 4%)
    trader.execute('BTC/USDC', 'HOLD', 52250, risk);

    const pos = trader.getStatus().positions[0];
    // SL should now be at entry * 1.002 = 50100 (covers fees)
    const expectedBE = 50000 * 1.002;
    assert.ok(Math.abs(pos.stopLoss - expectedBE) < 1,
      `SL ${pos.stopLoss} should be ~${expectedBE} (entry+fees)`);
  });

  test('break-even does NOT trigger below threshold', () => {
    const risk = { ...DEFAULT_RISK, breakEvenTriggerPct: 0.04 };
    const trader = new PaperTrader({ ...risk, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, risk);

    // Price rises only 3% — below 4% trigger
    trader.execute('BTC/USDC', 'HOLD', 51500, risk);

    const pos = trader.getStatus().positions[0];
    // SL should still be original (50000 * 0.935)
    assert.ok(pos.stopLoss < 50000, 'SL should still be below entry');
  });

  test('after break-even, SL drop to entry still results in tiny profit (fees covered)', () => {
    const risk = { ...DEFAULT_RISK, breakEvenTriggerPct: 0.04 };
    const trader = new PaperTrader({ ...risk, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, risk);

    // Trigger break-even
    trader.execute('BTC/USDC', 'HOLD', 52500, risk);
    // Now price falls back to break-even SL level
    const result = trader.execute('BTC/USDC', 'HOLD', 50050, risk);

    // Should trigger the SL at 50100
    assert.notEqual(result, null);
    assert.equal(result.reason, 'stop_loss');
    // PnL should be slightly positive (sold at 50050, entry was 50000)
    assert.ok(result.pnl >= 0, `PnL ${result.pnl} should be ≥ 0 after break-even`);
  });
});

describe('PaperTrader: Strategy SELL', () => {
  test('strategy SELL closes position with correct PnL', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    const result = trader.execute('BTC/USDC', 'SELL', 52000, DEFAULT_RISK);

    assert.notEqual(result, null);
    assert.equal(result.side, 'SELL');
    assert.equal(result.reason, 'strategy_sell');
    assert.ok(result.pnl > 0);
  });

  test('strategy SELL on non-existent position returns null', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    const result = trader.execute('BTC/USDC', 'SELL', 50000, DEFAULT_RISK);
    assert.equal(result, null);
  });

  test('HOLD on non-existent position does nothing', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    const result = trader.execute('BTC/USDC', 'HOLD', 50000, DEFAULT_RISK);
    assert.equal(result, null);
  });
});

describe('PaperTrader: Balance Tracking', () => {
  test('winning trade increases balance above initial', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    trader.execute('BTC/USDC', 'HOLD', 57100, DEFAULT_RISK); // TP hit

    assert.ok(trader.getStatus().balance > 200);
  });

  test('losing trade decreases balance below initial', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    trader.execute('BTC/USDC', 'HOLD', 46700, DEFAULT_RISK); // SL hit

    assert.ok(trader.getStatus().balance < 200);
  });

  test('PnL accumulates correctly across multiple trades', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });

    // Trade 1: win
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK);
    const win = trader.execute('BTC/USDC', 'SELL', 53000, DEFAULT_RISK);

    // Trade 2: loss
    trader.execute('ETH/USDC', 'BUY', 3000, DEFAULT_RISK);
    const loss = trader.execute('ETH/USDC', 'HOLD', 2790, DEFAULT_RISK); // SL

    const totalPnL = trader.getStatus().totalPnL;
    const expectedPnL = win.pnl + loss.pnl;
    assert.ok(Math.abs(totalPnL - expectedPnL) < 0.01,
      `totalPnL ${totalPnL} should be ~${expectedPnL}`);
  });
});

describe('PaperTrader: Position Sizing with Risk Override', () => {
  test('position size scales with maxPositionPct override', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });

    // Override to 30% allocation
    const override = { ...DEFAULT_RISK, maxPositionPct: 0.30 };
    const result = trader.execute('BTC/USDC', 'BUY', 50000, override);

    const expectedAlloc = 1000 * 0.30;
    const actualCost = result.qty * 50000;
    assert.ok(Math.abs(actualCost - expectedAlloc) < 1);
  });

  test('second BUY uses reduced balance (not initial)', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 200 });
    trader.execute('BTC/USDC', 'BUY', 50000, DEFAULT_RISK); // uses 30 USDC

    const balanceAfterFirst = trader.getStatus().balance; // ~170
    const result = trader.execute('ETH/USDC', 'BUY', 3000, DEFAULT_RISK);

    // Second allocation = ~170 * 0.15 = ~25.5
    const actualCost = result.qty * 3000;
    const expectedAlloc = balanceAfterFirst * 0.15;
    assert.ok(Math.abs(actualCost - expectedAlloc) < 1);
  });
});

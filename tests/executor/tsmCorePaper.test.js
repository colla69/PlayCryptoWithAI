/**
 * PaperTrader — TSM core sleeve position lifecycle.
 *
 * Live scenarios: core open sizing and guards, immunity to SL/TP/trailing
 * management, coexistence with a scalper position on the same market,
 * flip-close PnL accounting, and restart restore keeping the isCore flag.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { DEFAULT_RISK } from '../helpers.js';

const CORE = 'BTC/USDC#core';

describe('PaperTrader: core position lifecycle', () => {
  test('openCorePosition allocates the requested USD and flags isCore', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    const result = trader.openCorePosition(CORE, 50_000, 500);

    assert.equal(result.side, 'BUY');
    assert.equal(result.isCore, true);
    assert.equal(result.note, '🧲 tsm-core');
    assert.ok(Math.abs(result.qty * 50_000 - 500) < 1);
    assert.ok(Math.abs(trader.getStatus().balance - 500) < 1);

    const pos = trader.getStatus().positions.find((p) => p.symbol === CORE);
    assert.equal(pos.isCore, true);
    assert.equal(pos.stopLoss, 0);
  });

  test('core open is capped at available cash and refuses dust (<$10)', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 100 });
    // Ask for more than the balance → capped at balance, not rejected
    const capped = trader.openCorePosition(CORE, 50_000, 500);
    assert.ok(capped);
    assert.ok(capped.qty * 50_000 <= 100 + 1e-6);

    const broke = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 5 });
    assert.equal(broke.openCorePosition(CORE, 50_000, 500), null);
  });

  test('core position ignores SL/TP/trailing — survives an 80% crash', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 500);

    // Regular risk management runs via execute(); a crash must NOT close a core position
    const result = trader.execute(CORE, 'HOLD', 10_000, DEFAULT_RISK);
    assert.equal(result, null);
    const pos = trader.getStatus().positions.find((p) => p.symbol === CORE);
    assert.ok(pos, 'core position must still be open after crash');
    assert.equal(pos.stopLoss, 0, 'no trailing/break-even mutation');
    assert.equal(pos.currentPrice, 10_000, 'price tracking still works');
  });

  test('core and scalper positions coexist on the same market', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 400);
    const scalp = trader.execute('BTC/USDC', 'BUY', 50_000, DEFAULT_RISK);
    assert.ok(scalp, 'scalper BUY must not be blocked by the core position');

    const symbols = trader.getStatus().positions.map((p) => p.symbol).sort();
    assert.deepEqual(symbols, ['BTC/USDC', CORE]);

    // Scalper SELL closes only the scalper leg
    const sold = trader.execute('BTC/USDC', 'SELL', 51_000, DEFAULT_RISK);
    assert.ok(sold);
    assert.deepEqual(trader.getStatus().positions.map((p) => p.symbol), [CORE]);
  });

  test('closeCorePosition realises PnL with flip reason and core note', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 500);
    const result = trader.closeCorePosition(CORE, 60_000);

    assert.equal(result.reason, 'tsm_core_flip');
    assert.equal(result.note, '🧲 tsm-core');
    assert.equal(result.isCore, true);
    assert.ok(result.pnl > 0);
    // 500 → 600 on the deployed leg: balance ≈ 1100
    assert.ok(Math.abs(trader.getStatus().balance - 1100) < 2);
    assert.equal(trader.getStatus().positions.length, 0);
  });

  test('restorePosition keeps isCore (flag or #core suffix) so stops stay off', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.restorePosition({ symbol: CORE, qty: 0.01, price: 50_000, isCore: true });
    trader.restorePosition({ symbol: 'ETH/USDC#core', qty: 0.1, price: 3000 }); // suffix only

    for (const sym of [CORE, 'ETH/USDC#core']) {
      const closed = trader.execute(sym, 'HOLD', 1, DEFAULT_RISK); // catastrophic price
      assert.equal(closed, null, `${sym} must not be closed by restored-stop logic`);
      assert.ok(trader.getStatus().positions.find((p) => p.symbol === sym && p.isCore));
    }
  });
});

describe('PaperTrader: core position resizing', () => {
  test('resize BUY blends entry price and debits balance', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 500); // qty 0.01 @50k
    const result = trader.resizeCorePosition(CORE, 60_000, 300);

    assert.equal(result.side, 'BUY');
    assert.equal(result.reason, 'tsm_core_resize');
    const pos = trader.getStatus().positions.find((p) => p.symbol === CORE);
    assert.ok(Math.abs(pos.qty - 0.015) < 1e-6);
    // blended entry: (50000×0.01 + 300) / 0.015 = 53333.33
    assert.ok(Math.abs(pos.entryPrice - 53333.33) < 1);
    assert.ok(Math.abs(trader.getStatus().balance - 200) < 1);
    assert.equal(result.positionQty, pos.qty);
  });

  test('resize SELL trims, realises PnL, keeps entry price', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 500); // qty 0.01
    const result = trader.resizeCorePosition(CORE, 60_000, -250);

    assert.equal(result.side, 'SELL');
    // sold ~0.00416667 with +10k/coin gain → pnl ≈ +41.67
    assert.ok(Math.abs(result.pnl - 41.67) < 0.5, `pnl ${result.pnl}`);
    const pos = trader.getStatus().positions.find((p) => p.symbol === CORE);
    assert.ok(Math.abs(pos.qty - 0.00583333) < 1e-6);
    assert.equal(pos.entryPrice, 50_000);
    assert.equal(result.positionQty, pos.qty);
  });

  test('dust resizes are skipped; over-trim delegates to a full close', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.openCorePosition(CORE, 50_000, 500);
    assert.equal(trader.resizeCorePosition(CORE, 50_000, -5), null);
    const closed = trader.resizeCorePosition(CORE, 50_000, -999_999);
    assert.equal(closed.reason, 'tsm_core_flip');
    assert.equal(trader.getStatus().positions.length, 0);
  });

  test('restore prefers post-resize position state from resize records', () => {
    const trader = new PaperTrader({ ...DEFAULT_RISK, initialBalance: 1000 });
    trader.restorePosition({
      symbol: CORE, side: 'SELL', qty: 0.004, price: 60_000,
      isCore: true, reason: 'tsm_core_resize',
      positionQty: 0.006, positionEntryPrice: 50_000,
    });
    const pos = trader.getStatus().positions.find((p) => p.symbol === CORE);
    assert.equal(pos.qty, 0.006);
    assert.equal(pos.entryPrice, 50_000);
    assert.equal(pos.isCore, true);
  });
});

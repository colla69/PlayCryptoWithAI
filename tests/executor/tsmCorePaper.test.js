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

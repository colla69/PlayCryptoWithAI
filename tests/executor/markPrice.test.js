/**
 * markPrice — valuation parity between paper and live.
 *
 * `position.currentPrice` is what calcEquityFromStatus values an open book
 * with, and it used to be written only by checkRisk. Live skipped that call for
 * core sleeve legs; paper never had it at all, because #checkRisk is private and
 * only reachable through execute(), which core legs never go through. Either way
 * the position stayed valued at its entry price forever.
 *
 * Both traders now expose the same marking method and the 5s price poll drives
 * it in both modes, so a position is marked whether or not it carries stops.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { PaperTrader } from '../../src/executor/paperTrader.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';

const KEY = 'BTC/USDC#core';
const ENTRY = 63836.07;
const MARKET = 65221.49;

const coreLeg = () => ({
  qty: 0.00073,
  entryPrice: ENTRY,
  currentPrice: ENTRY,
  initialStopLoss: 0,
  stopLoss: 0,
  takeProfit: 0,
  highWaterMark: ENTRY,
  openedAt: new Date().toISOString(),
  partialExitDone: false,
  isCore: true,
});

const traders = () => [
  ['LiveTrader', new LiveTrader({ quoteCurrency: 'USDC' })],
  ['PaperTrader', new PaperTrader({ initialBalance: 1000, quoteCurrency: 'USDC' })],
];

describe('markPrice — both traders', () => {
  for (const [name, trader] of traders()) {
    test(`${name}: marks an open position to market`, () => {
      trader.positions.set(KEY, coreLeg());
      assert.equal(trader.markPrice(KEY, MARKET), true);
      assert.equal(trader.positions.get(KEY).currentPrice, MARKET);
    });

    test(`${name}: leaves stops and high-water mark untouched`, () => {
      trader.positions.set(KEY, coreLeg());
      trader.markPrice(KEY, MARKET);

      const p = trader.positions.get(KEY);
      assert.equal(p.stopLoss, 0, 'marking must never arm a stop');
      assert.equal(p.takeProfit, 0);
      assert.equal(p.highWaterMark, ENTRY, 'HWM belongs to checkRisk, not marking');
      assert.equal(p.entryPrice, ENTRY);
    });

    test(`${name}: rejects unknown symbols and bad prices`, () => {
      trader.positions.set(KEY, coreLeg());
      assert.equal(trader.markPrice('NOPE/USDC', MARKET), false);
      assert.equal(trader.markPrice(KEY, 0), false);
      assert.equal(trader.markPrice(KEY, -1), false);
      assert.equal(trader.markPrice(KEY, undefined), false);
      assert.equal(trader.positions.get(KEY).currentPrice, ENTRY, 'unchanged after rejection');
    });

    test(`${name}: equity follows the mark`, () => {
      trader.positions.set(KEY, coreLeg());
      const before = calcEquityFromStatus({ balance: 100, positions: [trader.positions.get(KEY)] });
      trader.markPrice(KEY, MARKET);
      const after = calcEquityFromStatus({ balance: 100, positions: [trader.positions.get(KEY)] });

      assert.ok(after > before, 'a rising market must raise valuation');
      assert.equal(after, 100 + 0.00073 * MARKET);
    });
  }
});

describe('the price poll drives it', () => {
  const src = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

  test('refreshOpenPositionPrices marks the trader', () => {
    const start = src.indexOf('async function refreshOpenPositionPrices');
    assert.notEqual(start, -1, 'price poller not found — did it move?');
    const body = src.slice(start, src.indexOf('\n}', start));
    assert.match(
      body, /markPrice/,
      'the 5s poll already fetches the right price for every open position, '
      + 'including core keys — it must mark the trader, or positions without '
      + 'stops are never valued (incident 2026-08-10).',
    );
  });
});

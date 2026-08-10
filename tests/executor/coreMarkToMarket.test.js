/**
 * Core-sleeve mark-to-market — regression tests.
 *
 * `LiveTrader.checkRisk()` is the ONLY writer of `position.currentPrice`. Core
 * sleeve legs carry no stop-loss, so the fast risk loop in `src/main.js` skipped
 * them with a bare `continue` — never calling `checkRisk`, and therefore never
 * marking them. `#positionRows()` then fell back through
 * `position.currentPrice ?? position.entryPrice` for the entire life of the
 * position.
 *
 * Live incident 2026-08-10: `data/equity_history.json` recorded a bit-identical
 * 188.81815737 for six consecutive days while BTC moved 63836 → 65148. The raw
 * `getStatus()` valuation was pinned to the Aug-4 open/restore prices.
 *
 * It stayed invisible because `dashboardState.getSummary()` overrides
 * `currentPrice` from its own 5-second price map — so the dashboard and
 * `/api/performance` showed the correct $191.50 while everything reading the
 * RAW status read the stale number: the daily valuation series, the sleeve's
 * HWM equity ladder (`main.js` `selectSleeveRung`), the weekly-DD breaker
 * reference equity and the daily-loss brake. An understated HWM is the
 * risk-increasing direction — it keeps the sleeve on the most aggressive rung
 * past the point it should de-risk.
 *
 * Two layers below, because the trader contract was already correct — the CALL
 * was missing. A behavioural test alone would have stayed green through the bug.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { LiveTrader } from '../../src/executor/liveTrader.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';

const CORE_KEY = 'BTC/USDC#core';
const ENTRY = 63836.07;
const MARKET = 65148.39;

/** A core leg as `restorePositionsFromExchange` / `openCorePosition` leaves it. */
const seedCoreLeg = () => {
  const trader = new LiveTrader({ quoteCurrency: 'USDC' });
  trader.positions.set(CORE_KEY, {
    qty: 0.00073,
    entryPrice: ENTRY,
    currentPrice: ENTRY,
    initialStopLoss: 0,
    stopLoss: 0,
    takeProfit: 0,
    highWaterMark: ENTRY,
    trailingStopPct: undefined,
    openedAt: new Date().toISOString(),
    partialExitDone: false,
    isCore: true,
  });
  return trader;
};

describe('LiveTrader.checkRisk — core legs are marked, not just skipped', () => {
  test('marks currentPrice and does not close the position', async () => {
    const trader = seedCoreLeg();

    const result = await trader.checkRisk(CORE_KEY, MARKET);

    // Core legs exit only on the momentum-vote flip — never from the risk loop.
    assert.equal(result, null);
    assert.equal(trader.positions.get(CORE_KEY).currentPrice, MARKET);
  });

  test('leaves the stop untouched while marking', async () => {
    const trader = seedCoreLeg();

    await trader.checkRisk(CORE_KEY, MARKET);

    const position = trader.positions.get(CORE_KEY);
    assert.equal(position.stopLoss, 0, 'core legs must never arm a stop');
    assert.equal(position.takeProfit, 0);
  });

  test('an unmarked core leg values at entry — the freeze this guards', () => {
    const stale = seedCoreLeg().positions.get(CORE_KEY);

    // What #positionRows() emits when checkRisk was never called.
    const frozen = calcEquityFromStatus({
      balance: 94.94134037,
      positions: [{ ...stale, currentPrice: stale.currentPrice ?? stale.entryPrice }],
    });
    const marked = calcEquityFromStatus({
      balance: 94.94134037,
      positions: [{ ...stale, currentPrice: MARKET }],
    });

    assert.ok(marked > frozen, 'a rising market must raise recorded equity');
    assert.ok(
      marked - frozen > 0.9,
      `six days of drift must not vanish (got ${(marked - frozen).toFixed(4)})`,
    );
  });

  test('equity tracks the market once the risk loop has marked the leg', async () => {
    const trader = seedCoreLeg();
    const balance = 94.94134037;

    const before = calcEquityFromStatus({ balance, positions: [trader.positions.get(CORE_KEY)] });
    await trader.checkRisk(CORE_KEY, MARKET);
    const after = calcEquityFromStatus({ balance, positions: [trader.positions.get(CORE_KEY)] });

    assert.ok(after > before, 'checkRisk must move the raw valuation');
    assert.equal(after, balance + 0.00073 * MARKET);
  });
});

/**
 * The structural half. `src/main.js` is the entry point — importing it boots the
 * bot — so the call site is asserted against the source text, the same approach
 * tests/backtester/liveParityInventory.test.js uses.
 */
describe('main.js risk loop — the core branch must mark before it continues', () => {
  const source = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');

  /** The body of `if (pos.isCore) { … }` inside the fast risk loop. */
  const coreBranch = () => {
    const start = source.indexOf('if (pos.isCore) {');
    assert.notEqual(start, -1, 'risk loop core branch not found — did the loop move?');
    const end = source.indexOf('continue;', start);
    assert.notEqual(end, -1, 'core branch has no continue — re-read the loop');
    return source.slice(start, end);
  };

  test('calls trader.checkRisk on core positions', () => {
    assert.match(
      coreBranch(),
      /trader\.checkRisk\(/,
      'core legs must be passed to checkRisk — it is the only writer of '
      + 'position.currentPrice. Skipping it freezes equity_history.json and the '
      + 'sleeve HWM ladder at the open price (incident 2026-08-10).',
    );
  });

  test('still retries a failed vote-flip close', () => {
    assert.match(coreBranch(), /closeCorePosition\(/, 'retry path must survive');
  });
});

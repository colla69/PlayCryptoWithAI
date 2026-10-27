/**
 * The engine replay with satellites on (config.satellites), over a fixed synthetic market.
 *
 * Pins: the same input gives the same trades (no hidden state or clock reads); the fixture
 * actually trades breakout satellites (or the checks prove nothing); never more breakout
 * positions open at once than `maxOpen`; and switching satellites off gives the scalper's
 * own trades back exactly (the off path is the parity-tested one).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { SLIPPAGE_TIERS } from '../../src/backtester/baselineFramework.js';
import { replayEngine } from '../../src/backtester/engineReplay.js';
import { syntheticMarket } from '../helpers.js';

const H12 = 12 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 1);
const BARS = 520;
const SYMBOLS = ['BTC/USDC', 'XRP/USDC', 'SOL/USDC', 'ADA/USDC'];

function inputs(satellitesOn) {
  const m = Object.fromEntries(SYMBOLS.map((s, i) => [s, syntheticMarket(200 + i, 30 + i * 9, { t0: T0, bars: BARS })]));
  const pick = (k) => Object.fromEntries(SYMBOLS.map((s) => [s, m[s][k]]));
  const cfg = {
    ...config, symbols: SYMBOLS,
    tsmCore: { ...(config.tsmCore ?? {}), enabled: false }, btcDominance: { enabled: false },
    satellites: {
      ...config.satellites, enabled: satellitesOn, symbols: SYMBOLS,
      // the synthetic volume has no spikes; a lower bar lets the fixture trade
      breakout: { ...config.satellites.breakout, volumeMult: 1.0, closeInRangeMin: 0.5, lookbackBars: 24 },
      strongest: { ...config.satellites.strongest, enabled: false },
    },
  };
  return {
    symbolCandles: pick('c12'), mtf15mCandles: pick('c15'), mtf4hCandles: pick('c4'),
    fromTs: T0 + 420 * H12, toTs: T0 + (BARS - 1) * H12, initialBalance: 1000, slippage: SLIPPAGE_TIERS, cfg, exchangeEvents: [],
  };
}
const key = (t) => [t.symbol, t.openedAt, t.timestamp, t.reason, t.pnl].join('|');

describe('engine replay with satellites', () => {
  test('deterministic; it trades satellites; at most maxOpen breakouts at once', async () => {
    const a = await replayEngine(inputs(true));
    const b = await replayEngine(inputs(true));
    assert.deepEqual(a.trades.map(key), b.trades.map(key));
    const sat = a.trades.filter((t) => String(t.symbol).endsWith('#bo'));
    assert.ok(sat.length >= 3, `the fixture must trade satellites (${sat.length})`);
    const events = sat.flatMap((t) => [[Date.parse(t.openedAt), 1], [Date.parse(t.timestamp), -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let open = 0; let most = 0;
    for (const [, d] of events) { open += d; most = Math.max(most, open); }
    assert.ok(most <= config.satellites.breakout.maxOpen, `${most} breakouts open at once`);
    assert.equal(a.sim.reserved, 0, 'no cash left locked after the last order expired or filled');
  });

  test('satellites off: the scalper trades as without the satellite code', async () => {
    const off = await replayEngine(inputs(false));
    assert.equal(off.trades.filter((t) => /#(bo|rs)$/.test(t.symbol)).length, 0);
    assert.equal(off.sim.satelliteStats.placed, 0);
  });
});

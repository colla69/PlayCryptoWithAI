/**
 * The engine's satellite cycle (src/core/engine.js runSatelliteCycle / onSatelliteBar),
 * with the backtest simulator behind the order interface the replay gives it.
 *
 * Live scenarios covered: a 4h breakout in a 12h uptrend becomes one resting limit buy
 * 0.5% under the close, sized at 12.5% of equity; no order without the uptrend; at most
 * `maxOpen` per strategy; the strategy off, or a trader without limit orders (live today),
 * places nothing; a satellite exit reaches the daily-loss brake.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { createTradingEngine } from '../../src/core/engine.js';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';
import RiskManager from '../../src/risk/index.js';
import { RegimeTracker } from '../../src/engine/regimeClassifier.js';

const H = 3_600_000;
const H4 = 4 * H;
const H12 = 12 * H;
const T = Date.UTC(2026, 9, 25, 0, 0, 0);
const NOW = T + 3_000;
const SYMBOLS = ['AAA/USDC', 'BBB/USDC', 'CCC/USDC'];

/** 450 12h bars ending with the one forming at T: rising (uptrend) or falling. */
const series12h = (rising) => Array.from({ length: 450 }, (_, k) => {
  const close = rising ? 100 * 1.002 ** k : 300 * 0.998 ** k;
  return { timestamp: T - (449 - k) * H12, open: close, high: close * 1.002, low: close * 0.998, close, volume: 100 };
});
/** 70 flat 4h bars closed by T, the last one a breakout on a volume spike when `breakout`. */
const series4h = (breakout) => Array.from({ length: 70 }, (_, k) => {
  const timestamp = T - (70 - k) * H4;
  if (k === 69 && breakout) return { timestamp, open: 100, high: 104, low: 99.5, close: 103.8, volume: 30 };
  return { timestamp, open: 100, high: 101, low: 99, close: 100, volume: 10 };
});

function build({ breakouts = SYMBOLS, rising = true, satPatch = {}, traderHasLimits = true } = {}) {
  const candles = Object.fromEntries(SYMBOLS.map((s) => [s, series12h(rising)]));
  const sim = new BacktestSimulator({ ...config.risk, initialBalance: 1000, feePct: 0.001, slippagePct: 0.001 });
  sim.setTimestamp(T);
  const trader = {
    getStatus: async () => sim.getStatus(),
    ...(traderHasLimits && {
      placeSatelliteOrder: async (key, entry) => sim.placeSatelliteOrder(key, { ...entry, slippagePct: 0.001 }),
      pendingSatelliteKeys: () => [...sim.pendingSatellite.keys()],
      replaySatelliteBar: async (key, bar, ctx) => {
        const r = sim.replaySatelliteBar(key, bar, ctx);
        return r && r.exitTime != null ? { ...r, side: 'SELL' } : r;
      },
    }),
  };
  const cfg = {
    ...config, symbols: SYMBOLS,
    satellites: {
      ...config.satellites, enabled: true, symbols: SYMBOLS,
      strongest: { ...config.satellites.strongest, enabled: false },
      ...satPatch,
    },
  };
  const riskManager = new RiskManager({ ...cfg.risk }, { now: () => NOW });
  const engine = createTradingEngine({
    config: cfg,
    dashboardState: {
      getCandles: (s) => candles[s] ?? [], updateCandles: () => {}, pushTrade: () => {}, pushError: () => {},
      updatePrice: () => {}, updateStatus: () => {}, getTrades: () => [],
    },
    trader, riskManager,
    regimeTracker: new RegimeTracker(config.regimeClassifier ?? {}),
    symbolAggregators: {}, signalConfig: config.signals,
    fetchOHLCV: async (s, tf) => (tf === '4h' ? series4h(breakouts.includes(s)) : candles[s]),
    marketContext: { getBtcDominanceTrend: () => null, getEthBtcTrend: () => null },
    notifyTrade: () => {}, notifyAlert: async () => {}, pushEvent: () => {}, recordEquitySnapshot: () => {},
    modeLabel: 'replay', now: () => NOW,
  });
  return { engine, sim, riskManager };
}

describe('engine: satellite breakout cycle', () => {
  test('a breakout in an uptrend: one limit buy 0.5% under the close, 12.5% of equity', async () => {
    const { engine, sim } = build({ breakouts: ['AAA/USDC'] });
    const placed = await engine.runSatelliteCycle('breakout');
    assert.equal(placed.length, 1);
    assert.equal(placed[0].key, 'AAA/USDC#bo');
    assert.equal(placed[0].limitPrice, Number((103.8 * 0.995).toFixed(8)));
    assert.equal(placed[0].reserve, 125);
    assert.equal(sim.getStatus().reserved, 125);
  });

  test('no uptrend on 12h bars → no order', async () => {
    const { engine } = build({ rising: false });
    assert.equal((await engine.runSatelliteCycle('breakout')).length, 0);
  });

  test('three breakouts, maxOpen 2 → two orders; a second cycle adds none', async () => {
    const { engine } = build();
    assert.equal((await engine.runSatelliteCycle('breakout')).length, 2);
    assert.equal((await engine.runSatelliteCycle('breakout')).length, 0);
  });

  test('off, or a trader without limit orders → nothing placed', async () => {
    assert.equal((await build({ satPatch: { enabled: false } }).engine.runSatelliteCycle('breakout')).length, 0);
    assert.equal((await build({ traderHasLimits: false }).engine.runSatelliteCycle('breakout')).length, 0);
  });
});

describe('engine: satellite bars', () => {
  test('a fill, then a stop: the loss reaches the daily-loss brake', async () => {
    const { engine, riskManager } = build({ breakouts: ['AAA/USDC'] });
    const [order] = await engine.runSatelliteCycle('breakout');
    const fill = await engine.onSatelliteBar('AAA/USDC#bo', { timestamp: T, open: 103.5, high: 103.6, low: order.limitPrice - 0.1, close: 103.4 });
    assert.equal(fill.side, 'BUY');
    const exit = await engine.onSatelliteBar('AAA/USDC#bo', { timestamp: T + 900_000, open: 100, high: 100, low: 90, close: 91 });
    assert.equal(exit.reason, 'sat_stop');
    assert.ok(exit.pnl < 0);
    assert.equal(riskManager.getDailyStats().dailyPnL, exit.pnl);
  });
});

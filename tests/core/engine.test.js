/**
 * The trading engine (src/core/engine.js) — the bar-close cycle live runs — driven
 * with the real PaperTrader, RiskManager and RegimeTracker and fakes for the data
 * and the dashboard. Stub aggregators force BUYs, so phase B (entries one at a time,
 * by confidence, from fresh status) runs; a boot cycle rarely has a BUY.
 *
 * The race this pins: every symbol's cycle used to run at once, each checking the
 * position limit against a status read before the others' orders — with one slot
 * free, three BUYs opened three positions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { createTradingEngine } from '../../src/core/engine.js';
import PaperTrader from '../../src/executor/paperTrader.js';
import RiskManager from '../../src/risk/index.js';
import { RegimeTracker } from '../../src/engine/regimeClassifier.js';

const H12 = 12 * 60 * 60 * 1000;
const T = Date.UTC(2026, 9, 25, 0, 0, 0);
const NOW = T + 3_000; // the cycle, 3 s after the close
const SYMBOLS = ['AAA/USDC', 'BBB/USDC', 'CCC/USDC'];

/** 300 12h bars, the newest the one forming at T. */
const series = () => Array.from({ length: 300 }, (_, k) => {
  const close = 100 * 1.001 ** k;
  return { timestamp: T - (299 - k) * H12, open: close / 1.001, high: close * 1.002, low: close * 0.997, close, volume: 100 };
});

/** The engine's config: the live config with the gates the fixture cannot feed switched off. */
function engineConfig(maxOpenPositions) {
  return {
    ...config,
    symbols: SYMBOLS,
    risk: { ...config.risk, maxOpenPositions, weeklyDDBreaker: { enabled: false }, positionAgingExit: { enabled: false } },
    btcDominance: { enabled: false },
    correlation: { enabled: false },
    momentumFilter: { enabled: false },
    mtfFilter: { enabled: false },
    mtf4hFilter: { enabled: false },
    bearPolicy: { enabled: false },
    fearGreed: { enabled: false },
    monitor: { enabled: false },
  };
}

function fakeDashboard(candles) {
  const signals = [];
  return {
    signals,
    getCandles: (s) => candles[s] ?? [],
    updateCandles: () => {},
    pushTrade: () => {}, pushSignal: (x) => signals.push(x), pushBlockedSignal: () => {}, pushError: () => {},
    updatePrice: () => {}, updateStrategyResults: () => {}, updateStatus: () => {}, incrementCycle: () => {},
    getSummary: () => ({}), setRegime: () => {}, setMarketContext: () => {}, setCircuitBreaker: () => {},
    getTrades: () => [],
  };
}

/** Builds an engine whose aggregators decide BUY at the given confidences. */
function build({ confidences, maxOpenPositions }) {
  const candles = Object.fromEntries(SYMBOLS.map((s) => [s, series()]));
  const dashboardState = fakeDashboard(candles);
  const cfg = engineConfig(maxOpenPositions);
  const trader = new PaperTrader({ ...config.risk, initialBalance: 1000 });
  const symbolAggregators = Object.fromEntries(SYMBOLS.map((s) => [s, {
    aggregate: () => ({
      decision: 'BUY', confidence: confidences[s],
      signals: [{ signal: 'BUY', confidence: confidences[s], reason: 'stub' }], externalSignals: [],
    }),
  }]));
  const riskManager = new RiskManager({ ...cfg.risk }, { now: () => NOW });
  const engine = createTradingEngine({
    config: cfg, dashboardState, trader,
    riskManager,
    regimeTracker: new RegimeTracker(config.regimeClassifier ?? {}),
    symbolAggregators, signalConfig: config.signals,
    fetchOHLCV: async (s, tf) => (tf === config.timeframe ? candles[s] : []),
    marketContext: { getBtcDominanceTrend: () => null, getEthBtcTrend: () => null },
    notifyTrade: () => {}, notifyAlert: async () => {}, pushEvent: () => {}, recordEquitySnapshot: () => {},
    runTsmCoreCycle: async () => {},
    modeLabel: 'paper',
    now: () => NOW,
  });
  return { engine, trader, dashboardState, riskManager };
}

describe('engine: entries fill the free slots one at a time, by confidence', () => {
  test('one free slot, three BUYs: one position, the highest confidence', async () => {
    const { engine, trader } = build({ confidences: { 'AAA/USDC': 0.6, 'BBB/USDC': 0.9, 'CCC/USDC': 0.7 }, maxOpenPositions: 1 });
    await engine.runAllSymbols();
    assert.deepEqual(trader.getStatus().positions.map((p) => p.symbol), ['BBB/USDC']);
  });

  test('two free slots: the two highest', async () => {
    const { engine, trader } = build({ confidences: { 'AAA/USDC': 0.6, 'BBB/USDC': 0.9, 'CCC/USDC': 0.7 }, maxOpenPositions: 2 });
    await engine.runAllSymbols();
    assert.deepEqual(trader.getStatus().positions.map((p) => p.symbol).sort(), ['BBB/USDC', 'CCC/USDC']);
  });

  test('a tie goes to the earlier symbol in config.symbols', async () => {
    const { engine, trader } = build({ confidences: { 'AAA/USDC': 0.8, 'BBB/USDC': 0.6, 'CCC/USDC': 0.8 }, maxOpenPositions: 1 });
    await engine.runAllSymbols();
    assert.deepEqual(trader.getStatus().positions.map((p) => p.symbol), ['AAA/USDC']);
  });

  test('the blocked entries are logged with the slot limit as their reason', async () => {
    const { engine, dashboardState } = build({ confidences: { 'AAA/USDC': 0.6, 'BBB/USDC': 0.9, 'CCC/USDC': 0.7 }, maxOpenPositions: 1 });
    await engine.runAllSymbols();
    const blocked = dashboardState.signals.filter((x) => x.blockReason).map((x) => [x.symbol, x.blockReason]);
    assert.deepEqual(blocked.map(([s]) => s).sort(), ['AAA/USDC', 'CCC/USDC']);
    assert.ok(blocked.every(([, r]) => /limit reached/.test(r)), JSON.stringify(blocked));
  });

  test('the cycle uses the injected clock: a fresh series is not called stale', async () => {
    const { engine, trader } = build({ confidences: { 'AAA/USDC': 0.9, 'BBB/USDC': 0.5, 'CCC/USDC': 0.5 }, maxOpenPositions: 3 });
    await engine.runAllSymbols();
    assert.equal(trader.getStatus().positions.length, 3);
    assert.equal(engine.state.lastCycleAt, NOW);
  });
});

describe('engine: price ticks', () => {
  test('a stop from a tick closes the position and counts toward the daily-loss brake', async () => {
    const { engine, trader, riskManager } = build({ confidences: { 'AAA/USDC': 0.9, 'BBB/USDC': 0.1, 'CCC/USDC': 0.1 }, maxOpenPositions: 1 });
    await engine.runAllSymbols();
    const [pos] = trader.getStatus().positions;
    assert.equal(pos.symbol, 'AAA/USDC');
    const closed = await engine.onPriceTick('AAA/USDC', pos.stopLoss * 0.99);
    assert.equal(closed.reason, 'stop_loss');
    assert.equal(trader.getStatus().positions.length, 0);
    assert.ok(riskManager.getDailyStats().dailyPnL < 0, 'the loss reached the daily-loss brake');
  });

  test('a tick that crosses nothing changes nothing', async () => {
    const { engine, trader, riskManager } = build({ confidences: { 'AAA/USDC': 0.9, 'BBB/USDC': 0.1, 'CCC/USDC': 0.1 }, maxOpenPositions: 1 });
    await engine.runAllSymbols();
    const [pos] = trader.getStatus().positions;
    assert.equal(await engine.onPriceTick('AAA/USDC', pos.entryPrice), null);
    assert.equal(trader.getStatus().positions.length, 1);
    assert.equal(riskManager.getDailyStats().dailyPnL, 0);
  });
});

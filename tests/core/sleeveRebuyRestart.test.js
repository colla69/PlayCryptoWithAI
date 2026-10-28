/**
 * Section M with real money: after a sleeve sell, a restart must not forget that the coin
 * waits for a 20-day high. Runs the engine's own sleeve cycle with a file-backed store.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../../config/default.js';
import { createTradingEngine } from '../../src/core/engine.js';
import PaperTrader from '../../src/executor/paperTrader.js';
import RiskManager from '../../src/risk/index.js';
import { RegimeTracker } from '../../src/engine/regimeClassifier.js';
import { loadSleeveState, saveSleeveState } from '../../src/data/sleeveStateStore.js';

const H12 = 43_200_000;
const T = Date.UTC(2026, 9, 25, 0, 0, 0);
const NOW = T + 3_000;
const SYM = 'AAA/USDC';
const KEY = `${SYM}#core`;

/**
 * 300 12h bars (the newest forming at T): a steady rise to a peak at bar 280, flat at 95% of
 * the peak after it, and the newest closed bar (298, and the forming 299) at `endPct`. At 95%
 * all three votes (60/90/120 bars) are positive but the close is below the 20-day high; at
 * 101% that close is a new 20-day high.
 */
function series(endPct) {
  const peakK = 280;
  const peak = 100 * 1.004 ** peakK;
  return Array.from({ length: 300 }, (_, k) => {
    const close = k <= peakK ? 100 * 1.004 ** k : k >= 298 ? peak * endPct : peak * 0.95;
    return { timestamp: T - (299 - k) * H12, open: close, high: close * 1.001, low: close * 0.999, close, volume: 100 };
  });
}

function build({ endPct, file, rebuyBars = 40 }) {
  const candles = { [SYM]: series(endPct) };
  const cfg = {
    ...config,
    symbols: [SYM],
    risk: { ...config.risk, weeklyDDBreaker: { enabled: false }, positionAgingExit: { enabled: false } },
    btcDominance: { enabled: false }, correlation: { enabled: false }, momentumFilter: { enabled: false },
    mtfFilter: { enabled: false }, mtf4hFilter: { enabled: false }, bearPolicy: { enabled: false },
    fearGreed: { enabled: false }, monitor: { enabled: false }, satellites: { enabled: false },
    exchangeEvents: { enabled: false },
    tsmCore: {
      ...config.tsmCore, enabled: true, symbols: [SYM], equityLadder: [],
      enterVotes: 3, stayVotes: 3, rebuyConfirmBars: rebuyBars, reentryPauseHours: 0,
      macroOverlay: { enabled: false }, impliedVol: { enabled: false },
    },
  };
  const dashboardState = {
    getCandles: (s) => candles[s] ?? [], updateCandles: () => {},
    pushTrade: () => {}, pushSignal: () => {}, pushBlockedSignal: () => {}, pushError: () => {},
    updatePrice: () => {}, updateStrategyResults: () => {}, updateStatus: () => {}, incrementCycle: () => {},
    getSummary: () => ({}), setRegime: () => {}, setMarketContext: () => {}, setCircuitBreaker: () => {},
    setTsmCore: () => {}, getTrades: () => [],
  };
  const trader = new PaperTrader({ ...config.risk, initialBalance: 1000 });
  const engine = createTradingEngine({
    config: cfg, dashboardState, trader,
    riskManager: new RiskManager({ ...cfg.risk }, { now: () => NOW }),
    regimeTracker: new RegimeTracker(config.regimeClassifier ?? {}),
    symbolAggregators: { [SYM]: { aggregate: () => ({ decision: 'HOLD', confidence: 0, signals: [], externalSignals: [] }) } },
    signalConfig: config.signals,
    fetchOHLCV: async (s, tf) => (tf === config.timeframe ? candles[s] : []),
    marketContext: { getBtcDominanceTrend: () => null, getEthBtcTrend: () => null },
    notifyTrade: () => {}, notifyAlert: async () => {}, pushEvent: () => {}, recordEquitySnapshot: () => {},
    loadEquityHistory: () => [], loadNasdaqHistory: async () => null,
    sleeveStore: file ? { load: () => loadSleeveState(file), save: (s) => saveSleeveState(s, file, NOW) } : null,
    modeLabel: 'paper',
    now: () => NOW,
  });
  return { engine, trader };
}

const coreHeld = (trader) => trader.getStatus().positions.some((p) => p.symbol === KEY);
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sleeve-restart-')), 'tsm_sleeve_state.json');

describe('sleeve buy-back gate survives a restart', () => {
  test('control: with no saved state the votes (3 of 3) buy the coin', async () => {
    const { engine, trader } = build({ endPct: 0.95, file: tmpFile() });
    await engine.runAllSymbols();
    assert.equal(coreHeld(trader), true);
  });

  test('a sell is saved; the restarted engine does not buy back below the 20-day high', async () => {
    const file = tmpFile();
    build({ endPct: 0.95, file }).engine.noteCoreExit(KEY); // the sell, before the restart
    assert.deepEqual([...loadSleeveState(file).rebuyGate.keys()], [KEY]);

    const { engine, trader } = build({ endPct: 0.95, file }); // restart: a new engine, same file
    assert.ok(engine.state.tsmRebuyGate.has(KEY), 'gate restored from disk');
    await engine.runAllSymbols();
    assert.equal(coreHeld(trader), false);
    assert.deepEqual([...loadSleeveState(file).rebuyGate.keys()], [KEY], 'still waiting');
  });

  test('after the restart a new 20-day high buys it back and clears the gate on disk', async () => {
    const file = tmpFile();
    build({ endPct: 1.01, file }).engine.noteCoreExit(KEY);
    const { engine, trader } = build({ endPct: 1.01, file });
    await engine.runAllSymbols();
    assert.equal(coreHeld(trader), true);
    assert.equal(loadSleeveState(file).rebuyGate.size, 0);
  });

  test('a vote-flip sell in the cycle saves the gate to disk', async () => {
    const file = tmpFile();
    // At 80% of the peak the 60-bar vote is negative (2 of 3): with stayVotes 3 the sleeve sells.
    const { engine, trader } = build({ endPct: 0.80, file });
    await trader.openCorePosition(KEY, series(0.80).at(-2).close, 300);
    assert.equal(coreHeld(trader), true);
    await engine.runAllSymbols();
    assert.equal(coreHeld(trader), false, 'sold');
    const saved = loadSleeveState(file);
    assert.deepEqual([...saved.rebuyGate.keys()], [KEY]);
    assert.equal(saved.lastExitAt.get(KEY), NOW);
  });

  test('switched off, a leftover gate is cleared and does not block', async () => {
    const file = tmpFile();
    saveSleeveState({ rebuyGate: new Map([[KEY, true]]), lastExitAt: new Map() }, file, NOW);
    const { engine, trader } = build({ endPct: 0.95, file, rebuyBars: 0 });
    assert.ok(engine.state.tsmRebuyGate.has(KEY), 'loaded from disk');
    await engine.runAllSymbols();
    assert.equal(coreHeld(trader), true);
    assert.equal(loadSleeveState(file).rebuyGate.size, 0);
  });
});

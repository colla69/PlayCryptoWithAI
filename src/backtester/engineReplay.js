/**
 * Engine replay — history through the engine live runs (plan 2026-10 single-engine
 * rebuild, step 4, slice 3b).
 *
 * `PortfolioBacktester` re-implements the cycle; this runs `createTradingEngine`
 * itself, with a replay source in place of the exchange: at every 12h close it
 * sets the clock to the cycle time, serves the candles live would have fetched,
 * calls `engine.runAllSymbols()`, then feeds each open position the 15m bars up to
 * the next close through `engine.onPriceTick` — live's two events, bar closed and
 * price tick. Orders go to a `BacktestSimulator` behind live's order interface,
 * with the same fees, slippage tiers and minimum notional as `PortfolioBacktester`.
 * The core sleeve is not replayed (`runTsmCoreCycle` is a no-op).
 *
 * Nothing here touches bot state: the dashboard and the notifications are fakes.
 */

import config from '../../config/default.js';
import { createTradingEngine } from '../core/engine.js';
import { BacktestSimulator } from './backtestSimulator.js';
import SignalAggregator from '../engine/signalAggregator.js';
import RiskManager from '../risk/index.js';
import { RegimeTracker } from '../engine/regimeClassifier.js';
import { buildStrategiesForSymbol, getSignalConfigForSymbol } from '../utils/strategyBuilder.js';
import { getContextAsOf } from '../data/marketContext.js';
import { timeframeMs } from '../utils/candleFreshness.js';

const CYCLE_DELAY_MS = 3_000; // live's cycles fire at the close + 3 s
const iso = (ts) => new Date(ts).toISOString();

/** Index of the last element with timestamp ≤ ts (binary search), or -1. */
function lastAtOrBefore(bars, ts) {
  let lo = 0; let hi = bars.length - 1; let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(bars[mid].timestamp) <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** BacktestSimulator behind the order interface the engine calls (LiveTrader's). */
class SimOrderHandler {
  constructor(sim, slippageBySymbol) {
    this.sim = sim;
    this.slippage = slippageBySymbol;
    this.trades = [];
  }

  #asTrade(t) {
    if (!t || t.exitTime == null) return t ? { ...t, side: 'BUY' } : null;
    const trade = {
      symbol: t.symbol, side: 'SELL', entryPrice: t.entryPrice, exitPrice: t.exitPrice, qty: t.qty,
      pnl: t.pnl, reason: t.reason, timestamp: iso(t.exitTime), openedAt: iso(t.entryTime), raw: t,
    };
    this.trades.push(trade);
    return trade;
  }

  async execute(symbol, decision, price, risk = {}) {
    const opts = decision === 'BUY' ? {
      positionPct: risk.maxPositionPct,
      slippagePct: this.slippage[symbol],
      stopLossPrice: price * (1 - Number(risk.stopLossPct)),
      takeProfitPrice: price * (1 + Number(risk.takeProfitPct)),
      atrPct: risk.atrPct,
    } : {};
    return this.#asTrade(this.sim.execute(symbol, decision, price, opts));
  }

  async checkRisk(symbol, price) { return this.#asTrade(this.sim.checkRisk(symbol, price)); }

  async replayBar(symbol, bar) { return this.#asTrade(this.sim.replayBar(symbol, bar)); }

  markPrice(symbol, price) { return this.sim.markPrice(symbol, price); }

  async getStatus() {
    const status = this.sim.getStatus();
    return {
      ...status,
      positions: status.positions.map((p) => {
        const pos = this.sim.positions.get(p.symbol);
        return { ...p, currentPrice: pos?.lastPrice ?? p.entryPrice, openedAt: iso(pos.entryTime), isCore: false };
      }),
    };
  }
}

/** The dashboard the engine writes to, kept in memory; candles come from the replay source. */
function replayDashboard(getVisible) {
  const trades = [];
  const signals = [];
  const noop = () => {};
  return {
    trades, signals,
    getCandles: getVisible, updateCandles: noop,
    pushTrade: (t) => { if (t?.side === 'SELL') trades.push(t); },
    getTrades: () => trades,
    pushSignal: (s) => signals.push(s),
    pushBlockedSignal: noop, pushError: noop, updatePrice: noop, updateStrategyResults: noop,
    updateStatus: noop, incrementCycle: noop, getSummary: () => ({}), setRegime: noop,
    setMarketContext: noop, setCircuitBreaker: noop,
  };
}

/**
 * @param {object} p
 * @param {Record<string, object[]>} p.symbolCandles — 12h bars per symbol (full history)
 * @param {Record<string, object[]>} p.mtf15mCandles
 * @param {Record<string, object[]>} p.mtf4hCandles
 * @param {object[]|null} p.fearGreedData
 * @param {number} p.fromTs — the first cycle to trade at (history before it warms the engine)
 * @param {number} p.toTs — the last cycle
 * @param {number} p.initialBalance
 * @param {Array<{ts:number, amount:number}>} [p.deposits]
 * @param {Record<string, number>} p.slippage — per-symbol slippage tiers
 * @param {object} [p.cfg] — config for the engine (defaults to config/default.js)
 */
export async function replayEngine({
  symbolCandles, mtf15mCandles = {}, mtf4hCandles = {}, fearGreedData = null,
  fromTs, toTs, initialBalance, deposits = [], slippage = {}, cfg = config,
}) {
  const tfMs = timeframeMs(cfg.timeframe);
  const symbols = cfg.symbols.filter((s) => symbolCandles[s]?.length);
  const signalConfig = cfg.signals;
  let clock = fromTs;
  let cycleTs = fromTs;
  const now = () => clock;

  // What live holds at the cycle on T: closed bars plus the bar that opened at T,
  // seconds old — flat at its open. A symbol with no bar at T shows its closed bars.
  const visibleCache = new Map();
  const visible = (s) => {
    const key = `${s}|${cycleTs}`;
    if (visibleCache.has(key)) return visibleCache.get(key);
    const c = symbolCandles[s] ?? [];
    const k = lastAtOrBefore(c, cycleTs);
    let out;
    if (k >= 0 && Number(c[k].timestamp) === cycleTs) {
      const open = Number(c[k].open);
      out = [...c.slice(0, k), { timestamp: cycleTs, open, high: open, low: open, close: open, volume: 0 }];
    } else {
      out = c.slice(0, k + 1);
    }
    visibleCache.clear();
    visibleCache.set(key, out);
    return out;
  };
  const fetchOHLCV = async (s, tf, limit) => {
    if (tf === cfg.timeframe) return visible(s).slice(-(limit ?? 200));
    const bars = (tf === '15m' ? mtf15mCandles : mtf4hCandles)[s] ?? [];
    const k = lastAtOrBefore(bars, clock);
    return bars.slice(Math.max(0, k - (limit ?? 20) + 1), k + 1);
  };
  const btcDominanceAt = () => {
    const btcd = getContextAsOf(clock)?.btcDominance;
    return btcd?.sma7d != null ? { ...btcd, deltaPct: Number((btcd.value - btcd.sma7d).toFixed(3)) } : null;
  };

  const sim = new BacktestSimulator({
    ...cfg.risk, initialBalance, feePct: 0.001, slippagePct: 0.001, recordEquityOnExecute: false,
  });
  const trader = new SimOrderHandler(sim, slippage);
  const dashboardState = replayDashboard(visible);
  const regimeTracker = new RegimeTracker(cfg.regimeClassifier ?? {});
  const symbolAggregators = Object.fromEntries(symbols.map((s) => [s, new SignalAggregator(buildStrategiesForSymbol(s), signalConfig)]));

  // Warm-up, as live has history behind its first cycle: the aggregators' multi-bar
  // memory over every bar before the first cycle, the regime tracker over BTC's.
  for (const s of symbols) {
    const c = symbolCandles[s];
    const sc = getSignalConfigForSymbol(s, signalConfig);
    for (let i = 50; i < c.length && Number(c[i].timestamp) < fromTs; i++) {
      symbolAggregators[s].aggregate(c.slice(0, i + 1), s, sc);
    }
  }
  const btc = symbolCandles['BTC/USDC'];
  if (btc) {
    const minBars = Math.max(regimeTracker.cfg?.emaPeriod ?? 200, (regimeTracker.cfg?.adxPeriod ?? 14) * 2 + 5);
    for (let i = minBars - 1; i < btc.length && Number(btc[i].timestamp) + tfMs < fromTs; i++) {
      regimeTracker.update(btc.slice(0, i + 1), Number(btc[i].timestamp));
    }
  }

  const engine = createTradingEngine({
    config: cfg, dashboardState, trader,
    riskManager: new RiskManager(cfg.risk, { now }),
    regimeTracker, symbolAggregators, signalConfig, fetchOHLCV,
    marketContext: { getBtcDominanceTrend: btcDominanceAt, getEthBtcTrend: () => null },
    notifyTrade: () => {}, notifyAlert: async () => {}, pushEvent: () => {}, recordEquitySnapshot: () => {},
    runTsmCoreCycle: async () => {},
    modeLabel: 'replay',
    now,
  });
  engine.state.fearGreedData = fearGreedData;

  const cycles = [...new Set(symbols.flatMap((s) => symbolCandles[s]
    .map((c) => Number(c.timestamp)).filter((t) => t >= fromTs && t <= toTs)))].sort((a, b) => a - b);
  const pending = [...deposits].filter((d) => d.ts >= fromTs).sort((a, b) => a.ts - b.ts);
  const equity = [];

  for (let k = 0; k < cycles.length; k++) {
    cycleTs = cycles[k];
    while (pending.length && pending[0].ts <= cycleTs) sim.deposit(pending.shift().amount);
    clock = cycleTs + CYCLE_DELAY_MS;
    sim.setTimestamp(cycleTs);
    await engine.runAllSymbols();

    // Price ticks until the next close: each open position meets its 15m bars.
    const nextTs = cycles[k + 1] ?? cycleTs + tfMs;
    for (const pos of (await trader.getStatus()).positions) {
      const bars = mtf15mCandles[pos.symbol];
      if (!bars?.length) continue;
      const entry = sim.positions.get(pos.symbol)?.entryTime ?? cycleTs;
      for (let j = lastAtOrBefore(bars, cycleTs - 1) + 1; j < bars.length && Number(bars[j].timestamp) < nextTs; j++) {
        if (Number(bars[j].timestamp) < entry) continue;
        clock = Number(bars[j].timestamp) + 15 * 60 * 1000;
        if (await engine.onPriceTick(pos.symbol, Number(bars[j].close), bars[j])) break;
      }
    }
    const status = await trader.getStatus();
    equity.push({ timestamp: cycleTs, balance: status.balance + status.positions.reduce((s, p) => s + p.qty * p.currentPrice, 0) });
  }

  return { trades: trader.trades, signals: dashboardState.signals, equity, sim };
}

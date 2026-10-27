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
 * The core sleeve runs too (TSM_CORE=true), on the simulator's core positions.
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
import { hourlyRsiByClose } from '../engine/satellites.js';
import { impliedVolAsOf } from '../engine/tsmCore.js';

const CYCLE_DELAY_MS = 3_000; // live's cycles fire at the close + 3 s
const SATELLITE_DELAY_MS = 60_000; // main.js runs the breakout one minute after the close
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

  // TSM core sleeve (keys '<symbol>#core'), as LiveTrader's calls.
  async openCorePosition(key, price, allocationUsd) {
    const r = this.sim.openCore(key, price, allocationUsd, { slippagePct: this.slippage[key.split('#')[0]] });
    return r ? { ...r, side: 'BUY', isCore: true, timestamp: iso(this.sim.currentTimestamp) } : null;
  }

  async closeCorePosition(key, price) {
    return this.#asTrade(this.sim.closeCore(key, price, { slippagePct: this.slippage[key.split('#')[0]] }));
  }

  async resizeCorePosition(key, price, deltaUsd) {
    const r = this.sim.resizeCore(key, price, deltaUsd, { slippagePct: this.slippage[key.split('#')[0]] });
    if (!r) return null;
    return r.exitTime != null ? this.#asTrade(r) : { ...r, timestamp: iso(this.sim.currentTimestamp) };
  }

  markPrice(symbol, price) { return this.sim.markPrice(symbol, price); }

  // Satellite strategies ('<symbol>#bo' / '#rs'): resting limit orders and their exit plan.
  async placeSatelliteOrder(key, entry) {
    return this.sim.placeSatelliteOrder(key, { ...entry, slippagePct: this.slippage[key.split('#')[0]] });
  }

  pendingSatelliteKeys() { return [...this.sim.pendingSatellite.keys()]; }

  async replaySatelliteBar(key, bar, ctx) { return this.#asTrade(this.sim.replaySatelliteBar(key, bar, ctx)); }

  async getStatus() {
    const status = this.sim.getStatus();
    return {
      ...status,
      positions: status.positions.map((p) => {
        const pos = this.sim.positions.get(p.symbol);
        return { ...p, currentPrice: pos?.lastPrice ?? p.entryPrice, openedAt: iso(pos.entryTime), isCore: pos?.isCore === true, isSatellite: pos?.isSatellite === true };
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
    setMarketContext: noop, setCircuitBreaker: noop, setTsmCore: noop,
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
 * @param {Array<{t:number, v:number}>} [p.nasdaqRows] — the sleeve's macro feed; cut to the clock
 * @param {Record<string, Array<{t:number, c:number}>>} [p.impliedVolRows] — 12h implied-vol bars
 *   (DVOL) by base coin, e.g. { BTC: [...] }; when given, the sleeve sizes on them (section E1)
 * @param {Array<{equity:number}>} [p.equityHistory] — account equity before the window (the
 *   sleeve's high-water mark); the replay appends its own daily points
 */
export async function replayEngine({
  symbolCandles, mtf15mCandles = {}, mtf4hCandles = {}, fearGreedData = null,
  fromTs, toTs, initialBalance, deposits = [], slippage = {}, cfg = config,
  nasdaqRows = [], equityHistory = [], impliedVolRows = null,
}) {
  const tfMs = timeframeMs(cfg.timeframe);
  const symbols = cfg.symbols.filter((s) => symbolCandles[s]?.length);
  const signalConfig = cfg.signals;
  let clock = fromTs;
  const now = () => clock;
  const equity = [{ timestamp: fromTs - 1, balance: initialBalance }];
  let replayHwm = initialBalance;

  // What live holds at the cycle on T: closed bars plus the bar that opened at T,
  // seconds old — flat at its open. A symbol with no bar at T shows its closed bars.
  const visibleCache = new Map();
  const visible = (s) => {
    const cycleTs = Math.floor(clock / tfMs) * tfMs;
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
    // The sleeve's feeds as of the clock: its HWM ladder reads account equity, its
    // macro overlay the NASDAQ closes.
    loadEquityHistory: () => [...equityHistory, { equity: replayHwm }],
    loadNasdaqHistory: async () => ({ rows: nasdaqRows.filter((r) => r.t <= clock) }),
    loadImpliedVol: impliedVolRows
      ? (symbol) => impliedVolAsOf(impliedVolRows[symbol.split('/')[0]], clock)
      : null,
    modeLabel: 'replay',
    now,
  });
  engine.state.fearGreedData = fearGreedData;

  const satellitesOn = cfg.satellites?.enabled === true;
  const rsiBySymbol = new Map();
  const rsiAt = (symbol, ts) => {
    if (!rsiBySymbol.has(symbol)) rsiBySymbol.set(symbol, hourlyRsiByClose(mtf15mCandles[symbol] ?? []));
    return rsiBySymbol.get(symbol).get(ts) ?? null;
  };
  const SUB_MS = timeframeMs(cfg.satellites?.breakout?.timeframe ?? '4h');
  const M15 = 15 * 60 * 1000;
  // toTs names the last signal cycle; include that cycle's interval, but no later data.
  const endTs = toTs + tfMs;
  const cycles = [...new Set(symbols.flatMap((s) => symbolCandles[s]
    .map((c) => Number(c.timestamp)).filter((t) => t >= fromTs && t <= toTs)))].sort((a, b) => a - b);
  const cycleEvents = new Map(cycles.map((t) => [t + CYCLE_DELAY_MS, t]));
  const breakoutEvents = new Map();
  const times = new Set([fromTs, endTs, ...cycleEvents.keys()]);
  if (satellitesOn && cfg.satellites.breakout?.enabled) {
    for (let t = Math.ceil(fromTs / SUB_MS) * SUB_MS; t + SATELLITE_DELAY_MS <= endTs; t += SUB_MS) {
      breakoutEvents.set(t + SATELLITE_DELAY_MS, t);
      times.add(t + SATELLITE_DELAY_MS);
    }
  }
  const pending = [...deposits].filter((d) => d.ts >= fromTs && d.ts <= endTs).sort((a, b) => a.ts - b.ts);
  for (const d of pending) times.add(d.ts);
  let nextDeposit = 0;
  const priceSymbols = [...new Set([...symbols, ...Object.keys(mtf15mCandles)])];
  const pointers = {};
  const prices = {};
  for (const symbol of priceSymbols) {
    const bars = mtf15mCandles[symbol] ?? [];
    const first = lastAtOrBefore(bars, fromTs - M15 - 1) + 1;
    pointers[symbol] = first;
    for (let k = first; k < bars.length && Number(bars[k].timestamp) + M15 <= endTs; k++) {
      times.add(Number(bars[k].timestamp) + M15);
    }
  }
  const markPositions = () => {
    for (const key of sim.positions.keys()) {
      const price = prices[key.split('#')[0]];
      if (price > 0) trader.markPrice(key, price);
    }
  };

  for (const ts of [...times].sort((a, b) => a - b)) {
    clock = ts;
    // At a shared boundary, close the previous bars before deposits and new entries.
    // Update every quote first so valuation never mixes one symbol's future with another's past.
    const closed = new Map();
    for (const symbol of priceSymbols) {
      const bars = mtf15mCandles[symbol] ?? [];
      let k = pointers[symbol];
      while (k < bars.length && Number(bars[k].timestamp) + M15 <= ts) {
        closed.set(symbol, bars[k]);
        prices[symbol] = Number(bars[k].close);
        k++;
      }
      pointers[symbol] = k;
    }
    markPositions();
    for (const [key, pos] of [...sim.positions]) {
      if (pos.isCore || pos.isSatellite) continue;
      const bar = closed.get(key);
      if (bar && Number(bar.timestamp) >= pos.entryTime) await engine.onPriceTick(key, Number(bar.close), bar);
    }
    if (satellitesOn) {
      const keys = new Set([
        ...trader.pendingSatelliteKeys(),
        ...[...sim.positions].filter(([, p]) => p.isSatellite).map(([key]) => key),
      ]);
      for (const key of keys) {
        const symbol = key.split('#')[0];
        const bar = closed.get(symbol);
        if (bar) await engine.onSatelliteBar(key, bar, { rsi: rsiAt(symbol, Number(bar.timestamp) + M15) });
      }
    }
    while (nextDeposit < pending.length && pending[nextDeposit].ts <= ts) {
      sim.deposit(pending[nextDeposit++].amount);
    }
    if (cycleEvents.has(ts)) {
      const cycleTs = cycleEvents.get(ts);
      for (const symbol of symbols) {
        const bars = symbolCandles[symbol];
        const k = lastAtOrBefore(bars, cycleTs);
        if (k >= 0 && Number(bars[k].timestamp) === cycleTs) prices[symbol] = Number(bars[k].open);
      }
      markPositions();
      sim.setTimestamp(cycleTs);
      await engine.runAllSymbols();
    }
    if (breakoutEvents.has(ts)) {
      sim.setTimestamp(breakoutEvents.get(ts));
      await engine.runSatelliteCycle('breakout');
    }
    markPositions();
    const status = await trader.getStatus();
    const balance = status.balance + (status.reserved ?? 0) + status.positions.reduce((s, p) => s + p.qty * p.currentPrice, 0);
    equity.push({ timestamp: ts, balance });
    if (cycleEvents.has(ts)) replayHwm = Math.max(replayHwm, balance);
  }

  return { trades: trader.trades, signals: dashboardState.signals, equity, sim };
}

/**
 * Satellite strategies — pure signal, sizing and exit logic (plan 2026-10 single-engine
 * rebuild, "Combining the streams"). Two short-hold strategies run on the cash the
 * scalper and the TSM sleeve leave idle:
 *
 * - breakout  — a 4h close above the N-bar high on a volume spike, in a 12h uptrend.
 *               Exit: stop, break-even at +1R, no target, RSI-tier exit, 48 h limit.
 * - strongest — a coin among the top N by 7-day return that makes a 24-bar 12h high,
 *               in a 12h uptrend. Exit: stop, break-even at +1R, 2R target, 120 h limit.
 *
 * Both enter by a resting limit buy under the price (no fill → no trade), stop out by a
 * stop-limit sell, and take targets and time exits by limit sells. Positions are keyed
 * '<symbol>#bo' / '<symbol>#rs' so they never collide with scalper or core positions,
 * and never take the scalper's slots.
 *
 * Everything here is pure (no I/O, no state): the engine decides, the trader (live, or
 * the backtest simulator) holds the orders. Callers pass CLOSED candles only (no
 * lookahead): withFormingBar(…).slice(0, -1).
 */

import { calculateEMA, calculateRSI, computeATRPct } from '../utils/indicators.js';
import { FALLBACK_MIN_NOTIONAL } from '../exchange/exchangeLimits.js';

export const SATELLITE_SUFFIX = Object.freeze({ breakout: '#bo', strongest: '#rs' });
const HOUR_MS = 3_600_000;
const M15_MS = 900_000;

/** '<symbol>' + kind → '<symbol>#bo' | '<symbol>#rs' */
export const satelliteKey = (symbol, kind) => `${symbol}${SATELLITE_SUFFIX[kind]}`;

/** The satellite kind a position key belongs to, or null. */
export function satelliteKind(key) {
  const s = String(key ?? '');
  for (const [kind, suffix] of Object.entries(SATELLITE_SUFFIX)) if (s.endsWith(suffix)) return kind;
  return null;
}

export const isSatelliteSymbol = (key) => satelliteKind(key) !== null;

/**
 * Uptrend on closed bars: the close above its slow EMA, and the fast EMA above the slow.
 * Insufficient history counts as no trend — a satellite never enters on a guess.
 * @param {Array<{close:number}>} closed
 * @param {{fast?: number, slow?: number}} [opts]
 */
export function isTrendUp(closed, { fast = 50, slow = 200 } = {}) {
  if (!Array.isArray(closed) || closed.length < slow) return false;
  const closes = closed.map((c) => Number(c.close));
  const emaFast = calculateEMA(closes, fast).at(-1);
  const emaSlow = calculateEMA(closes, slow).at(-1);
  const last = closes.at(-1);
  return Number.isFinite(emaFast) && Number.isFinite(emaSlow) && last > emaSlow && emaFast > emaSlow;
}

const maxHigh = (bars) => bars.reduce((m, b) => Math.max(m, Number(b.high)), -Infinity);

/**
 * Breakout on the last closed bar: its close above the highest high of the previous
 * `lookbackBars` bars, its volume above `volumeMult` × the previous `volumeAvgBars`
 * bars' average, and the close in the top part of its range (`closeInRangeMin`).
 * The stop sits `stopAtr` ATRs under the close.
 * @param {Array<{high:number, low:number, close:number, volume:number}>} closed
 * @returns {{level:number, stopPrice:number, refClose:number}|null}
 */
export function detectBreakout(closed, {
  lookbackBars = 48, volumeMult = 1.5, volumeAvgBars = 48, closeInRangeMin = 0.7, atrPeriod = 14, stopAtr = 1.5,
} = {}) {
  const n = closed?.length ?? 0;
  if (n < Math.max(lookbackBars, volumeAvgBars, atrPeriod + 2) + 1) return null;
  const last = closed[n - 1];
  const close = Number(last.close); const high = Number(last.high); const low = Number(last.low);
  const level = maxHigh(closed.slice(n - 1 - lookbackBars, n - 1));
  if (!(close > level)) return null;
  const prior = closed.slice(n - 1 - volumeAvgBars, n - 1);
  const avgVolume = prior.reduce((s, b) => s + Number(b.volume), 0) / prior.length;
  if (!(Number(last.volume) > volumeMult * avgVolume)) return null;
  const range = high - low;
  if (!(range > 0) || close < low + closeInRangeMin * range) return null;
  const atrPct = computeATRPct(closed, atrPeriod);
  if (!(atrPct > 0)) return null;
  return { level, stopPrice: close * (1 - stopAtr * atrPct), refClose: close };
}

/**
 * Rank symbols by their return over the last `lookbackBars` closed bars (1 = best).
 * Only series whose newest closed bar is the newest across all series take part, so a
 * frozen or late pair never ranks on old prices.
 * @param {Map<string, Array<{timestamp:number, close:number}>>|Record<string, Array>} closedBySymbol
 * @returns {Map<string, number>}
 */
export function rankByReturn(closedBySymbol, lookbackBars = 14) {
  const entries = closedBySymbol instanceof Map ? [...closedBySymbol.entries()] : Object.entries(closedBySymbol ?? {});
  const newest = Math.max(...entries.map(([, c]) => Number(c?.at(-1)?.timestamp ?? -Infinity)));
  const rets = [];
  for (const [symbol, c] of entries) {
    const n = c?.length ?? 0;
    if (n <= lookbackBars || Number(c[n - 1].timestamp) !== newest) continue;
    const ref = Number(c[n - 1 - lookbackBars].close);
    if (ref > 0) rets.push([symbol, Number(c[n - 1].close) / ref - 1]);
  }
  rets.sort((a, b) => b[1] - a[1]);
  return new Map(rets.map(([s], k) => [s, k + 1]));
}

/**
 * Strongest-coin entry on the last closed bar: the coin ranks in the top `topN` and its
 * close is above the highest high of the previous `lookbackBars` bars. Stop as detectBreakout.
 * @returns {{level:number, stopPrice:number, refClose:number}|null}
 */
export function detectStrongest(closed, rank, { topN = 3, lookbackBars = 24, atrPeriod = 14, stopAtr = 1.5 } = {}) {
  const n = closed?.length ?? 0;
  if (!(rank >= 1 && rank <= topN) || n < Math.max(lookbackBars, atrPeriod + 2) + 1) return null;
  const close = Number(closed[n - 1].close);
  const level = maxHigh(closed.slice(n - 1 - lookbackBars, n - 1));
  if (!(close > level)) return null;
  const atrPct = computeATRPct(closed, atrPeriod);
  if (!(atrPct > 0)) return null;
  return { level, stopPrice: close * (1 - stopAtr * atrPct), refClose: close };
}

/**
 * RSI of closed 1h bars built from 15m bars, keyed by each hour's close time. An hour
 * counts once its last 15m bar (the one starting at :45) is present — a part hour is
 * never read.
 * @param {Array<{timestamp:number, close:number}>} bars15m — ascending
 * @returns {Map<number, number>} hour close time → RSI
 */
export function hourlyRsiByClose(bars15m, period = 14) {
  const hours = [];
  for (const b of bars15m ?? []) {
    const t = Number(b.timestamp);
    const start = Math.floor(t / HOUR_MS) * HOUR_MS;
    if (t - start === HOUR_MS - M15_MS) hours.push({ close: Number(b.close), at: start + HOUR_MS });
  }
  const rsi = calculateRSI(hours.map((h) => h.close), period);
  const offset = hours.length - rsi.length;
  return new Map(rsi.map((v, k) => [hours[k + offset].at, v]));
}

/** RSI of the last bar of a CLOSED series (live: the 1h klines after the hour closes), or null. */
export function rsiOfLastClosedBar(closed, period = 14) {
  if (!Array.isArray(closed) || closed.length <= period) return null;
  const v = calculateRSI(closed.map((b) => Number(b.close)), period).at(-1);
  return Number.isFinite(v) ? v : null;
}

/**
 * The RSI level under which a position at this open profit exits, or null below the
 * first tier. Tiers: [{minProfit, rsiBelow}], e.g. [{0.01, 35}, {0.02, 45}, {0.04, 55}] —
 * the bigger the open profit, the smaller the momentum drop that takes it
 * (NostalgiaForInfinity's long_exit_main, docs/EXTERNAL_BOTS_REVIEW.md).
 */
export function tierExitThreshold(profitPct, tiers) {
  const sorted = [...(tiers ?? [])].sort((a, b) => b.minProfit - a.minProfit);
  return sorted.find((t) => profitPct >= t.minProfit)?.rsiBelow ?? null;
}

/** True when the tier for this profit is reached and RSI is under its level. */
export function shouldTierExit({ profitPct, rsi, tiers }) {
  const level = tierExitThreshold(profitPct, tiers);
  return level != null && Number.isFinite(rsi) && rsi < level;
}

/**
 * A held satellite position meets one price observation — a replay's 15m bar, or a live
 * or paper price tick (open = low = high = close = the price). The one copy of the exit
 * rules, used by the simulator, PaperTrader and LiveTrader. In order: the time limit
 * (out at the open), a tier exit set at the previous hour close (out at the open), the
 * stop (at the stop, or the open on a gap through it), the target (at the target, or the
 * open on a gap up); then the high-water mark and the break-even step, and at an hour's
 * close the tier rule on that hour's RSI (the exit follows at the next observation).
 * Mutates `pos` (stopLoss, highWaterMark, pendingTierExit, lastPrice).
 * @param {{entryPrice:number, stopLoss:number, takeProfit:number, breakEvenAt:number|null,
 *   timeLimitAt:number, tiers:Array|null, pendingTierExit:boolean, highWaterMark:number}} pos
 * @param {{t:number, open:number, low:number, high:number, close:number, rsi?:number|null, hourClosed?:boolean}} obs
 * @returns {{reason:'sat_time'|'sat_tier'|'sat_stop'|'sat_breakeven'|'sat_target', price:number}|null}
 */
export function stepSatellitePosition(pos, { t, open, low, high, close, rsi = null, hourClosed = false }) {
  if (t >= pos.timeLimitAt) return { reason: 'sat_time', price: open };
  if (pos.pendingTierExit) return { reason: 'sat_tier', price: open };
  if (low <= pos.stopLoss) {
    return { reason: pos.stopLoss >= pos.entryPrice ? 'sat_breakeven' : 'sat_stop', price: Math.min(pos.stopLoss, open) };
  }
  if (high >= pos.takeProfit) return { reason: 'sat_target', price: Math.max(pos.takeProfit, open) };
  pos.lastPrice = close;
  pos.highWaterMark = Math.max(pos.highWaterMark, high);
  if (pos.breakEvenAt != null && pos.highWaterMark >= pos.breakEvenAt) pos.stopLoss = Math.max(pos.stopLoss, pos.entryPrice);
  if (pos.tiers && hourClosed && rsi != null && shouldTierExit({ profitPct: close / pos.entryPrice - 1, rsi, tiers: pos.tiers })) {
    pos.pendingTierExit = true;
  }
  return null;
}

/**
 * The exit plan's fields on a filled satellite position (stop, target, break-even level,
 * time limit, tiers), from the fill price and the order's plan.
 */
export function satellitePositionPlan({ fillPrice, stopPrice, plan = {}, filledAt }) {
  const R = fillPrice - stopPrice;
  return {
    initialStopLoss: stopPrice, stopLoss: stopPrice,
    takeProfit: plan.targetR ? fillPrice + plan.targetR * R : Infinity,
    breakEvenAt: plan.breakEvenAtR ? fillPrice + plan.breakEvenAtR * R : null,
    timeLimitAt: filledAt + Number(plan.timeLimitMs ?? Infinity),
    tiers: plan.tiers ?? null, pendingTierExit: false, highWaterMark: fillPrice,
  };
}

/**
 * Dollar size of one satellite entry: `perTradePct` of equity, capped at the free
 * balance; null when that is under the exchange floor.
 */
export function satelliteOrderSize({ equity, freeBalance, perTradePct, minNotional = FALLBACK_MIN_NOTIONAL }) {
  const want = Number(equity) * Number(perTradePct);
  const size = Math.min(want, Number(freeBalance));
  return Number.isFinite(size) && size >= minNotional ? Number(size.toFixed(2)) : null;
}

/**
 * The order and exit plan for one signal: a limit `limitOffsetPct` under the reference
 * price, resting `entryValidMs`; refused when the stop is not under the limit or more
 * than `maxStopPct` under it (the user's rule: no trade risks more than 10%).
 * @returns {{limitPrice:number, validUntil:number, stopPrice:number, sizeUsd:number,
 *   plan:{breakEvenAtR:number|null, targetR:number|null, timeLimitMs:number, tiers:Array|null}}
 *   | {refused: string}}
 */
export function planSatelliteEntry({ signal, refPrice, kindCfg, equity, freeBalance, now, minNotional = FALLBACK_MIN_NOTIONAL }) {
  const limitPrice = Number(refPrice) * (1 - Number(kindCfg.limitOffsetPct ?? 0));
  const stopPrice = Number(signal.stopPrice);
  if (!(limitPrice > 0) || !(stopPrice > 0) || stopPrice >= limitPrice * 0.998) return { refused: 'stop not under the limit' };
  if (1 - stopPrice / limitPrice > Number(kindCfg.maxStopPct ?? 0.10)) return { refused: 'stop too far' };
  const sizeUsd = satelliteOrderSize({ equity, freeBalance, perTradePct: kindCfg.perTradePct, minNotional });
  if (sizeUsd == null) return { refused: 'under the exchange floor' };
  return {
    limitPrice, stopPrice, sizeUsd,
    validUntil: Number(now) + Number(kindCfg.entryValidMs),
    plan: {
      breakEvenAtR: kindCfg.breakEvenAtR ?? null,
      targetR: kindCfg.targetR ?? null,
      timeLimitMs: Number(kindCfg.timeLimitMs),
      tiers: kindCfg.tiers ?? null,
    },
  };
}

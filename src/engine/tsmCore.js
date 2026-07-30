/**
 * TSM majors core sleeve — pure signal + reconciliation logic.
 *
 * Time-series momentum: a core symbol is held long while a majority of the
 * configured trailing-lookback returns is positive, and sits in cash otherwise.
 * The majority vote (default 30/45/60d) ships instead of a single lookback
 * because single-cell winners are spikes above the family plateau — see
 * docs/TREND_CORE_STUDY.md.
 *
 * Core positions are keyed '<symbol>#core' so they never collide with scalper
 * positions on the same market, and carry isCore=true so stop management,
 * bear cash-exit, aging exit, and entry filters leave them alone. Exits happen
 * ONLY on signal flip.
 *
 * Everything here is pure (no I/O, no state) — orchestration lives in main.js.
 */

import { FALLBACK_MIN_NOTIONAL } from '../exchange/exchangeLimits.js';

export const CORE_SUFFIX = '#core';

/** '<symbol>' → '<symbol>#core' */
export const coreKey = (symbol) => `${symbol}${CORE_SUFFIX}`;

/** True for position/trade keys belonging to the core sleeve. */
export const isCoreSymbol = (symbol) => String(symbol ?? '').endsWith(CORE_SUFFIX);

/** '<symbol>#core' → '<symbol>' (pass-through for regular keys). */
export const baseSymbol = (symbol) => String(symbol ?? '').split('#')[0];

/**
 * Majority vote of trailing-momentum lookbacks on CLOSED candles.
 * The caller is responsible for slicing off the forming candle
 * (`candles.slice(0, -1)`) — no lookahead.
 *
 * @param {Array<{close: number}>} closedCandles
 * @param {number[]} lookbackBars e.g. [60, 90, 120]
 * @returns {{on: boolean, positive: number, total: number, needed: number,
 *            insufficientHistory: boolean, votes: Array<{bars: number, valid: boolean, positive: boolean, returnPct: number|null}>}}
 */
export function computeTsmVote(closedCandles, lookbackBars) {
  const lookbacks = (lookbackBars ?? []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  const total = lookbacks.length;
  const needed = Math.floor(total / 2) + 1;
  const n = closedCandles?.length ?? 0;
  const last = n > 0 ? Number(closedCandles[n - 1].close) : NaN;

  const votes = lookbacks.map((bars) => {
    const valid = n > bars && Number.isFinite(last) && last > 0;
    if (!valid) return { bars, valid: false, positive: false, returnPct: null };
    const ref = Number(closedCandles[n - 1 - bars].close);
    const positive = ref > 0 && last > ref;
    return { bars, valid: true, positive, returnPct: ref > 0 ? (last / ref - 1) * 100 : null };
  });

  const insufficientHistory = votes.some((v) => !v.valid);
  const positive = votes.filter((v) => v.positive).length;
  // Any invalid lookback counts as a NO vote — the sleeve stays conservative
  // (in cash) until full history is available.
  return { on: total > 0 && positive >= needed, positive, total, needed, insufficientHistory, votes };
}

/**
 * Annualised realized volatility from the last `windowBars` bar returns of a
 * CLOSED-candle series. Returns null when history is insufficient.
 *
 * @param {Array<{close: number}>} closedCandles
 * @returns {number|null}
 */
export function computeRealizedVolAnnual(closedCandles, { windowBars = 60, barsPerYear = 730 } = {}) {
  const n = closedCandles?.length ?? 0;
  if (n < windowBars + 1) return null;
  const rets = [];
  for (let i = n - windowBars; i < n; i++) {
    const prev = Number(closedCandles[i - 1].close);
    const cur = Number(closedCandles[i].close);
    if (!(prev > 0) || !Number.isFinite(cur)) return null;
    rets.push(cur / prev - 1);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1));
  return sd * Math.sqrt(barsPerYear);
}

/**
 * Target deployment fraction for one core slot, in [0, 1] (spot — no leverage):
 * vol targeting (volTarget/realizedVol, floored) × macro risk-off factor.
 * Missing inputs are neutral: no realized vol → 1, no macro factor → 1.
 * Study basis: combo rule in docs/TREND_CORE_STUDY.md (Sharpe 1.23→1.27 with
 * the macro overlay, DD −44→−36%).
 */
export function computeTargetFraction({ volTarget = null, realizedVol = null, minFraction = 0.2, macroFactor = 1 } = {}) {
  let f = 1;
  if (volTarget && realizedVol && realizedVol > 0) {
    f = Math.min(1, Math.max(minFraction, volTarget / realizedVol));
  }
  f *= Number.isFinite(macroFactor) ? macroFactor : 1;
  return Math.min(1, Math.max(0, f));
}

/**
 * Resize decision for a HELD core position: trade only when the drift from the
 * desired notional exceeds `thresholdPct` of the slot (keeps churn bounded —
 * same 15% rule as the study) and the delta clears the exchange min notional.
 *
 * @returns {number|null} signed USD delta to trade, or null for no action
 */
export function planCoreResize({ desiredUsd, currentUsd, perSlotUsd, thresholdPct = 0.15, minNotionalUsd = 10 } = {}) {
  if (!(perSlotUsd > 0) || !Number.isFinite(desiredUsd) || !Number.isFinite(currentUsd)) return null;
  const delta = desiredUsd - currentUsd;
  if (Math.abs(delta) <= perSlotUsd * thresholdPct) return null;
  if (Math.abs(delta) < minNotionalUsd) return null;
  return Number(delta.toFixed(2));
}

/**
 * Diff desired vs actual core positions into open/close actions.
 *
 * Supports slow-in hysteresis via separate enter/stay thresholds: open a new
 * position only when `enterVotes` lookbacks are positive, but keep an existing
 * one while `stayVotes` still are. The open position itself is the hysteresis
 * state — no extra persistence needed. Both thresholds default to a simple
 * majority (the original symmetric-vote behavior).
 *
 * Study basis (9yr USDT window incl. 2018+2022 bears): enter 3/3 + stay ≥2
 * beats the symmetric vote on Sharpe/DSR in every universe tested and cuts
 * round trips ~3× — see docs/TREND_CORE_STUDY.md.
 *
 * @param {object} args
 * @param {string[]} args.symbols            core universe (base symbols)
 * @param {Map<string, object>|object} args.signals  base symbol → computeTsmVote result
 * @param {Array<{symbol: string, isCore?: boolean}>} args.positions  trader.getStatus().positions
 * @param {number} [args.enterVotes]         positive votes needed to OPEN (default: majority)
 * @param {number} [args.stayVotes]          positive votes needed to KEEP (default: majority)
 * @returns {Array<{type: 'open'|'close', symbol: string, key: string}>}
 */
export function planCoreActions({ symbols, signals, positions, enterVotes = null, stayVotes = null }) {
  const get = (sym) => (signals instanceof Map ? signals.get(sym) : signals?.[sym]);
  const held = new Set((positions ?? []).filter((p) => p.isCore || isCoreSymbol(p.symbol)).map((p) => p.symbol));
  const actions = [];
  for (const symbol of symbols ?? []) {
    const key = coreKey(symbol);
    const vote = get(symbol);
    const total = vote?.total ?? 0;
    if (total <= 0) continue;
    const majority = Math.floor(total / 2) + 1;
    const enterNeed = enterVotes ?? majority;
    const stayNeed = stayVotes ?? majority;
    // computeTsmVote counts invalid (insufficient-history) lookbacks as NO
    // votes, so `positive` is already conservative.
    const positive = vote?.positive ?? 0;
    if (!held.has(key) && positive >= enterNeed) actions.push({ type: 'open', symbol, key });
    else if (held.has(key) && positive < stayNeed) actions.push({ type: 'close', symbol, key });
  }
  return actions;
}

/**
 * Equity-ladder rung selection — de-risk as the account grows, never re-risk.
 *
 * The selector input MUST be high-water-mark equity (all-time max of recorded
 * equity, deposits included), not current equity. Selecting on current equity
 * would step risk UP after losses — martingale sizing, the classic way small
 * accounts die. With HWM the fraction only ever ratchets down; after a drawdown
 * the (smaller) fraction of (smaller) equity can fall under the exchange
 * minimum, which parks the sleeve in cash until recovery — risk-off exactly
 * when it should be.
 *
 * Rungs must be individually validated static profiles (see config.tsmCore
 * .equityLadder); this function only chooses between them. Returns null when
 * the ladder is absent or malformed so the caller can fall back to the static
 * config — an invalid ladder must never invent a profile.
 *
 * @param {number} hwmEquity
 * @param {Array<{minHwmEquity:number, symbols:string[], deploymentPct:number}>} ladder
 * @returns {{minHwmEquity:number, symbols:string[], deploymentPct:number}|null}
 */
export function selectSleeveRung(hwmEquity, ladder) {
  if (!Array.isArray(ladder) || !ladder.length) return null;
  const valid = ladder.filter((r) => Number.isFinite(Number(r?.minHwmEquity))
    && Array.isArray(r?.symbols) && r.symbols.length > 0
    && Number(r?.deploymentPct) > 0);
  if (!valid.length) return null;
  const hwm = Number.isFinite(Number(hwmEquity)) ? Number(hwmEquity) : 0;
  const eligible = valid
    .filter((r) => Number(r.minHwmEquity) <= hwm)
    .sort((a, b) => Number(a.minHwmEquity) - Number(b.minHwmEquity));
  // Below the lowest threshold, the lowest rung still applies — a ladder always
  // selects something once it is structurally valid.
  return eligible.at(-1) ?? valid.sort((a, b) => Number(a.minHwmEquity) - Number(b.minHwmEquity))[0];
}

/**
 * Can this sleeve profile actually place an order at this equity?
 *
 * A slot's notional is equity × (deploymentPct / nSymbols) × volFraction ×
 * macroFactor, and the exchange rejects anything under its minimum notional.
 * Feasibility is judged under an ADVERSE (not absolute-worst) multiplier stack:
 * vol at ~2× target (fraction 0.5) with the macro risk-off ×0.5 active — the
 * conditions typical of a first trend entry after a bear, which is exactly the
 * entry the sleeve exists to catch. The true floor (minFraction × riskOff =
 * 0.1) is deliberately not used: it would mark configs infeasible that trade
 * fine outside vol extremes, and extreme-vol skips are already logged per-open.
 *
 * This is a startup/cycle ADVISORY, not a trade gate — order-time enforcement
 * stays in the trader (and in the backtest simulator, which models the same
 * floor). See tests/backtester/liveParityInventory.test.js.
 *
 * @param {object} args
 * @param {number} args.equity            current account equity
 * @param {number} args.nSymbols          rung universe size
 * @param {number} args.deploymentPct     rung deployment fraction
 * @param {number} [args.adverseVolFraction=0.5]
 * @param {number} [args.riskOffFactor=0.5]
 * @param {number} [args.minNotional]     exchange floor (FALLBACK_MIN_NOTIONAL)
 * @returns {{feasible:boolean, adverseSlotUsd:number, viableFromEquity:number}}
 */
export function sleeveFeasibility({
  equity,
  nSymbols,
  deploymentPct,
  adverseVolFraction = 0.5,
  riskOffFactor = 0.5,
  minNotional = FALLBACK_MIN_NOTIONAL,
} = {}) {
  const n = Math.max(Number(nSymbols) || 0, 1);
  const perSlotFrac = (Number(deploymentPct) || 0) / n;
  const adverse = adverseVolFraction * riskOffFactor;
  const eq = Number(equity) || 0;
  const adverseSlotUsd = eq * perSlotFrac * adverse;
  const viableFromEquity = perSlotFrac > 0 && adverse > 0
    ? minNotional / (perSlotFrac * adverse)
    : Infinity;
  return {
    feasible: adverseSlotUsd >= minNotional,
    adverseSlotUsd: Number(adverseSlotUsd.toFixed(2)),
    viableFromEquity: Number.isFinite(viableFromEquity) ? Math.ceil(viableFromEquity) : Infinity,
  };
}

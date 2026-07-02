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
 * Diff desired vs actual core positions into open/close actions.
 *
 * @param {object} args
 * @param {string[]} args.symbols            core universe (base symbols)
 * @param {Map<string, {on: boolean}>|object} args.signals  base symbol → vote result
 * @param {Array<{symbol: string, isCore?: boolean}>} args.positions  trader.getStatus().positions
 * @returns {Array<{type: 'open'|'close', symbol: string, key: string}>}
 */
export function planCoreActions({ symbols, signals, positions }) {
  const get = (sym) => (signals instanceof Map ? signals.get(sym) : signals?.[sym]);
  const held = new Set((positions ?? []).filter((p) => p.isCore || isCoreSymbol(p.symbol)).map((p) => p.symbol));
  const actions = [];
  for (const symbol of symbols ?? []) {
    const key = coreKey(symbol);
    const on = Boolean(get(symbol)?.on);
    if (on && !held.has(key)) actions.push({ type: 'open', symbol, key });
    else if (!on && held.has(key)) actions.push({ type: 'close', symbol, key });
  }
  return actions;
}

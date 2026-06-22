/**
 * Portfolio-level risk gates (Phase 7).
 *
 * Pure functions used by both the live RiskManager and the PortfolioBacktester
 * so live ≡ backtest is enforced by construction (cardinal rule).
 *
 * - calcCorrelationCap     — block a new entry when an existing position is
 *                            too correlated with the candidate symbol.
 * - calcWeeklyDDBreaker    — pause new entries for `cooldownHours` after the
 *                            7-day rolling P&L crosses `lossThreshold`.
 * - calcPositionAgingExit  — close positions that have been open more than
 *                            `maxAgeBars` candle bars without hitting TP/SL.
 *
 * All three operate on plain JS objects, no I/O, no mutation. Callers
 * (live `core/filters.js` and backtester `PortfolioBacktester`) translate
 * the decisions into actions.
 */

/**
 * @param {object} args
 * @param {string} args.candidateSymbol
 * @param {Array<{symbol: string}>} args.openPositions
 * @param {object} args.correlationMatrix  — { 'A/USDC': { 'B/USDC': 0.83, ... } }
 * @param {number} args.threshold          — correlation r above which we block (0..1)
 * @returns {{ blocked: boolean, conflictSymbol?: string, correlation?: number }}
 */
export function calcCorrelationCap({
  candidateSymbol,
  openPositions = [],
  correlationMatrix = {},
  threshold = 0.85,
}) {
  if (!candidateSymbol || openPositions.length === 0) return { blocked: false };
  const t = Number(threshold);
  if (!(t > 0 && t <= 1)) return { blocked: false };

  const row = correlationMatrix?.[candidateSymbol] ?? {};
  for (const pos of openPositions) {
    if (!pos?.symbol || pos.symbol === candidateSymbol) continue;
    const r = Number(row?.[pos.symbol] ?? correlationMatrix?.[pos.symbol]?.[candidateSymbol]);
    if (Number.isFinite(r) && Math.abs(r) >= t) {
      return { blocked: true, conflictSymbol: pos.symbol, correlation: Number(r.toFixed(4)) };
    }
  }
  return { blocked: false };
}

/**
 * Weekly drawdown circuit breaker.
 *
 * Computes rolling 7-day P&L from `recentTrades` (must include timestamp +
 * pnl). When cumulative 7-day pnl falls below `lossThreshold` (an absolute
 * loss expressed as a fraction of initialBalance, e.g. 0.10 = 10% loss),
 * trigger a `cooldownHours` block on new entries.
 *
 * State is computed fresh each call from `recentTrades` + `nowMs` so it
 * naturally survives restarts: callers persist nothing besides the trade
 * history they already keep.
 *
 * @param {object} args
 * @param {Array<{timestamp: number|string, pnl: number, side: string}>} args.recentTrades
 * @param {number} args.initialBalance
 * @param {number} args.lossThreshold      — fraction of initialBalance (e.g. 0.10)
 * @param {number} args.cooldownHours      — block window after breach (e.g. 72)
 * @param {number} [args.nowMs=Date.now()]
 * @returns {{ blocked: boolean, weeklyPnL: number, weeklyPnLPct: number,
 *             breachedAt?: number, cooldownEndsAt?: number, reason?: string }}
 */
export function calcWeeklyDDBreaker({
  recentTrades = [],
  initialBalance,
  lossThreshold,
  cooldownHours = 72,
  nowMs = Date.now(),
}) {
  const initBal = Number(initialBalance);
  const lossFrac = Number(lossThreshold);
  if (!(initBal > 0) || !(lossFrac > 0 && lossFrac < 1)) {
    return { blocked: false, weeklyPnL: 0, weeklyPnLPct: 0 };
  }
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  const lossAmount = initBal * lossFrac;
  const cooldownMs = Math.max(0, Number(cooldownHours) || 0) * 60 * 60 * 1000;

  // Find the most recent SELL whose 7-day-lookback cumulative pnl is the
  // worst (most negative). If that worst-7d loss ≤ -lossAmount AND the
  // breach happened within cooldownMs of nowMs, we're blocked.
  let breachedAt = null;
  const sells = recentTrades
    .filter((t) => t && t.side === 'SELL')
    .map((t) => ({ ts: tsToMs(t.timestamp), pnl: Number(t.pnl ?? 0) }))
    .filter((t) => Number.isFinite(t.ts) && Number.isFinite(t.pnl))
    .sort((a, b) => a.ts - b.ts);

  // Sliding 7-day window over sells, looking for any window whose cumulative
  // pnl is ≤ -lossAmount and whose anchor ts is within cooldownMs of now.
  for (let endIdx = 0; endIdx < sells.length; endIdx++) {
    const endTs = sells[endIdx].ts;
    if (nowMs - endTs > cooldownMs) continue; // breach is too old to matter
    let cumPnl = 0;
    for (let i = endIdx; i >= 0; i--) {
      if (endTs - sells[i].ts > sevenDaysMs) break;
      cumPnl += sells[i].pnl;
    }
    if (cumPnl <= -lossAmount) {
      breachedAt = endTs;
      // keep scanning to find the LATEST breach (its cooldown is what gates us)
    }
  }

  // Current 7-day pnl (informational, returned in both blocked + clear states)
  let currentWeeklyPnL = 0;
  for (const s of sells) {
    if (nowMs - s.ts <= sevenDaysMs) currentWeeklyPnL += s.pnl;
  }
  const currentWeeklyPnLPct = currentWeeklyPnL / initBal;

  if (breachedAt != null) {
    const cooldownEndsAt = breachedAt + cooldownMs;
    if (nowMs < cooldownEndsAt) {
      return {
        blocked: true,
        weeklyPnL: Number(currentWeeklyPnL.toFixed(2)),
        weeklyPnLPct: Number(currentWeeklyPnLPct.toFixed(4)),
        breachedAt,
        cooldownEndsAt,
        reason: `Weekly DD breaker active — 7d loss ${(currentWeeklyPnL).toFixed(2)} (${(currentWeeklyPnLPct*100).toFixed(2)}%) breached -${(lossFrac*100).toFixed(0)}% threshold; cooldown ends in ${((cooldownEndsAt - nowMs) / 3_600_000).toFixed(1)}h`,
      };
    }
  }

  return {
    blocked: false,
    weeklyPnL: Number(currentWeeklyPnL.toFixed(2)),
    weeklyPnLPct: Number(currentWeeklyPnLPct.toFixed(4)),
  };
}

function tsToMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Date.parse(value);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/**
 * Position aging exit: close positions that have been open more than
 * `maxAgeBars` candle intervals without hitting TP/SL.
 *
 * Sluggish positions tie up capital and almost never end well. This is a
 * structural, non-adaptive rule (not fit to any metric) so it doesn't
 * introduce overfit risk.
 *
 * @param {object} args
 * @param {number} args.entryTs           — position open timestamp (ms)
 * @param {number} args.nowTs             — current timestamp (ms)
 * @param {number} args.candleIntervalMs  — 12h = 43_200_000
 * @param {number} args.maxAgeBars        — e.g. 14 (= 7 days on 12h)
 * @returns {{ shouldExit: boolean, ageBars: number, ageDays: number, reason?: string }}
 */
export function calcPositionAgingExit({
  entryTs,
  nowTs = Date.now(),
  candleIntervalMs,
  maxAgeBars,
}) {
  const entry = Number(entryTs);
  const now = Number(nowTs);
  const interval = Number(candleIntervalMs);
  const cap = Number(maxAgeBars);
  if (!(entry > 0) || !(now > 0) || !(interval > 0) || !(cap > 0)) {
    return { shouldExit: false, ageBars: 0, ageDays: 0 };
  }
  const ageMs = Math.max(0, now - entry);
  const ageBars = Math.floor(ageMs / interval);
  const ageDays = Number((ageMs / (24 * 60 * 60 * 1000)).toFixed(2));
  if (ageBars >= cap) {
    return {
      shouldExit: true,
      ageBars,
      ageDays,
      reason: `position aging exit — open ${ageBars} bars (${ageDays}d) ≥ ${cap}-bar cap`,
    };
  }
  return { shouldExit: false, ageBars, ageDays };
}

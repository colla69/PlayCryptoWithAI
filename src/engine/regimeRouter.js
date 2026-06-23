/**
 * Regime-conditional strategy routing + bear-side defensive policies (Phase 4 + 6a).
 *
 * Two responsibilities, kept together because they both branch off the BTC
 * regime label and share the same routing config:
 *
 *   1. Strategy bundle selection (Phase 4)
 *      Maps a regime label → list of strategy names appropriate for that
 *      environment. BULL_TREND → trend-following pack; BULL_RANGE →
 *      mean-reversion pack; BEAR_* → none (no new entries).
 *
 *   2. Cash-exit-on-bear policy (Phase 6a)
 *      Returns whether the bot should:
 *        - block new entries this cycle (Phase 6a hard gate)
 *        - close ALL open positions this cycle (BEAR regime entry trigger)
 *
 * Both are PURE functions — live + backtester call them identically. No
 * state, no I/O, no logger.
 */

import { REGIME_LABELS } from './regimeClassifier.js';

/**
 * Default strategy bundles per regime. Per-symbol overrides come from
 * config.perSymbol[sym].regimeStrategyBundles (same shape) and win
 * when set. If a bundle is missing for a regime, fall back to the
 * symbol's static strategies list (existing behaviour).
 *
 * BULL_TREND  — trends are intact; ride them. Trend + breakout + volume confirms.
 * BULL_RANGE  — choppy uptrend; buy dips. Mean-reversion + oversold reversal.
 * BEAR_TREND  — capitulation flow; do not catch the knife. No new entries.
 * BEAR_CHOP   — listless bear; nothing to do. No new entries.
 */
export const DEFAULT_REGIME_BUNDLES = Object.freeze({
  BULL_TREND: ['EMA', 'MACD', 'Supertrend', 'Donchian', 'OBV'],
  BULL_RANGE: ['RSI', 'BB', 'Stoch', 'VWAPσ', 'SR'],
  BEAR_TREND: [],   // empty bundle ⇒ no new entries this regime
  BEAR_CHOP:  [],   // empty bundle ⇒ no new entries this regime
});

/**
 * Resolve the strategy list to use for a (symbol, regime) pair.
 *
 * Resolution order:
 *   1. Per-symbol regimeStrategyBundles[regime] override (if non-empty)
 *   2. Global bundles[regime] (passed in)
 *   3. Static perSymbol.strategies (existing list)
 *   4. Config-wide config.strategies fallback
 *
 * Returns null when the regime explicitly maps to an empty bundle —
 * caller treats null as "no entries this regime".
 *
 * @param {object} args
 * @param {string} args.symbol
 * @param {string|null} args.regime
 * @param {object} args.config           — full app config (for perSymbol + strategies)
 * @param {object} [args.bundles]        — override the global bundle map
 * @param {boolean} [args.routingEnabled] — when false, always return null override (use static list)
 * @returns {{ names: string[]|null, source: 'per-symbol-bundle'|'global-bundle'|'per-symbol-static'|'global-static'|'blocked' }}
 */
export function resolveStrategyList({
  symbol,
  regime,
  config,
  bundles = DEFAULT_REGIME_BUNDLES,
  routingEnabled = false,
}) {
  const perSymbol = config?.perSymbol?.[symbol] ?? {};
  const staticList = perSymbol.strategies ?? config?.strategies ?? null;

  // Routing disabled OR no regime yet → use static list
  if (!routingEnabled || !regime) {
    return { names: staticList, source: 'per-symbol-static' };
  }

  // Per-symbol bundle override
  const psBundles = perSymbol.regimeStrategyBundles;
  if (psBundles && Array.isArray(psBundles[regime])) {
    if (psBundles[regime].length === 0) return { names: null, source: 'blocked' };
    return { names: psBundles[regime], source: 'per-symbol-bundle' };
  }

  // Global bundle for this regime
  const gb = bundles?.[regime];
  if (Array.isArray(gb)) {
    if (gb.length === 0) return { names: null, source: 'blocked' };
    return { names: gb, source: 'global-bundle' };
  }

  // Fallback to static
  return { names: staticList, source: 'global-static' };
}

/**
 * Compute the bear-side policy for the current cycle.
 *
 * Decision matrix (with restrictTo='trend_only', the default):
 *   regime === BEAR_TREND AND policy.enabled:
 *     - shouldBlockEntries:    true
 *     - shouldCashExitOpen:    true ONLY on the FIRST cycle after the
 *                              regime transitioned INTO BEAR_TREND
 *   regime === BEAR_CHOP:
 *     - no-op (mean-reversion strategies still work in sideways markets)
 *   regime is null (warmup):  no-op (pass-through)
 *   any BULL_* regime:        no-op (pass-through)
 *
 * Set policy.restrictTo='all_bear' to also block in BEAR_CHOP — more
 * defensive but tested net-negative on long windows (-17pp return).
 *
 * @param {object} args
 * @param {string|null} args.regime
 * @param {boolean} args.regimeChanged — true on the bar regime transitions
 * @param {{enabled?: boolean, restrictTo?: 'trend_only'|'all_bear'}} args.policy
 * @returns {{ shouldBlockEntries: boolean, shouldCashExitOpen: boolean, reason?: string }}
 */
export function computeBearPolicy({ regime, regimeChanged, policy }) {
  if (!policy?.enabled || !regime) {
    return { shouldBlockEntries: false, shouldCashExitOpen: false };
  }
  const restrictTo = policy.restrictTo ?? 'trend_only';
  const isBearTrend = regime === REGIME_LABELS.BEAR_TREND;
  const isBearChop  = regime === REGIME_LABELS.BEAR_CHOP;
  const isTriggered = isBearTrend || (restrictTo === 'all_bear' && isBearChop);
  if (!isTriggered) {
    return { shouldBlockEntries: false, shouldCashExitOpen: false };
  }
  return {
    shouldBlockEntries: true,
    shouldCashExitOpen: Boolean(regimeChanged),
    reason: `BEAR regime ${regime} — new entries blocked${regimeChanged ? ', closing all open positions' : ''}`,
  };
}

/**
 * Build a per-symbol strategy list map for a given regime, applied to all
 * symbols. Used by the backtester to construct per-symbol aggregators.
 *
 * Returns: { 'BTC/USDC': ['EMA', 'MACD', ...], ... } — symbols whose
 * resolved list is null are EXCLUDED from the map (caller checks size).
 */
export function buildRegimeStrategyMap({ symbols, regime, config, bundles, routingEnabled }) {
  const out = {};
  for (const sym of symbols) {
    const r = resolveStrategyList({ symbol: sym, regime, config, bundles, routingEnabled });
    if (r.names && r.names.length > 0) out[sym] = r.names;
  }
  return out;
}

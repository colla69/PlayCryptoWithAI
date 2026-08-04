/**
 * Shared trader utilities — pure calculation functions used by both PaperTrader and LiveTrader.
 * No side effects, no I/O, no logging — callers handle mutations and logging.
 */

const roundPrice = (value) => Number(Number(value ?? 0).toFixed(8));

/**
 * Determine if trailing stop should be updated.
 * @param {{entryPrice: number, highWaterMark: number, stopLoss: number, trailingStopPct?: number}} position
 * @param {number} currentPrice
 * @returns {{shouldUpdate: boolean, newHighWaterMark?: number, newStopLoss?: number}}
 */
export function calcTrailingStop(position, currentPrice) {
  if (!position || !position.trailingStopPct) {
    return { shouldUpdate: false };
  }

  if (currentPrice <= position.entryPrice || currentPrice <= position.highWaterMark) {
    return { shouldUpdate: false };
  }

  const newHighWaterMark = roundPrice(currentPrice);
  const newStopLoss = roundPrice(currentPrice * (1 - position.trailingStopPct));

  if (newStopLoss > position.stopLoss) {
    return { shouldUpdate: true, newHighWaterMark, newStopLoss };
  }

  return { shouldUpdate: false, newHighWaterMark };
}

/**
 * Determine if break-even stop should be triggered.
 * @param {{entryPrice: number, stopLoss: number}} position
 * @param {number} currentPrice
 * @param {number} breakEvenTriggerPct - e.g. 0.05 for 5%
 * @returns {{shouldTrigger: boolean, newStopLoss?: number}}
 */
export function calcBreakEven(position, currentPrice, breakEvenTriggerPct) {
  const bePct = Number(breakEvenTriggerPct ?? 0);
  if (bePct <= 0 || position.stopLoss >= position.entryPrice) {
    return { shouldTrigger: false };
  }

  if (currentPrice >= position.entryPrice * (1 + bePct)) {
    // Lock stop above entry to cover round-trip trading fees (~0.2%)
    return { shouldTrigger: true, newStopLoss: roundPrice(position.entryPrice * 1.002) };
  }

  return { shouldTrigger: false };
}

/**
 * Determine exit reason based on current price vs stop-loss and take-profit.
 * @param {{stopLoss: number, takeProfit: number, initialStopLoss: number, trailingStopPct?: number}} position
 * @param {number} currentPrice
 * @returns {{shouldExit: boolean, reason?: 'stop_loss'|'trailing_stop'|'take_profit'}}
 */
export function calcExitSignal(position, currentPrice) {
  if (currentPrice <= position.stopLoss) {
    const reason = position.trailingStopPct && position.stopLoss > position.initialStopLoss
      ? 'trailing_stop'
      : 'stop_loss';
    return { shouldExit: true, reason };
  }

  if (currentPrice >= position.takeProfit) {
    return { shouldExit: true, reason: 'take_profit' };
  }

  return { shouldExit: false };
}

/**
 * Compute ATR-based stop-loss and take-profit prices.
 *
 * Replaces fixed percentage stops: volatile coins get wider stops naturally,
 * less-volatile coins get tighter stops. ATR% (Average True Range as a
 * fraction of price) is computed by the caller; this function only does
 * the price arithmetic.
 *
 * @param {object} args
 * @param {number} args.fillPrice    — actual entry fill price
 * @param {number} args.atrPct       — current ATR as fraction of price (e.g. 0.04 = 4%)
 * @param {number} args.slMultiplier — SL distance in ATR units (e.g. 1.5)
 * @param {number} args.tpMultiplier — TP distance in ATR units (e.g. 3.0)
 * @param {number} [args.minSlPct]   — clamp: SL never tighter than this fraction
 * @param {number} [args.maxSlPct]   — clamp: SL never wider than this fraction
 * @param {number} [args.minTpPct]   — clamp: TP never tighter than this fraction
 * @param {number} [args.maxTpPct]   — clamp: TP never wider than this fraction
 * @returns {{stopLossPrice: number, takeProfitPrice: number, slPct: number, tpPct: number} | null}
 *          Returns null when atrPct is not a finite positive number — caller
 *          should fall back to fixed-percent stops.
 */
export function calcATRStopPrices({
  fillPrice,
  atrPct,
  slMultiplier,
  tpMultiplier,
  minSlPct = 0.02,
  maxSlPct = 0.12,
  minTpPct = 0.04,
  maxTpPct = 0.30,
}) {
  const price = Number(fillPrice);
  const atr = Number(atrPct);
  if (!Number.isFinite(price) || price <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const slMult = Number(slMultiplier);
  const tpMult = Number(tpMultiplier);
  if (!Number.isFinite(slMult) || slMult <= 0) return null;
  if (!Number.isFinite(tpMult) || tpMult <= 0) return null;

  const rawSlPct = atr * slMult;
  const rawTpPct = atr * tpMult;
  const slPct = Math.min(Math.max(rawSlPct, minSlPct), maxSlPct);
  const tpPct = Math.min(Math.max(rawTpPct, minTpPct), maxTpPct);

  return {
    slPct,
    tpPct,
    stopLossPrice:   roundPrice(price * (1 - slPct)),
    takeProfitPrice: roundPrice(price * (1 + tpPct)),
  };
}

/**
 * Two-stage exit: should we partially close the position now?
 *
 * Fires once per position when the unrealized gain reaches a fraction of the
 * total TP target (e.g. firstStagePctOfTp=0.5 → fires at +50% of TP). The
 * caller closes `firstStageFraction` of the qty (e.g. 0.5 = half), books the
 * profit, and leaves the rest running with the original SL/TP — which the
 * existing break-even logic will then lift to entry+fees on the next cycle.
 *
 * Property: never fires twice (idempotent guard via `position.partialExitDone`).
 *
 * @param {{entryPrice: number, takeProfit: number, partialExitDone?: boolean}} position
 * @param {number} currentPrice
 * @param {number} firstStagePctOfTp — e.g. 0.5
 * @param {number} firstStageFraction — e.g. 0.5 (close half the qty)
 * @returns {{shouldExit: boolean, fraction?: number, triggerPrice?: number}}
 */
export function calcPartialExit(position, currentPrice, firstStagePctOfTp, firstStageFraction) {
  if (!position || position.partialExitDone) return { shouldExit: false };
  const tpDist = Number(position.takeProfit) - Number(position.entryPrice);
  if (!(tpDist > 0)) return { shouldExit: false };
  const stagePct = Number(firstStagePctOfTp);
  if (!(stagePct > 0 && stagePct < 1)) return { shouldExit: false };
  const frac = Number(firstStageFraction);
  if (!(frac > 0 && frac < 1)) return { shouldExit: false };
  const triggerPrice = Number(position.entryPrice) + tpDist * stagePct;
  if (Number(currentPrice) >= triggerPrice) {
    return { shouldExit: true, fraction: frac, triggerPrice: roundPrice(triggerPrice) };
  }
  return { shouldExit: false };
}

const isCoreRecord = (key, record) => record?.isCore === true && String(key).endsWith('#core');
const baseOfCoreKey = (key) => String(key).split('#')[0].split('/')[0];

/**
 * Reserve the wallet coins the TSM core sleeve already owns, per base asset.
 *
 * The wallet asset is fungible: free ETH may back BOTH a core and a scalper
 * position on the same market. Every core leg must reserve its coins before the
 * scalper restore attributes whatever is left — **including legs already live in
 * memory**, which never enter the restore loop (it skips keys already tracked)
 * but own their coins all the same. Missing that case let the scalper claim the
 * sleeve's own ETH as a phantom position, double-counting it into equity.
 *
 * Claims are clamped to the wallet's actual free balance, so a corrupt or stale
 * state file can never reserve — or later sell — coins the sleeve never bought.
 *
 * @param {object} args
 * @param {object} [args.savedState]     persisted position state, keyed by symbol
 * @param {Map|Array|object} [args.livePositions] positions currently in memory
 * @param {object} [args.freeBalances]   free wallet balance per base asset
 * @param {number} [args.now]            clock override for openedAt validation
 * @returns {{
 *   claimsByBase: Map<string, number>,
 *   restorable: Array<{key: string, market: string, base: string, savedQty: number, entryPrice: number, saved: object}>,
 *   dropped: Array<{key: string, reason: string}>
 * }}
 */
export function calcCoreClaims({
  savedState = {},
  livePositions = new Map(),
  freeBalances = {},
  now = Date.now(),
} = {}) {
  const claimsByBase = new Map();
  const restorable = [];
  const dropped = [];

  const claim = (base, qty) => {
    if (!(Number(qty) > 0)) return;
    const free = Number(freeBalances?.[base] ?? 0);
    const already = claimsByBase.get(base) ?? 0;
    const room = Math.max(0, free - already);
    if (room <= 0) return;
    claimsByBase.set(base, already + Math.min(Number(qty), room));
  };

  const liveEntries = livePositions instanceof Map
    ? [...livePositions.entries()]
    : Array.isArray(livePositions)
      ? livePositions
      : Object.entries(livePositions ?? {});
  const liveKeys = new Set(liveEntries.map(([key]) => key));

  for (const [key, position] of liveEntries) {
    if (!isCoreRecord(key, position)) continue;
    claim(baseOfCoreKey(key), Number(position?.qty ?? 0));
  }

  for (const [key, saved] of Object.entries(savedState ?? {})) {
    if (!isCoreRecord(key, saved)) continue;
    if (liveKeys.has(key)) continue; // already reserved from memory above

    const savedQty = Number(saved?.qty ?? 0);
    const entryPrice = roundPrice(Number(saved?.entryPrice ?? 0));
    if (!(savedQty > 0) || !(entryPrice > 0)) continue;

    // Sanity-check the saved record before it can drive real sell orders:
    // a corrupt/hand-edited state file must not claim wallet coins the
    // sleeve never bought. openedAt must exist and lie in the past.
    const openedAtMs = Date.parse(saved?.openedAt ?? '');
    if (!Number.isFinite(openedAtMs) || openedAtMs > now) {
      dropped.push({ key, reason: 'invalid openedAt' });
      continue;
    }

    // Reserved EVEN IF the restore below fails on price/notional — otherwise the
    // scalper absorbs the core's coins and the sleeve double-buys later.
    claim(baseOfCoreKey(key), savedQty);
    restorable.push({
      key,
      market: String(key).split('#')[0],
      base: baseOfCoreKey(key),
      savedQty,
      entryPrice,
      saved,
    });
  }

  return { claimsByBase, restorable, dropped };
}

/**
 * Cycle watchdog — a deadman switch for the trading loop.
 *
 * The July 2026 soak proved the failure mode: a host suspend stalled the loop
 * for 18 hours and then left it firing 6h09m off candle close for 48
 * consecutive cycles. Every log line needed to diagnose it existed; nothing
 * READ them for 24 days. The scheduler drift is fixed (cycleScheduler.js
 * re-derives from the clock), but a suspended or hung host still just stops
 * deciding — silently, because a dead process sends no error.
 *
 * So this inverts the signal: instead of alerting on an error, alert on the
 * ABSENCE of the routine heartbeat. If no cycle has completed within
 * `factor × candle period`, something is wrong at the host level and the
 * operator should know within the check interval, not at the next restart.
 *
 * Pure logic here; main.js owns the timer, the lastCycleAt bookkeeping, and
 * the Telegram call.
 */

/**
 * @param {object} args
 * @param {number|null} args.lastCycleAt  ms timestamp of the last COMPLETED cycle
 * @param {number} args.now
 * @param {number} args.periodMs          candle period (12h)
 * @param {number} [args.factor=1.15]     tolerance: cycle time + scheduling slack
 * @returns {{stale: boolean, gapMs: number|null, thresholdMs: number}}
 */
export function checkCycleGap({ lastCycleAt, now, periodMs, factor = 1.15 }) {
  const threshold = Number(periodMs) * (Number.isFinite(Number(factor)) && Number(factor) > 0 ? Number(factor) : 1.15);
  if (!Number.isFinite(Number(lastCycleAt)) || lastCycleAt == null) {
    // Startup: nothing has completed yet. Not stale — the boot itself is the
    // operator's signal, and alerting before the first cycle would fire on
    // every restart.
    return { stale: false, gapMs: null, thresholdMs: threshold };
  }
  const gapMs = Number(now) - Number(lastCycleAt);
  return { stale: gapMs > threshold, gapMs, thresholdMs: threshold };
}

/**
 * One-alert-per-incident latch: fire on the transition into stale, stay quiet
 * while it persists, re-arm when a cycle completes again (so the NEXT stall
 * alerts too). Returns what the caller should do this tick.
 *
 * @param {{alerted: boolean}} state   mutable latch owned by the caller
 * @param {boolean} stale
 * @returns {{fire: boolean, recovered: boolean}}
 */
export function updateWatchdogLatch(state, stale) {
  if (stale && !state.alerted) {
    state.alerted = true;
    return { fire: true, recovered: false };
  }
  if (!stale && state.alerted) {
    state.alerted = false;
    return { fire: false, recovered: true };
  }
  return { fire: false, recovered: false };
}

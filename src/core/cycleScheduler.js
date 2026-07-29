/**
 * Candle-close-aligned cycle scheduler.
 *
 * Binance closes 12h candles at exactly 00:00 and 12:00 UTC. The bot must
 * evaluate just after a close, so every cycle time is re-derived from the wall
 * clock — never accumulated from the previous one.
 *
 * The original implementation awaited the first aligned run and only then
 * started `setInterval(pollIntervalMs)`. That baked the run's duration into the
 * interval's phase and gave the loop no way to resync: during the 2026-07 soak a
 * single ~18h stall left it firing at 06:09/18:09 UTC — 6h09m past candle close
 * — for 48 consecutive cycles, until an unrelated restart happened to fix it.
 *
 * Rescheduling from `nextCandleClose()` after every run makes drift
 * self-correcting: a late or slow cycle costs that one cycle, never the
 * alignment. Every dependency is injectable so the behaviour is testable
 * against a fake clock.
 */

import { timeframeMs } from '../utils/candleFreshness.js';

/** Settle buffer so the closing candle is published before we fetch it. */
export const DEFAULT_CLOSE_BUFFER_MS = 3_000;

/**
 * Timestamp (ms) of the next candle-close boundary for `timeframe`, plus a
 * settle buffer. Unparseable timeframes fall back to one minute out so a
 * misconfigured bot retries rather than hanging forever.
 *
 * @param {string} timeframe
 * @param {number} [now]
 * @param {number} [bufferMs]
 * @returns {number}
 */
export function nextCandleClose(timeframe, now = Date.now(), bufferMs = DEFAULT_CLOSE_BUFFER_MS) {
  const periodMs = timeframeMs(timeframe);
  if (periodMs == null) return now + 60_000;
  return Math.ceil(now / periodMs) * periodMs + bufferMs;
}

/**
 * Builds a self-rescheduling, candle-aligned runner.
 *
 * @param {object} args
 * @param {string} args.timeframe            e.g. '12h'
 * @param {() => Promise<void>} args.run      one cycle
 * @param {(at: number) => void} [args.onSchedule]  called with the next fire time
 * @param {(err: Error) => void} [args.onError]     a failed cycle must not stop the loop
 * @param {() => boolean} [args.isStopped]    shutdown guard, checked before each schedule
 * @param {number} [args.bufferMs]
 * @param {() => number} [args.now]           injectable clock (tests)
 * @param {Function} [args.setTimeoutFn]      injectable timer (tests)
 * @param {Function} [args.clearTimeoutFn]
 * @returns {{start: () => void, stop: () => void}}
 */
export function createAlignedScheduler({
  timeframe,
  run,
  onSchedule = () => {},
  onError = () => {},
  isStopped = () => false,
  bufferMs = DEFAULT_CLOSE_BUFFER_MS,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null;

  function schedule() {
    if (isStopped()) return;
    const at = nextCandleClose(timeframe, now(), bufferMs);
    onSchedule(at);
    // Clamp: a clock jump backwards must not produce a negative delay.
    timer = setTimeoutFn(async () => {
      timer = null;
      try {
        await run();
      } catch (err) {
        onError(err);
      } finally {
        // Re-derive from the clock. However long `run` took, the next fire is
        // the next real candle close.
        schedule();
      }
    }, Math.max(0, at - now()));
  }

  return {
    start: schedule,
    stop() {
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
    },
  };
}

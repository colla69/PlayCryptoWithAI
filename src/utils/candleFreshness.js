/**
 * Candle-series freshness helpers.
 *
 * A thin, illiquid or delisted market keeps returning klines from Binance, but
 * the series stops advancing. The live loop happily fed those frozen bars to the
 * aggregator (LSK/TON/GMX emitted an identical confidence for 63 consecutive
 * cycles during the 2026-07 soak), and the backtester silently loaded month-old
 * MTF caches. Both paths need the same "is this series actually current?" test,
 * so the maths lives here and is consumed by live + backtest alike.
 */

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * Timeframe string ('15m', '4h', '12h', '1d') → milliseconds. Null when unparseable.
 * @param {string} timeframe
 * @returns {number|null}
 */
export function timeframeMs(timeframe) {
  const match = String(timeframe ?? '').toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const mult = UNIT_MS[match[2]];
  return Number.isFinite(num) && num > 0 && mult ? num * mult : null;
}

/**
 * Age of the newest bar in a series, in ms. Null when the series is empty or
 * carries no usable timestamp.
 * @param {Array<{timestamp: number}>} candles
 * @param {number} [now]
 * @returns {number|null}
 */
export function candleSeriesAgeMs(candles, now = Date.now()) {
  const newest = Number(candles?.at?.(-1)?.timestamp);
  return Number.isFinite(newest) ? now - newest : null;
}

/**
 * True when the newest bar is older than `maxPeriods` timeframe periods.
 *
 * The forming candle is normally the newest bar, so at candle-close+3s the age
 * is ~0 and a symbol whose forming bar hasn't appeared yet is one period old.
 * `maxPeriods` therefore needs to be ≥ 2 to avoid false positives — the default
 * catches genuinely frozen markets (weeks stale) with a wide margin.
 *
 * Unknown timeframes and empty series report `stale: false`: callers already
 * handle "no candles" separately and this must never invent a block.
 *
 * @param {Array<{timestamp: number}>} candles
 * @param {string} timeframe
 * @param {number} [maxPeriods=2]
 * @param {number} [now]
 * @returns {{stale: boolean, ageMs: number|null, periodMs: number|null, agePeriods: number|null}}
 */
export function checkCandleFreshness(candles, timeframe, maxPeriods = 2, now = Date.now()) {
  const periodMs = timeframeMs(timeframe);
  const ageMs = candleSeriesAgeMs(candles, now);
  if (periodMs == null || ageMs == null) {
    return { stale: false, ageMs, periodMs, agePeriods: null };
  }
  const agePeriods = ageMs / periodMs;
  const limit = Number.isFinite(maxPeriods) && maxPeriods > 0 ? maxPeriods : 2;
  return { stale: agePeriods > limit, ageMs, periodMs, agePeriods };
}

/** Human-readable age for log lines: "3.2d", "5.0h", "12m". */
export function formatAge(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const days = ageMs / 86_400_000;
  if (days >= 1) return `${days.toFixed(1)}d`;
  const hours = ageMs / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  return `${Math.round(ageMs / 60_000)}m`;
}

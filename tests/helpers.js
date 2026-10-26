/**
 * Shared test helpers — candle fixtures, mock factories, constants.
 */

/**
 * Generate OHLCV candles from an array of close prices.
 * Each candle gets realistic open/high/low derived from close.
 * @param {number[]} closes - Array of close prices
 * @param {object} [opts]
 * @param {number} [opts.startTime=0] - Timestamp of the first candle
 * @param {number} [opts.interval=43200000] - Candle interval in ms (default 12h)
 */
export function makeCandles(closes, { startTime = 0, interval = 43_200_000 } = {}) {
  return closes.map((close, i) => ({
    timestamp: startTime + i * interval,
    open: +(close * 0.995).toFixed(8),
    high: +(close * 1.02).toFixed(8),
    low: +(close * 0.98).toFixed(8),
    close: +close.toFixed(8),
    volume: 1000,
  }));
}

/**
 * Generate a trending candle series (up or down).
 * @param {number} start - Starting close price
 * @param {number} end - Ending close price
 * @param {number} count - Number of candles
 */
export function makeTrend(start, end, count, opts) {
  const step = (end - start) / (count - 1);
  const closes = Array.from({ length: count }, (_, i) => start + step * i);
  return makeCandles(closes, opts);
}

/**
 * Generate flat/sideways candles around a price.
 * @param {number} price - Center price
 * @param {number} count - Number of candles
 * @param {number} [noise=0.002] - Max random deviation fraction
 */
export function makeFlat(price, count, noise = 0.002) {
  const closes = Array.from({ length: count }, (_, i) => {
    const jitter = (i % 2 === 0 ? 1 : -1) * price * noise * ((i % 3) / 3);
    return price + jitter;
  });
  return makeCandles(closes);
}

/** Default risk config matching production defaults */
export const DEFAULT_RISK = {
  initialBalance: 200,
  maxPositionPct: 0.15,
  stopLossPct: 0.065,
  takeProfitPct: 0.14,
  trailingStopPct: 0,
  breakEvenTriggerPct: 0.04,
  maxOpenPositions: 3,
  maxDailyLossPct: 0.05,
  minConfidence: 0.6,
};

// ── Synthetic market for the engine replay tests (moved from engineReplayParity.test.js) ──
const H12_MS = 12 * 60 * 60 * 1000;
const H4_MS = 4 * 60 * 60 * 1000;
const M15_MS = 15 * 60 * 1000;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** 12h bars plus their 15m and 4h sub-bars from `t0`; the trend swings with `period` bars. */
export function syntheticMarket(seed, period, { t0, bars }) {
  const rnd = lcg(seed);
  const c12 = []; const c15 = []; const c4 = [];
  let price = 100;
  for (let g = 0; g < bars; g++) {
    const drift = 0.005 * Math.sin((2 * Math.PI * g) / period);
    const open = price;
    const steps = 48;
    let p = open; let hi = open; let lo = open;
    const sub = [];
    for (let k = 0; k < steps; k++) {
      const o = p;
      p = o * (1 + drift + (rnd() - 0.5) * 0.025);
      const h = Math.max(o, p) * (1 + rnd() * 0.002);
      const l = Math.min(o, p) * (1 - rnd() * 0.002);
      sub.push({ timestamp: t0 + g * H12_MS + k * M15_MS, open: o, high: h, low: l, close: p, volume: 10 + rnd() * 10 });
      hi = Math.max(hi, h); lo = Math.min(lo, l);
    }
    c15.push(...sub);
    for (let q = 0; q < 3; q++) {
      const part = sub.slice(q * 16, q * 16 + 16);
      c4.push({
        timestamp: t0 + g * H12_MS + q * H4_MS, open: part[0].open, close: part.at(-1).close,
        high: Math.max(...part.map((x) => x.high)), low: Math.min(...part.map((x) => x.low)),
        volume: part.reduce((s, x) => s + x.volume, 0),
      });
    }
    c12.push({ timestamp: t0 + g * H12_MS, open, high: hi, low: lo, close: p, volume: sub.reduce((s, x) => s + x.volume, 0) });
    price = p;
  }
  return { c12, c15, c4 };
}


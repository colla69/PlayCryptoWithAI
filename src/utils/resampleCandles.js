/**
 * OHLCV timeframe resampling.
 *
 * Binance aligns every timeframe to the UTC epoch, so a 12h bar is exactly the
 * three 4h bars starting at 00:00 and 12:00 UTC. That makes 4h → 12h a lossless
 * aggregation rather than an approximation, which is what lets us rebuild deep
 * 12h history from the 4h caches: Binance only serves ~390 days of 12h klines
 * for these USDC pairs, but the 4h series reaches back to 2020.
 *
 * Only whole-multiple conversions are supported (12h = 3 x 4h). Partial buckets
 * are dropped — a 12h bar built from two 4h bars would understate its range and
 * silently corrupt every indicator downstream.
 */

import { timeframeMs } from './candleFreshness.js';

/**
 * Aggregate a candle series into a coarser timeframe.
 *
 * @param {Array<{timestamp:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 *   source series, ascending by timestamp
 * @param {string} fromTf e.g. '4h'
 * @param {string} toTf   e.g. '12h'
 * @returns {{candles: Array<object>, dropped: number}} resampled series plus the
 *   number of source bars discarded because their bucket was incomplete
 */
export function resampleCandles(candles, fromTf, toTf) {
  const srcMs = timeframeMs(fromTf);
  const dstMs = timeframeMs(toTf);
  if (srcMs == null || dstMs == null) throw new Error(`unparseable timeframe: ${fromTf} → ${toTf}`);
  if (dstMs <= srcMs) throw new Error(`target timeframe must be coarser: ${fromTf} → ${toTf}`);
  if (dstMs % srcMs !== 0) throw new Error(`${toTf} is not a whole multiple of ${fromTf}`);

  const perBucket = dstMs / srcMs;
  const buckets = new Map();

  for (const c of candles ?? []) {
    const ts = Number(c?.timestamp);
    if (!Number.isFinite(ts)) continue;
    // Floor to the destination grid — identical to how the exchange stamps bars.
    const key = Math.floor(ts / dstMs) * dstMs;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(c);
  }

  const out = [];
  let dropped = 0;
  for (const [key, bars] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (bars.length !== perBucket) {
      // Incomplete bucket: the tail of the series mid-formation, or a gap in the
      // source data. Either way the aggregate would be wrong.
      dropped += bars.length;
      continue;
    }
    bars.sort((a, b) => a.timestamp - b.timestamp);
    out.push({
      timestamp: key,
      open: Number(bars[0].open),
      high: Math.max(...bars.map((b) => Number(b.high))),
      low: Math.min(...bars.map((b) => Number(b.low))),
      close: Number(bars.at(-1).close),
      volume: bars.reduce((s, b) => s + Number(b.volume ?? 0), 0),
    });
  }
  return { candles: out, dropped };
}

/**
 * Compare a resampled series against real exchange bars on their overlap.
 *
 * This is the safety check that makes rebuilding history defensible: if the
 * aggregation is correct, every resampled bar must equal the exchange's own bar
 * for the same timestamp. Volume is compared with a relative tolerance because
 * the exchange rounds it; OHLC must match to `pricePrecision`.
 *
 * @returns {{compared:number, mismatches:Array<{timestamp:number,field:string,resampled:number,actual:number}>}}
 */
export function diffAgainstActual(resampled, actual, { pricePrecision = 8, volumeTolerance = 1e-6 } = {}) {
  const byTs = new Map(actual.map((c) => [Number(c.timestamp), c]));
  const round = (v) => Number(Number(v).toFixed(pricePrecision));
  const mismatches = [];
  let compared = 0;

  for (const r of resampled) {
    const a = byTs.get(r.timestamp);
    if (!a) continue;
    compared++;
    for (const field of ['open', 'high', 'low', 'close']) {
      if (round(r[field]) !== round(a[field])) {
        mismatches.push({ timestamp: r.timestamp, field, resampled: r[field], actual: Number(a[field]) });
      }
    }
    const av = Number(a.volume ?? 0);
    const rel = av === 0 ? Math.abs(r.volume) : Math.abs(r.volume - av) / av;
    if (rel > volumeTolerance) {
      mismatches.push({ timestamp: r.timestamp, field: 'volume', resampled: r.volume, actual: av });
    }
  }
  return { compared, mismatches };
}

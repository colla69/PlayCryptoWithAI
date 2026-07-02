import fs from 'fs';
import logger from '../utils/logger.js';

/**
 * NASDAQ trend feed for the TSM core sleeve's equity risk-off overlay (M1):
 * half-size crypto exposure while the NASDAQ Composite is below its 100-day
 * EMA. Study basis: docs/TREND_CORE_STUDY.md — the one context overlay that
 * improved Sharpe AND drawdown in every universe tested (DSR 0.94).
 *
 * Data: FRED's keyless CSV endpoint (daily closes since 1971). Cached to disk
 * with a 12h TTL; a failed refresh falls back to the stale cache, and a caller
 * with no data at all should treat the overlay as neutral (factor 1).
 */

const CACHE = 'data/nasdaqTrend.json';
const FRED_URL = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=NASDAQCOM';
const TTL_MS = 12 * 3_600_000;
const DAY_MS = 86_400_000;

/** @returns {Promise<{fetchedAt: number, rows: Array<{t: number, v: number}>}|null>} */
export async function loadNasdaqHistory() {
  let stale = null;
  try {
    if (fs.existsSync(CACHE)) {
      const d = JSON.parse(fs.readFileSync(CACHE, 'utf-8'));
      if (d?.rows?.length) {
        if (Date.now() - d.fetchedAt < TTL_MS) return d;
        stale = d;
      }
    }
  } catch {
    // corrupt cache — fall through to the network fetch
  }
  try {
    const csv = await (await fetch(FRED_URL)).text();
    const rows = csv.trim().split('\n').slice(1)
      .map((line) => {
        const [date, value] = line.split(',');
        return { t: Date.parse(`${date}T00:00:00Z`), v: Number(value) };
      })
      // Sanity range: this feed scales real position sizes, so a corrupt or
      // poisoned response must never survive parsing. NASDAQ has printed
      // between ~50 and ~30,000 in its entire history.
      .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v) && r.v > 1 && r.v < 1_000_000);
    // A healthy FRED NASDAQCOM series has ~14,000 daily rows. A drastically
    // shorter response is an outage/tamper signal — keep the existing cache.
    if (rows.length < 5000) throw new Error(`implausible FRED response (${rows.length} rows)`);
    const data = { fetchedAt: Date.now(), rows };
    fs.writeFileSync(CACHE, JSON.stringify(data));
    return data;
  } catch (err) {
    logger.warn(`NASDAQ trend fetch failed: ${err.message}${stale ? ' — using stale cache' : ''}`);
    return stale;
  }
}

/**
 * Pure: is the NASDAQ above its EMA as of `asOfMs`?
 *
 * Only observations with t + 24h ≤ asOf are visible — a daily close dated D
 * (00:00 UTC) prints ~21:00 UTC, so it becomes usable the next day. Same lag
 * rule as the backtest study → live/backtest parity.
 *
 * @param {Array<{t: number, v: number}>|null} rows daily closes, ascending
 * @returns {{available: boolean, above: boolean, close: number|null, ema: number|null, asOfRow: number|null}}
 */
export function computeEquityRiskOff(rows, { emaDays = 100, asOfMs = Date.now() } = {}) {
  if (!Array.isArray(rows) || rows.length < emaDays) {
    return { available: false, above: true, close: null, ema: null, asOfRow: null };
  }
  const alpha = 2 / (emaDays + 1);
  let ema = null, close = null, asOfRow = null, seen = 0;
  for (const r of rows) {
    if (r.t + DAY_MS > asOfMs) break;
    ema = ema === null ? r.v : r.v * alpha + ema * (1 - alpha);
    close = r.v;
    asOfRow = r.t;
    seen++;
  }
  if (seen < emaDays || close === null) {
    return { available: false, above: true, close, ema, asOfRow };
  }
  return { available: true, above: close > ema, close, ema, asOfRow };
}

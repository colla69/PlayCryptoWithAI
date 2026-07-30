/**
 * Daily equity snapshots — the valuation series time-weighted return needs.
 *
 * TWR chains growth between cash flows, which requires knowing what the account
 * was worth immediately before each deposit or withdrawal. Nothing recorded that:
 * trade rows carry a balance, but trades are rare (30 in a year on this config),
 * so a deposit could easily land weeks from the nearest valuation. One snapshot
 * per day makes the series dense enough for contributions to be measurable.
 *
 * Deliberately append-only and one row per UTC day: this is a measurement record,
 * and rewriting history would defeat the point. Kept separate from
 * dashboard_persist.json so the "dashboardState is its sole writer" rule holds.
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';

const FILE = () => path.resolve(process.cwd(), 'data', 'equity_history.json');
/** ~5 years of daily points; far beyond any window the baseline runner uses. */
const MAX_POINTS = 2000;

const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);

/** @returns {Array<{timestamp:number, equity:number, date:string}>} ascending */
export function loadEquityHistory() {
  try {
    const raw = fs.readFileSync(FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // absent or unreadable — callers treat this as "no history yet"
  }
}

/**
 * Record today's equity. The last write of a given UTC day wins, so the stored
 * value is the most recent valuation for that day rather than the first.
 *
 * @param {number} equity account value (free quote + open position value)
 * @param {number} [now]
 * @returns {boolean} whether anything was persisted
 */
export function recordEquitySnapshot(equity, now = Date.now()) {
  const value = Number(equity);
  // A failed balance fetch surfaces as 0 and must not be recorded as a wipeout.
  if (!Number.isFinite(value) || value <= 0) return false;

  try {
    const history = loadEquityHistory();
    const today = dayKey(now);
    const point = { timestamp: now, equity: value, date: today };

    if (history.length && history.at(-1).date === today) history[history.length - 1] = point;
    else history.push(point);

    const trimmed = history.slice(-MAX_POINTS);
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(trimmed), 'utf8');
    return true;
  } catch (err) {
    logger.warn(`[equity-history] write failed: ${err.message}`);
    return false;
  }
}

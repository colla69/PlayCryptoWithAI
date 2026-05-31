import { readFileSync, writeFile, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dirname, '../../data');
const STATE_FILE = join(DATA_DIR, 'dashboard_persist.json');
const SIGNAL_HISTORY_FILE = join(DATA_DIR, 'signal_history.json');

export const MAX_SIGNAL_HISTORY = 5000;

/** Load the last-saved trades + signalFeed from disk. Returns null on miss. */
export function loadPersistedState() {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const raw = readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let _saveTimer = null;

/**
 * Debounced async write — called after every pushTrade / pushSignal.
 * Writes at most once per 500 ms to avoid hammering disk during bulk updates.
 */
export function scheduleSave(trades, signalFeed) {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    const data = JSON.stringify({ trades, signalFeed });
    writeFile(STATE_FILE, data, 'utf8', () => {});
  }, 500);
}

/** Load signal history from disk. */
export function loadSignalHistory() {
  try {
    if (!existsSync(SIGNAL_HISTORY_FILE)) return [];
    return JSON.parse(readFileSync(SIGNAL_HISTORY_FILE, 'utf8'));
  } catch { return []; }
}

let _historyTimer = null;

/** Debounced save of signal history (2s). */
export function scheduleHistorySave(history) {
  clearTimeout(_historyTimer);
  _historyTimer = setTimeout(() => {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFile(SIGNAL_HISTORY_FILE, JSON.stringify(history), 'utf8', () => {});
  }, 2000);
}

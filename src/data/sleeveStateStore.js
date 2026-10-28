/**
 * The TSM sleeve's memory between cycles that must survive a restart (plan doc § L, § M):
 * which core keys were sold and wait for a 20-day high before a buy-back (`rebuyGate`), and
 * when each key was last sold (`lastExitAt`, for the re-entry pause). Without it a restart
 * forgets a waiting sell and the sleeve buys straight back — the behaviour the backtest
 * showed to be worse, and a quiet live ≠ backtest break.
 *
 * One small JSON file under runtimeDir('data'). Written atomically (temp file + rename), so
 * a crash mid-write leaves the previous file. Loading never throws: an absent file is an
 * empty state; an unreadable one is logged loudly and also empty, which is the old
 * (shipped, tested) sleeve behaviour.
 */

import fs from 'fs';
import path from 'path';
import logger from '../utils/logger.js';
import { runtimeDir } from '../utils/runtimePaths.js';

export const sleeveStateFile = () => path.join(runtimeDir('data'), 'tsm_sleeve_state.json');
const VERSION = 1;
const isCoreKey = (k) => typeof k === 'string' && k.endsWith('#core') && k.length > 5;

/** @returns {{ rebuyGate: Map<string, true>, lastExitAt: Map<string, number> }} */
export function loadSleeveState(file = sleeveStateFile()) {
  const empty = { rebuyGate: new Map(), lastExitAt: new Map() };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.error(`[TSM-STATE] cannot read ${file}: ${err.message} — starting empty`);
    return empty;
  }
  try {
    const d = JSON.parse(raw);
    if (d?.version !== VERSION) throw new Error(`unknown version ${d?.version}`);
    const rebuyGate = new Map((Array.isArray(d.rebuyGate) ? d.rebuyGate : []).filter(isCoreKey).map((k) => [k, true]));
    const lastExitAt = new Map(Object.entries(d.lastExitAt ?? {})
      .filter(([k, v]) => isCoreKey(k) && Number.isFinite(v) && v > 0));
    return { rebuyGate, lastExitAt };
  } catch (err) {
    logger.error(`[TSM-STATE] ${file} is unreadable (${err.message}) — starting empty`);
    return empty;
  }
}

/** @returns {boolean} whether the file was written */
export function saveSleeveState({ rebuyGate, lastExitAt }, file = sleeveStateFile(), now = Date.now()) {
  const body = JSON.stringify({
    version: VERSION,
    savedAt: new Date(now).toISOString(),
    rebuyGate: [...rebuyGate.keys()],
    lastExitAt: Object.fromEntries(lastExitAt),
  });
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    logger.error(`[TSM-STATE] write failed: ${err.message}`);
    return false;
  }
}

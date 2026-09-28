import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Where the bot keeps its live state: dashboard_persist.json, signal_history.json,
 * position_state.json, equity_history.json, deposits.json (under `data/`) and
 * trades.csv + the app/error logs (under `logs/`).
 *
 * The Docker deployment bind-mounts ./data and ./logs from the checkout, so a write
 * to the checkout's data/ IS a write to the running bot's state. On 2026-09-28 three
 * pre-commit `npm test` runs deleted the live dashboard_persist.json, replaced its
 * history with fixture trades, appended 176 fake rows to trades.csv and fixture
 * COINn/USDT signals to signal_history.json; the live bot reloaded them on its next
 * boot and reported daily_pnl=+438 on a $223 account (daily-loss brake defeated).
 *
 * Resolution order:
 *   1. PLAYCRYPTO_RUNTIME_DIR, if set (read on every call);
 *   2. in a test process — however it was launched — a throwaway per-process temp dir;
 *   3. process.cwd(), as before.
 * A test process that would resolve inside the checkout throws instead: a test must
 * never be able to read or write live state, whatever the env says.
 *
 * Candle caches and market-data caches (fearGreed, nasdaqTrend, marketContext) are
 * research inputs, not bot state, and stay under process.cwd()/data.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let testRoot = null;

const isInside = (child, parent) => {
  const rel = path.relative(parent, path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** True in any process running tests. Each launch mode sets a different signal. */
export function isTestProcess() {
  return Boolean(process.env.NODE_TEST_CONTEXT)         // node --test (child per file)
    || process.execArgv.includes('--test')               // node --test --test-isolation=none
    || Boolean(process.env.VITEST)                       // vitest run
    || /\.test\.[cm]?js$/.test(process.argv[1] ?? '');   // node some.test.js
}

export function runtimeRoot() {
  const testing = isTestProcess();
  if (testing && !process.env.PLAYCRYPTO_RUNTIME_DIR && !testRoot) {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'playcrypto-test-'));
    const dir = testRoot;
    process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  }
  const root = process.env.PLAYCRYPTO_RUNTIME_DIR || (testing ? testRoot : process.cwd());
  if (testing && isInside(root, REPO_ROOT)) {
    throw new Error(`test process resolved bot state to ${root}, inside the checkout `
      + `(${REPO_ROOT}) whose data/ and logs/ the live container mounts — refusing`);
  }
  return root;
}

/** @param {'data'|'logs'} kind */
export function runtimeDir(kind) {
  return path.join(runtimeRoot(), kind);
}

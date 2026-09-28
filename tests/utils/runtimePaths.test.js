/**
 * A test run must never touch the live bot's state.
 *
 * Incident 2026-09-28: the Docker deployment bind-mounts ./data and ./logs from
 * the checkout, and the state writers resolved their paths to exactly those dirs.
 * Three pre-commit `npm test` runs deleted the live data/dashboard_persist.json
 * (src/tests/dashboardState.test.js rmSync'd it), refilled it with fixture trades,
 * appended 176 fake rows to logs/trades.csv and COINn/USDT signals to
 * signal_history.json. On its next boot the live bot seeded today's P&L from them:
 * daily_pnl=+438 on a $223 account, which disables the daily-loss brake.
 *
 * Every suite passed while this happened — nothing asserted *where* they wrote.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runtimeRoot, runtimeDir, isTestProcess } from '../../src/utils/runtimePaths.js';
import { STATE_FILE } from '../../src/dashboard/persistence.js';
import { appendTrade } from '../../src/utils/logger.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isInside = (child, parent) => !path.relative(parent, path.resolve(child)).startsWith('..');

// Run each check with the override cleared: under --test-isolation=none every file
// shares this process, and other suites' hooks may have set it.
function withoutOverride(fn) {
  const saved = process.env.PLAYCRYPTO_RUNTIME_DIR;
  delete process.env.PLAYCRYPTO_RUNTIME_DIR;
  try { return fn(); } finally {
    if (saved !== undefined) process.env.PLAYCRYPTO_RUNTIME_DIR = saved;
  }
}

describe('runtime state in a test process', () => {
  test('resolves to a temp dir, never the checkout', () => {
    assert.ok(isTestProcess(), 'this process must be recognised as a test run');
    const root = withoutOverride(() => runtimeRoot());
    assert.ok(!isInside(root, REPO), `${root} is inside the checkout`);
    assert.ok(isInside(root, os.tmpdir()), `${root} is not under the OS temp dir`);
  });

  test('the dashboard persist file is outside the checkout', () => {
    assert.ok(!isInside(STATE_FILE, REPO), `${STATE_FILE} is the live bot's file`);
  });

  test('appendTrade writes trades.csv to the runtime dir, not logs/', () => {
    const marker = `runtime-paths-${process.pid}-${Date.now()}`;
    appendTrade({ timestamp: marker, symbol: 'TEST/USDC', side: 'BUY', price: 1, qty: 1, pnl: 0, balance: 0 });

    const csv = withoutOverride(() => fs.readFileSync(path.join(runtimeDir('logs'), 'trades.csv'), 'utf8'));
    assert.ok(csv.includes(marker));

    const live = path.join(REPO, 'logs', 'trades.csv');
    if (fs.existsSync(live)) assert.ok(!fs.readFileSync(live, 'utf8').includes(marker));
  });

  test('PLAYCRYPTO_RUNTIME_DIR overrides, and is read on every call', () => {
    const saved = process.env.PLAYCRYPTO_RUNTIME_DIR;
    process.env.PLAYCRYPTO_RUNTIME_DIR = '/srv/bot-state';
    try {
      assert.equal(runtimeDir('data'), path.join('/srv/bot-state', 'data'));
    } finally {
      if (saved === undefined) delete process.env.PLAYCRYPTO_RUNTIME_DIR;
      else process.env.PLAYCRYPTO_RUNTIME_DIR = saved;
    }
  });

  test('a test process pointed at the checkout throws instead of writing', () => {
    const saved = process.env.PLAYCRYPTO_RUNTIME_DIR;
    process.env.PLAYCRYPTO_RUNTIME_DIR = REPO;
    try {
      assert.throws(() => runtimeDir('data'), /inside the checkout/);
    } finally {
      if (saved === undefined) delete process.env.PLAYCRYPTO_RUNTIME_DIR;
      else process.env.PLAYCRYPTO_RUNTIME_DIR = saved;
    }
  });
});

// The first fix only covered `node --test` (child processes). Running a file
// directly or with --test-isolation=none still wrote the live files — every
// launch mode is probed in a fresh process, with the parent's test signals removed.
describe('every test launch mode is isolated', () => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-probe-'));
  const resolver = pathToFileURL(path.join(REPO, 'src/utils/runtimePaths.js')).href;
  const body = `import { runtimeRoot } from '${resolver}';\n`
    + `process.stdout.write('ROOT=' + runtimeRoot() + '\\n');\n`;
  const testFile = path.join(probeDir, 'probe.test.mjs');
  const plainFile = path.join(probeDir, 'probe.mjs');
  fs.writeFileSync(testFile, body);
  fs.writeFileSync(plainFile, body);

  function rootFrom(args, extraEnv = {}) {
    const base = { ...process.env };
    delete base.NODE_TEST_CONTEXT;
    delete base.PLAYCRYPTO_RUNTIME_DIR;
    delete base.VITEST;
    const env = { ...base, ...extraEnv };
    const out = execFileSync(process.execPath, args, { cwd: REPO, env, encoding: 'utf8' });
    return out.match(/ROOT=(.+)/)[1].trim();
  }

  const cases = [
    ['node --test <file>', ['--test', testFile]],
    ['node --test --test-isolation=none <file>', ['--test', '--test-isolation=none', testFile]],
    ['node <file>.test.mjs', [testFile]],
    ['vitest (VITEST=true)', [plainFile], { VITEST: 'true' }],
  ];
  for (const [name, args, env] of cases) {
    test(`${name} resolves outside the checkout`, () => {
      const root = rootFrom(args, env);
      assert.ok(!isInside(root, REPO), `${name} resolved live state to ${root}`);
    });
  }

  test('a non-test process still resolves to cwd (production path unchanged)', () => {
    assert.equal(rootFrom([plainFile]), REPO);
  });

  after(() => fs.rmSync(probeDir, { recursive: true, force: true }));
});

// Structural guard: a new writer that builds its own path to data/ or logs/
// bypasses the resolver and reopens the incident. Only research inputs and
// outputs may resolve from the checkout directly, each with a stated reason.
const ALLOWED_DIRECT_PATHS = {
  'src/exchange/candleCache.js': 'candle cache — research input, shared with backtests',
  'src/data/marketContext.js': 'market-data cache — re-fetchable, not bot state',
  'src/backtester/report.js': 'backtest report output — research artefact',
};

function listJs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listJs(p);
    return e.name.endsWith('.js') || e.name.endsWith('.mjs') ? [p] : [];
  });
}

describe('runtime state path inventory', () => {
  test('no runtime module builds a data/ or logs/ path outside runtimePaths.js', () => {
    const DIRECT = /(process\.cwd\(\)|import\.meta\.url|__dirname)[^\n]*['"](\.\.\/)*(data|logs)\b/;
    const offenders = listJs(path.join(REPO, 'src'))
      .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
      .filter((rel) => !rel.startsWith('src/scripts/') && !rel.startsWith('src/tests/'))
      .filter((rel) => rel !== 'src/utils/runtimePaths.js' && !ALLOWED_DIRECT_PATHS[rel])
      .filter((rel) => DIRECT.test(fs.readFileSync(path.join(REPO, rel), 'utf8')));

    assert.deepEqual(offenders, [],
      'resolve bot state through runtimeDir() (src/utils/runtimePaths.js), '
      + 'or add the file to ALLOWED_DIRECT_PATHS with a reason if it is research data');
  });
});

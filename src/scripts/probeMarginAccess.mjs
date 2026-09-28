#!/usr/bin/env node
/**
 * Probe which margin, futures and Simple Earn (USDC) products this Binance account can use.
 *
 * Answers the open checklist in docs/SHORTING_FEASIBILITY.md from the account
 * itself. Read-only by construction, twice over:
 *   - it needs a READ-ONLY API key: binanceClient.fetchMarginAccessReport() checks
 *     the key's permissions first and refuses one that can trade, borrow, transfer
 *     or withdraw — so the live trading key can never be used here;
 *   - every call it makes is a GET.
 *
 * Put the read-only key in `.env.probe` (gitignored) as BINANCE_API_KEY /
 * BINANCE_API_SECRET, then:
 *
 *   node src/scripts/probeMarginAccess.mjs
 *   node src/scripts/probeMarginAccess.mjs --symbols BTC/USDC,ETH/USDC,SOL/USDC --json
 *
 * The output holds permission flags, availability and borrow rates — no balances.
 */
import dotenv from 'dotenv';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PROBE_ENV = path.join(REPO_ROOT, '.env.probe');   // absolute, never cwd-relative
const fail = (msg) => { console.error(msg); process.exit(2); };

if (!existsSync(PROBE_ENV)) fail(`${PROBE_ENV} not found — create it with a READ-ONLY key (BINANCE_API_KEY, BINANCE_API_SECRET).`);
const probeEnv = dotenv.parse(readFileSync(PROBE_ENV));
if (!probeEnv.BINANCE_API_KEY || !probeEnv.BINANCE_API_SECRET) fail(`${PROBE_ENV} must define BINANCE_API_KEY and BINANCE_API_SECRET`);

// Keys come from .env.probe and nowhere else. dotenv honours DOTENV_CONFIG_* env vars and
// dotenv_config_* argv, either of which could make binanceClient's own `import 'dotenv/config'`
// load a different file over these keys — so strip them, then point that load at .env.probe.
if (process.argv.some((a) => a.startsWith('dotenv_config_'))) fail('dotenv_config_* arguments are not allowed');
for (const k of Object.keys(process.env)) if (k.startsWith('DOTENV_CONFIG_')) delete process.env[k];
delete process.env.DOTENV_KEY;   // no .env.vault decryption path either
process.env.DOTENV_CONFIG_PATH = PROBE_ENV;

// Refuse a key that matches any checkout's .env (this worktree and the main checkout).
// Compared in memory only, never printed.
const checkoutEnvs = new Set([path.join(REPO_ROOT, '.env')]);
try {
  const main = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n').find((l) => l.startsWith('worktree '))?.slice('worktree '.length);
  if (main) checkoutEnvs.add(path.join(main, '.env'));
} catch { /* not a git checkout — the permission check below still applies */ }
for (const f of checkoutEnvs) {
  if (existsSync(f) && dotenv.parse(readFileSync(f)).BINANCE_API_KEY === probeEnv.BINANCE_API_KEY) {
    fail(`refusing: .env.probe holds the same API key as ${f}`);
  }
}

process.env.BINANCE_API_KEY = probeEnv.BINANCE_API_KEY;
process.env.BINANCE_API_SECRET = probeEnv.BINANCE_API_SECRET;
process.env.PAPER_MODE = 'false';     // binanceClient only attaches keys outside paper mode
process.env.BINANCE_TESTNET = 'false';

const argv = process.argv.slice(2);
const symIdx = argv.indexOf('--symbols');
const symbols = symIdx >= 0 && argv[symIdx + 1] ? argv[symIdx + 1].split(',') : ['BTC/USDC', 'ETH/USDC'];
const asJson = argv.includes('--json');

const { fetchMarginAccessReport } = await import('../exchange/binanceClient.js');
if (process.env.BINANCE_API_KEY !== probeEnv.BINANCE_API_KEY) fail('API key changed while loading binanceClient — aborting');

let report;
try {
  report = await fetchMarginAccessReport(symbols);
} catch (err) {
  console.error(`probe aborted: ${String(err.message).replace(/signature=[0-9a-f]+/gi, 'signature=***')}`);
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify({ at: new Date().toISOString(), symbols, report }, null, 2));
  process.exit(0);
}

for (const row of report) {
  console.log(`\n## ${row.label}: ${row.ok ? 'OK' : 'ERROR'}`);
  if (!row.ok) { console.log(`   ${row.error}`); continue; }
  const data = Array.isArray(row.data) && row.data.length > 12
    ? [...row.data.slice(0, 6), `… ${row.data.length - 12} more …`, ...row.data.slice(-6)]
    : row.data;
  console.log(JSON.stringify(data, null, 2).split('\n').map((l) => `   ${l}`).join('\n'));
}
process.exit(0);

#!/usr/bin/env node
/**
 * One-shot repair for the 2026-08-10 frozen-core-equity incident.
 *
 * The fast risk loop skipped core sleeve legs with a bare `continue`, so
 * `LiveTrader.checkRisk()` — the only writer of `position.currentPrice` — was
 * never called for them. `#positionRows()` fell back to `entryPrice` for the
 * whole life of the position, and `calcEquityFromStatus()` therefore valued the
 * sleeve at its open/restore price. See the fix in src/main.js and the
 * regression tests in tests/executor/coreMarkToMarket.test.js.
 *
 * `data/equity_history.json` does NOT self-heal for past days: recordEquitySnapshot
 * only ever replaces *today's* entry. 2026-08-04 → 2026-08-09 are frozen at
 * 188.81815737 and must be rewritten here. Today's entry is left alone — the
 * fixed bot overwrites it on its next 5-minute balance poll.
 *
 * WHY THESE NUMBERS ARE KNOWN EXACTLY
 * -----------------------------------
 * Holdings were constant across the whole window — the last trade was the BTC
 * core BUY at 2026-08-04T12:00:22Z, and every snapshot below is timestamped
 * 23:57 UTC, after it. So equity(t) = freeUSDC + ethQty·ETH(t) + btcQty·BTC(t)
 * with all three quantities fixed:
 *
 *   freeUSDC 94.95   — logged verbatim on every cycle 08-05 → 08-10, and equal
 *                      to the 141.55 pre-buy balance minus the 46.60 BTC fill
 *   ethQty   0.0254695, btcQty 0.00073  — from data/position_state.json
 *
 * The frozen value decomposes exactly against those quantities:
 *   94.95 + 0.0254695×1855.86 + 0.00073×63836.07 = 188.81815737
 * where 1855.86 is the 08-04T08:37 restore-time ETH price (the SELL that ran at
 * that instant executed at 1855.86) and 63836.07 is the BTC entry fill. That
 * identity is what proves the diagnosis, and the script re-checks it before
 * writing anything.
 *
 * Prices below are Binance 1-minute closes for the bar covering each snapshot's
 * exact minute, fetched 2026-08-10 from the public OHLCV endpoint.
 *
 * Run with the bot STOPPED. Dry-run by default; pass --apply to write.
 * Idempotent: re-running a repaired file reports "already clean".
 *
 *   node src/scripts/repairFrozenCoreEquity.mjs            # show what would change
 *   node src/scripts/repairFrozenCoreEquity.mjs --apply    # write it
 *
 * Dependency-free (node builtins only) so it runs on the host without
 * node_modules, against the bind-mounted data/ directory.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='));
const DATA_DIR = dataDirArg
  ? path.resolve(dataDirArg.split('=')[1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

const FILE = 'equity_history.json';

// ── Incident parameters ─────────────────────────────────────────────────────
const HOLDINGS = { freeUsdc: 94.95, ethQty: 0.0254695, btcQty: 0.00073 };
/** What the frozen valuation was pinned to. */
const FROZEN = { equity: 188.81815737, ethPrice: 1855.86, btcPrice: 63836.07 };
/** Binance 1m closes at each snapshot minute. */
const TRUE_PRICES = [
  { date: '2026-08-04', timestamp: 1785887862192, eth: 1868.84, btc: 64070.95 },
  { date: '2026-08-05', timestamp: 1785974262515, eth: 1906.77, btc: 64602.67 },
  { date: '2026-08-06', timestamp: 1786060662883, eth: 1902.46, btc: 64264.58 },
  { date: '2026-08-07', timestamp: 1786147063094, eth: 1913.21, btc: 64887.40 },
  { date: '2026-08-08', timestamp: 1786233463784, eth: 1915.00, btc: 64898.56 },
  { date: '2026-08-09', timestamp: 1786319863845, eth: 1908.09, btc: 64839.60 },
];
/** Float slop allowed when matching the recorded frozen value. */
const EPSILON = 1e-6;

const valueAt = (eth, btc) =>
  HOLDINGS.freeUsdc + HOLDINGS.ethQty * eth + HOLDINGS.btcQty * btc;

const full = path.join(DATA_DIR, FILE);
const fail = (msg) => { console.error(`REFUSING TO WRITE — ${msg}`); process.exit(1); };

// ── Guard: the decomposition must reproduce the frozen value ────────────────
// If this drifts, the diagnosis behind every number below is wrong.
const reproduced = valueAt(FROZEN.ethPrice, FROZEN.btcPrice);
if (Math.abs(reproduced - FROZEN.equity) > EPSILON) {
  fail(`frozen-value identity broken: holdings imply ${reproduced}, file recorded ${FROZEN.equity}`);
}

if (!fs.existsSync(full)) fail(`${FILE} not found in ${DATA_DIR}`);
const history = JSON.parse(fs.readFileSync(full, 'utf8'));
if (!Array.isArray(history)) fail(`${FILE} is not an array`);

const byDate = new Map(history.map((p, i) => [p.date, { point: p, index: i }]));
const changes = [];
const skipped = [];

for (const target of TRUE_PRICES) {
  const found = byDate.get(target.date);
  if (!found) { skipped.push(`${target.date}: absent from the series`); continue; }
  const { point, index } = found;

  const corrected = Number(valueAt(target.eth, target.btc).toFixed(8));
  if (Math.abs(Number(point.equity) - corrected) <= EPSILON) {
    skipped.push(`${target.date}: already repaired`);
    continue;
  }
  if (Math.abs(Number(point.equity) - FROZEN.equity) > EPSILON) {
    skipped.push(`${target.date}: equity ${point.equity} is neither the frozen value `
      + `nor the corrected one — left untouched, inspect by hand`);
    continue;
  }
  if (Number(point.timestamp) !== target.timestamp) {
    skipped.push(`${target.date}: timestamp ${point.timestamp} != expected `
      + `${target.timestamp} — the snapshot moved, prices no longer match its minute`);
    continue;
  }

  changes.push({ index, date: target.date, from: Number(point.equity), to: corrected });
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`equity_history repair — ${DATA_DIR}/${FILE}`);
console.log(`frozen-value identity checks out: ${reproduced.toFixed(8)}\n`);

if (changes.length) {
  console.log('date         recorded        corrected       delta');
  for (const c of changes) {
    console.log(`${c.date}   ${c.from.toFixed(8).padStart(13)}  ${c.to.toFixed(8).padStart(13)}  ${(c.to - c.from >= 0 ? '+' : '')}${(c.to - c.from).toFixed(8)}`);
  }
  const oldMax = Math.max(...history.map((p) => Number(p.equity) || 0));
  const patched = history.map((p, i) => {
    const c = changes.find((x) => x.index === i);
    return c ? { ...p, equity: c.to } : p;
  });
  const newMax = Math.max(...patched.map((p) => Number(p.equity) || 0));
  console.log(`\nsleeve ladder HWM: ${oldMax.toFixed(2)} → ${newMax.toFixed(2)}`);

  if (APPLY) {
    fs.copyFileSync(full, `${full}.bak`);
    fs.writeFileSync(full, JSON.stringify(patched), 'utf8');
    console.log(`\nWROTE ${changes.length} point(s). Backup: ${FILE}.bak`);
  } else {
    console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  }
} else {
  console.log('no corrupted snapshots — already clean');
}

for (const s of skipped) console.log(`  skipped ${s}`);

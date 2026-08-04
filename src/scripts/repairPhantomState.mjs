#!/usr/bin/env node
/**
 * One-shot state repair for the 2026-08-03 phantom-position incident.
 *
 * The scalper restore claimed the TSM core sleeve's own ETH as a separate
 * position (see the calcCoreClaims fix in src/executor/traderUtils.js). The code
 * fix stops it recurring, but three persisted artefacts do not all self-heal:
 *
 *   position_state.json    self-heals — the fixed restore never re-attributes the
 *                          coins, and the file is rewritten from memory on the
 *                          next save. Cleaned here anyway so the file is honest.
 *   dashboard_persist.json does NOT self-heal — the synthetic
 *                          '🔄 restored-from-exchange' BUY is a permanent fake
 *                          trade skewing win-rate and P&L, and leaves a dangling
 *                          open position in the history view.
 *   equity_history.json    does NOT self-heal for past days. recordEquitySnapshot
 *                          only overwrites *today's* entry, so 2026-08-03 is
 *                          frozen at the inflated value — and it is the all-time
 *                          max, i.e. exactly the HWM the sleeve equity ladder
 *                          reads to pick its rung.
 *
 * Run with the bot STOPPED — a running instance rewrites these files underneath
 * you. Dry-run by default; pass --apply to write. Idempotent: re-running a
 * repaired state reports "already clean" and changes nothing.
 *
 *   node src/scripts/repairPhantomState.mjs            # show what would change
 *   node src/scripts/repairPhantomState.mjs --apply    # write it
 *
 * Deliberately dependency-free (node builtins only) so it runs on the host
 * without node_modules, against the bind-mounted data/ directory.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const APPLY = process.argv.includes('--apply');
const dataDirArg = process.argv.find((a) => a.startsWith('--data-dir='));
const DATA_DIR = dataDirArg
  ? path.resolve(dataDirArg.split('=')[1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

// ── Incident parameters ─────────────────────────────────────────────────────
// Verified against the live exchange on 2026-08-04: the wallet held 0.0320695
// ETH total, which is the core leg alone. The scalper record below is entirely
// phantom. The script refuses to write if the files no longer match this state.
const INCIDENT = {
  market: 'ETH/USDC',
  coreKey: 'ETH/USDC#core',
  base: 'ETH',
  phantomQty: 0.02507615,
  coreQtyOnRecord: 0.0321,
  realWalletQty: 0.0320695,
  quoteBalance: 129.31092349,
  syntheticNote: '🔄 restored-from-exchange',
  pollutedDates: ['2026-08-03', '2026-08-04'],
  // ETH traded 1854–1890 across the incident window (checkRisk logs, 08-03/08-04).
  // A generous band around that is what makes the repair idempotent: a polluted
  // entry and a clean one imply prices differing by 1.78x — the ratio of
  // (core + phantom) to the real holding — so at most one can land in this band.
  plausiblePriceBand: [1500, 2300],
};

const readJson = (file) => {
  const full = path.join(DATA_DIR, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
};
const writeJson = (file, value) => {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value), 'utf8');
};

const changes = [];
const skipped = [];

// ── 1. position_state.json — drop the phantom scalper leg ───────────────────
const positionState = readJson('position_state.json');
if (!positionState) {
  skipped.push('position_state.json: not found');
} else if (!positionState[INCIDENT.market]) {
  skipped.push(`position_state.json: no ${INCIDENT.market} entry — already clean`);
} else {
  const entry = positionState[INCIDENT.market];
  const core = positionState[INCIDENT.coreKey];
  const combined = Number(entry.qty ?? 0) + Number(core?.qty ?? 0);
  // Only a genuinely impossible total proves the leg is phantom: core + scalper
  // may legitimately coexist on one market when the wallet actually backs both.
  if (!core) {
    skipped.push(`position_state.json: no core leg on ${INCIDENT.base} — leaving ${INCIDENT.market} alone`);
  } else if (combined <= INCIDENT.realWalletQty + 1e-8) {
    skipped.push(`position_state.json: ${INCIDENT.market} is backed by real coins — leaving it alone`);
  } else {
    delete positionState[INCIDENT.market];
    changes.push({
      file: 'position_state.json',
      what: `removed phantom ${INCIDENT.market} (qty ${entry.qty}) — core ${core.qty} + scalper `
          + `${entry.qty} = ${combined.toFixed(8)} ${INCIDENT.base} vs ${INCIDENT.realWalletQty} actually held`,
      value: positionState,
    });
  }
}

// ── 2. dashboard_persist.json — drop the synthetic BUY ──────────────────────
const persist = readJson('dashboard_persist.json');
if (!persist) {
  skipped.push('dashboard_persist.json: not found');
} else {
  const before = persist.trades?.length ?? 0;
  const phantomTrades = (persist.trades ?? []).filter(
    (t) => t.symbol === INCIDENT.market && t.side === 'BUY' && t.note === INCIDENT.syntheticNote,
  );
  if (!phantomTrades.length) {
    skipped.push('dashboard_persist.json: no synthetic restore trade — already clean');
  } else {
    persist.trades = (persist.trades ?? []).filter((t) => !phantomTrades.includes(t));
    // Mirrors dashboardState.deleteTrade(): suppress synthetic recreation.
    const suppressed = new Set(persist.suppressedSynthetics ?? []);
    suppressed.add(INCIDENT.market);
    persist.suppressedSynthetics = [...suppressed];
    changes.push({
      file: 'dashboard_persist.json',
      what: `removed ${phantomTrades.length} synthetic BUY (${before} → ${persist.trades.length} trades), `
          + `suppressedSynthetics += ${INCIDENT.market}`,
      value: persist,
    });
  }
}

// ── 3. equity_history.json — de-inflate the polluted snapshots ──────────────
const history = readJson('equity_history.json');
if (!Array.isArray(history)) {
  skipped.push('equity_history.json: not found or not an array');
} else {
  const [bandLo, bandHi] = INCIDENT.plausiblePriceBand;
  const inBand = (p) => p >= bandLo && p <= bandHi;
  const corrections = [];
  for (const point of history) {
    if (!INCIDENT.pollutedDates.includes(point.date)) continue;
    const excess = Number(point.equity) - INCIDENT.quoteBalance;
    // Which composition explains this figure? Only one can imply a real price.
    const priceIfPolluted = excess / (INCIDENT.coreQtyOnRecord + INCIDENT.phantomQty);
    const priceIfClean = excess / INCIDENT.realWalletQty;

    if (inBand(priceIfClean)) {
      skipped.push(`equity_history.json: ${point.date} already reflects the real holding `
        + `(implied ETH ${priceIfClean.toFixed(2)}) — left alone`);
      continue;
    }
    if (!inBand(priceIfPolluted)) {
      skipped.push(`equity_history.json: ${point.date} matches neither composition `
        + `(equity ${Number(point.equity).toFixed(2)}) — left alone, inspect manually`);
      continue;
    }
    corrections.push({
      point,
      from: Number(point.equity),
      to: INCIDENT.quoteBalance + INCIDENT.realWalletQty * priceIfPolluted,
      impliedPrice: priceIfPolluted,
    });
  }
  if (!corrections.length) {
    skipped.push('equity_history.json: no inflated snapshots — already clean');
  } else {
    for (const c of corrections) c.point.equity = c.to;
    const hwm = Math.max(...history.map((p) => Number(p.equity) || 0));
    changes.push({
      file: 'equity_history.json',
      what: corrections
        .map((c) => `${c.point.date}: ${c.from.toFixed(2)} → ${c.to.toFixed(2)} `
          + `(implied ETH ${c.impliedPrice.toFixed(2)})`)
        .join('; ') + ` — ladder HWM now $${hwm.toFixed(2)}`,
      value: history,
    });
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`data dir: ${DATA_DIR}`);
console.log(APPLY ? 'mode: APPLY\n' : 'mode: DRY RUN (pass --apply to write)\n');

for (const s of skipped) console.log(`  skip  ${s}`);
for (const c of changes) console.log(`  fix   ${c.file}: ${c.what}`);

if (!changes.length) {
  console.log('\nNothing to repair — state is already clean.');
  process.exit(0);
}

if (APPLY) {
  for (const c of changes) writeJson(c.file, c.value);
  console.log(`\nWrote ${changes.length} file(s). Rebuild and restart the bot now.`);
} else {
  console.log('\nDry run — nothing written.');
}

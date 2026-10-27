/**
 * Recalibration under live conditions (2026-10, after the single-engine rebuild).
 *
 * Every cell runs through the engine live runs (engineReplay.js): the TSM sleeve on and
 * sharing the wallet, a small account ($190) with ~$10/week deposits — the user's
 * capital policy — the $11 exchange floor, fees and tiered slippage. A cell is a sizing
 * setup; the question is which one beats the live system under those conditions.
 *
 * Pre-registered (declared before the first run, every cell reported):
 *   benchmarks  L0 = the live system as deployed (old exits: SL/TP ÷1.5, break-even +5%)
 *               L1 = the committed config (exits ×1.5, break-even +10%)
 *   grid        slots × size per slot ∈ {4×15%, 3×20%, 2×30%, 2×40%}
 *               × minSizeMultiplier (floor on the brake product) ∈ {0, 0.5}
 *               × min-notional bump ∈ {off, on}            → 16 cells, L1 among them
 *   windows     in-sample 2021-01-01 → 2024-12-31 (selection)
 *               holdout   2025-01-01 → 2026-08-10 (confirmation only), each from $190
 *   accept      TWR and Sharpe above L0 and L1 on both windows, max DD ≤ 10% (the
 *               user's tolerance), DSR ≥ 0.5 with every cell charged.
 *
 * Usage (deep candle set in data/candles):
 *   PAPER_MODE=true node src/scripts/runRecalibration.mjs [--jobs 8] [--out data/recalibration.json]
 *   (a worker: --worker '<cell json>' --from <date> --to <date>)
 *
 * Live window (2026-10-25): --live <snapshot dir> replays live's own period instead —
 * its start equity, its real deposits, its Fear & Greed, Nasdaq and equity-history
 * files — for L0 (live as deployed), L1 (committed) and the trailing candidate, and
 * puts live's real equity next to them. Run it on the live candle set.
 *   TSM_CORE=true PAPER_MODE=true node src/scripts/runRecalibration.mjs --live ~/Sandbox/rebuild-snapshot-extract \
 *     [--from 2026-08-03] [--to 2026-10-24T12:00:00Z] --out data/recalibration_live.json
 */

import 'dotenv/config';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import config from '../../config/default.js';
import * as bf from '../backtester/baselineFramework.js';
import { replayEngine } from '../backtester/engineReplay.js';
import { readDvolCache } from '../data/dvolFeed.js';
import { deflatedSharpeRatio } from '../backtester/deflatedSharpe.js';
import { annualizedSharpe, dailyReturnsFromEquity } from '../backtester/metrics.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PRIOR_TRIALS = 16280 + 36; // the standard burden plus the 2026-10 stop sweep
const START_BALANCE = 190;
const DCA_USD = 10;
const DCA_EVERY_MS = 7 * 86_400_000;
const LIVE = arg('--live');
const WINDOWS = LIVE ? [{ id: 'live', from: arg('--from', '2026-08-03'), to: arg('--to', '2026-10-24T12:00:00Z') }] : [
  { id: 'in-sample', from: '2021-01-01', to: '2024-12-31' },
  { id: 'holdout', from: '2025-01-01', to: '2026-08-10' },
];
const readSnapshot = (f) => JSON.parse(fs.readFileSync(`${LIVE}/${f}`, 'utf8'));
const pointTs = (p) => Number(p.timestamp ?? Date.parse(p.date));

// Stage 1 (sizing for a small account) found no rejections at the floor and that
// concentration gains return at the cost of drawdown; a check without the sleeve
// showed the sleeve carrying most of the holdout drawdown. Stage 2, pre-registered
// after stage 1 and before its own first run, crosses concentration with the sleeve's
// share of equity on today's rung.
const STAGE = Number(arg('--stage', 1));
const STAGE1_CELLS = 17;
// Cells run before stage 3: stage 2 (10), the trailing sweep (20) and its plateau check (9).
const BEFORE_STAGE3 = STAGE1_CELLS + 10 + 20 + 9;
const GRID = [];
// Stage 4 (2026-10-25, asked by the user "just to be sure"): L0, L1 and the trail
// without the 7-day aging exit (risk.positionAgingExit), next to the same with it.
const TRAIL_CELL = { exits: 'new', slots: 4, pct: 0.15, minSize: 0, bump: false, trail: 0.10, arm: 0.05, id: 'trail 10% from +5%' };
const NO_AGING = [
  { exits: 'old', slots: 4, pct: 0.15, minSize: 0, bump: false, aging: false, id: 'L0, no 7-day exit' },
  { exits: 'new', slots: 4, pct: 0.15, minSize: 0, bump: false, aging: false, id: 'L1, no 7-day exit' },
  { ...TRAIL_CELL, aging: false, id: 'trail 10% from +5%, no 7-day exit' },
];
if (LIVE || STAGE === 4) {
  GRID.push(TRAIL_CELL, ...NO_AGING);
} else if (STAGE === 1) {
  for (const [slots, pct] of [[4, 0.15], [3, 0.20], [2, 0.30], [2, 0.40]]) {
    for (const minSize of [0, 0.5]) {
      for (const bump of [false, true]) GRID.push({ exits: 'new', slots, pct, minSize, bump });
    }
  }
} else if (STAGE === 3) {
  // Stage 3 (2026-10-25): the trailing-stop sweep's two best walk-forward cells
  // (runStopSweep.mjs, data/trail_sweep.log) on the committed sizing and sleeve.
  GRID.push({ exits: 'new', slots: 4, pct: 0.15, minSize: 0, bump: false, trail: 0.10, arm: 0.05, id: 'trail 10% from +5%' });
  GRID.push({ exits: 'new', slots: 4, pct: 0.15, minSize: 0, bump: false, trail: 0.07, arm: 0.05, tpOff: true, id: 'TP off, trail 7% from +5%' });
} else {
  for (const [slots, pct] of [[4, 0.15], [3, 0.20], [2, 0.30]]) {
    for (const sleeveDeployment of [0.5, 0.25, 0]) {
      GRID.push({ exits: 'new', slots, pct, minSize: 0, bump: false, sleeveDeployment, sleeve: sleeveDeployment > 0 });
    }
  }
}
const isL1 = (c) => c.slots === 4 && c.pct === 0.15 && !c.minSize && !c.bump && (c.sleeveDeployment ?? 0.5) === 0.5 && !c.trail;
const L1_CELL = { exits: 'new', slots: 4, pct: 0.15, minSize: 0, bump: false };
const CELLS = [{ exits: 'old', slots: 4, pct: 0.15, minSize: 0, bump: false, id: 'L0 live as deployed' }, ...[...(STAGE >= 3 || LIVE ? [L1_CELL] : []), ...GRID].map((c) => ({
  ...c,
  id: c.id ?? (isL1(c) ? 'L1 committed'
    : STAGE === 1 ? `${c.slots}×${c.pct * 100}% floor${c.minSize} bump${c.bump ? 'On' : 'Off'}`
      : `${c.slots}×${c.pct * 100}% sleeve ${c.sleeveDeployment * 100}%`),
}))];

/** Applies a cell to the in-memory config (this process only). */
function applyCell(cell) {
  if (cell.exits === 'old') {
    for (const ps of Object.values(config.perSymbol ?? {})) {
      if (ps.stopLossPct != null) ps.stopLossPct /= 1.5;
      if (ps.takeProfitPct != null) ps.takeProfitPct /= 1.5;
    }
    config.risk.stopLossPct /= 1.5;
    config.risk.takeProfitPct /= 1.5;
    config.risk.breakEvenTriggerPct = 0.05;
  }
  config.risk.maxOpenPositions = cell.slots;
  config.risk.maxPositionPct = cell.pct;
  config.risk.minSizeMultiplier = cell.minSize;
  config.risk.minNotionalBump = { ...(config.risk.minNotionalBump ?? {}), enabled: cell.bump };
  config.tsmCore = { ...(config.tsmCore ?? {}), enabled: cell.sleeve !== false }; // live runs TSM_CORE=true
  if (cell.sleeveDeployment != null && Array.isArray(config.tsmCore.equityLadder)) {
    // The first rung (the account's size today): its share of equity in the sleeve.
    config.tsmCore.equityLadder = config.tsmCore.equityLadder.map((r, i) => (i === 0 ? { ...r, deploymentPct: cell.sleeveDeployment } : r));
  }
  if (cell.breakEven != null) config.risk.breakEvenTriggerPct = cell.breakEven;
  if (cell.trail) {
    config.risk.trailingStopPct = cell.trail;
    config.risk.trailArmPct = cell.arm ?? 0;
  }
  if (cell.aging === false) {
    config.risk.positionAgingExit = { ...(config.risk.positionAgingExit ?? {}), enabled: false };
  }
  if (cell.tpOff) {
    // As the sweep's TP scale 100: a target no trade reaches.
    for (const ps of Object.values(config.perSymbol ?? {})) if (ps.takeProfitPct != null) ps.takeProfitPct *= 100;
    config.risk.takeProfitPct *= 100;
  }
}

/** Deposit-adjusted metrics from the per-cycle equity curve. */
function metrics(equity, deposits, fromTs, nTrials, start = START_BALANCE) {
  let prev = start;
  let index = 1;
  let peak = 1;
  let maxDD = 0;
  let k = 0;
  for (const p of equity) {
    if (p.timestamp < fromTs) continue;
    let dep = 0;
    while (k < deposits.length && deposits[k].ts <= p.timestamp) dep += deposits[k++].amount;
    const r = prev > 0 ? (p.balance - dep) / prev - 1 : 0;
    index *= 1 + r;
    peak = Math.max(peak, index);
    maxDD = Math.max(maxDD, 1 - index / peak);
    prev = p.balance;
  }
  const rets = [...dailyReturnsFromEquity(equity, start, deposits, fromTs).values()];
  const sharpe = annualizedSharpe(rets);
  return {
    twr: index - 1, maxDD, sharpe,
    dsr: deflatedSharpeRatio({ observedSharpe: sharpe, returns: rets, nTrials }).dsr,
    finalEquity: equity.at(-1)?.balance ?? start,
    deposited: start + deposits.reduce((s, d) => s + d.amount, 0),
  };
}

async function worker(cell, from, to) {
  applyCell(cell);
  const fromTs = Date.parse(from);
  const toTs = Date.parse(to);
  const deposits = [];
  let start = START_BALANCE;
  let fg;
  let nasdaq;
  let equityHistory = [];
  if (LIVE) {
    // Live's own money and feeds: equity at the start, real deposits, its files.
    const history = readSnapshot('data/equity_history.json');
    equityHistory = (Array.isArray(history) ? history : []).filter((p) => pointTs(p) < fromTs);
    start = Number(equityHistory.at(-1)?.equity);
    for (const d of readSnapshot('data/deposits.json')) {
      const ts = Date.parse(d.timestamp);
      if (ts >= fromTs && ts <= toTs) deposits.push({ ts, amount: Number(d.amount) });
    }
    fg = readSnapshot('data/fearGreed.json').data;
    nasdaq = readSnapshot('data/nasdaqTrend.json').rows;
  } else {
    for (let t = fromTs + DCA_EVERY_MS; t <= toTs; t += DCA_EVERY_MS) deposits.push({ ts: t, amount: DCA_USD });
    fg = JSON.parse(fs.readFileSync('data/fearGreed_full.json', 'utf8')).data;
    nasdaq = JSON.parse(fs.readFileSync('data/nasdaqTrend.json', 'utf8')).rows;
  }
  const c12 = await bf.loadAllSymbols(config.symbols, '12h');
  const r = await replayEngine({
    symbolCandles: c12, mtf15mCandles: bf.loadMtfCandles(config.symbols, '15m'), mtf4hCandles: bf.loadMtfCandles(config.symbols, '4h'),
    fearGreedData: fg, fromTs, toTs, initialBalance: start, deposits, slippage: bf.SLIPPAGE_TIERS,
    nasdaqRows: nasdaq, cfg: config, equityHistory, impliedVolRows: readDvolCache(),
  });
  const trades = r.trades;
  // Live's equity history has one point a day: the replay sampled at the same times too.
  const daily = LIVE ? readSnapshot('data/equity_history.json').map(pointTs).filter((t) => t >= fromTs && t <= toTs)
    .map((t) => r.equity.findLast((p) => p.timestamp <= t)).filter(Boolean) : null;
  const out = {
    ...metrics(r.equity, deposits, fromTs, PRIOR_TRIALS + (STAGE === 1 ? 0 : STAGE === 2 ? STAGE1_CELLS : BEFORE_STAGE3) + CELLS.length, start),
    ...(daily && { dailyMaxDD: metrics(daily, deposits, fromTs, 1, start).maxDD }),
    trades: LIVE ? trades.map((t) => ({ symbol: t.symbol, openedAt: t.openedAt, closedAt: t.timestamp, reason: t.reason, pnl: t.pnl })) : undefined,
    scalperTrades: trades.filter((t) => !t.symbol.endsWith('#core')).length,
    sleeveTrades: trades.filter((t) => t.symbol.endsWith('#core')).length,
    floorRejections: r.sim.minNotionalRejections,
    bumps: r.sim.minNotionalBumps ?? 0,
  };
  process.stdout.write(`RESULT ${JSON.stringify(out)}\n`);
}

async function driver() {
  const jobs = Number(arg('--jobs', 8));
  const outFile = arg('--out', 'data/recalibration.json');
  const self = fileURLToPath(import.meta.url);
  const tasks = CELLS.flatMap((cell) => WINDOWS.map((w) => ({ cell, w })));
  const results = [];
  let next = 0;
  const t0 = Date.now();
  const run = () => new Promise((resolve) => {
    const task = tasks[next++];
    if (!task) { resolve(); return; }
    const child = spawn(process.execPath, [self, '--stage', String(STAGE), ...(LIVE ? ['--live', LIVE] : []), '--worker', JSON.stringify(task.cell), '--from', task.w.from, '--to', task.w.to], {
      env: { ...process.env, TSM_CORE: 'true', LOG_LEVEL: 'error', FILE_LOG_LEVEL: 'error' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    child.stdout.on('data', (d) => { buf += d; });
    child.on('close', (code) => {
      const line = buf.split('\n').find((l) => l.startsWith('RESULT '));
      results.push({ id: task.cell.id, window: task.w.id, cell: task.cell, ...(line ? JSON.parse(line.slice(7)) : { error: `exit ${code}` }) });
      process.stdout.write(`  ${results.length}/${tasks.length} ${task.cell.id} ${task.w.id} ${line ? '' : `FAILED (exit ${code})`} [${((Date.now() - t0) / 60000).toFixed(1)} min]\n`);
      resolve(run());
    });
  });
  await Promise.all(Array.from({ length: jobs }, run));
  fs.writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), cells: CELLS, windows: WINDOWS, results }, null, 1));

  const get = (id, w) => results.find((r) => r.id === id && r.window === w);
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  if (LIVE) { printLive(results, pct); return; }
  console.log('\n| Cell | in-sample TWR | Sharpe | DD | holdout TWR | Sharpe | DD | DSR (holdout) | floor rejections | bumps | accept |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  const L0 = (w) => get('L0 live as deployed', w);
  const L1 = (w) => get('L1 committed', w);
  for (const cell of CELLS) {
    const a = get(cell.id, 'in-sample');
    const b = get(cell.id, 'holdout');
    if (!a || !b || a.error || b.error) { console.log(`| ${cell.id} | error | | | | | | | | | |`); continue; }
    const beats = (x, w) => [L0(w), L1(w)].every((ref) => ref && x.twr > ref.twr && x.sharpe > ref.sharpe);
    const accept = cell.id.startsWith('L') ? '(benchmark)'
      : beats(a, 'in-sample') && beats(b, 'holdout') && a.maxDD <= 0.10 && b.maxDD <= 0.10
        // Stage 1 also asked DSR ≥ 0.5 here; from stage 2 the walk-forward DSR is the statistical check.
        && (STAGE > 1 || b.dsr >= 0.5) ? 'yes' : 'no';
    console.log(`| ${cell.id} | ${pct(a.twr)} | ${a.sharpe.toFixed(2)} | ${pct(a.maxDD)} | ${pct(b.twr)} | ${b.sharpe.toFixed(2)} | ${pct(b.maxDD)} | `
      + `${b.dsr.toFixed(2)} | ${a.floorRejections + b.floorRejections} | ${a.bumps + b.bumps} | ${accept} |`);
  }
  console.log(`\n  written: ${outFile}`);
}

/** The replays next to live's real equity, by the same metrics. */
function printLive(results, pct) {
  const w = WINDOWS[0];
  const fromTs = Date.parse(w.from);
  const toTs = Date.parse(w.to);
  const history = readSnapshot('data/equity_history.json');
  const start = Number(history.filter((p) => pointTs(p) < fromTs).at(-1)?.equity);
  const deposits = readSnapshot('data/deposits.json').map((d) => ({ ts: Date.parse(d.timestamp), amount: Number(d.amount) }))
    .filter((d) => d.ts >= fromTs && d.ts <= toTs);
  const points = history.filter((p) => pointTs(p) >= fromTs && pointTs(p) <= toTs).map((p) => ({ timestamp: pointTs(p), balance: Number(p.equity) }));
  const live = metrics(points, deposits, fromTs, 1, start);
  const csv = fs.readFileSync(`${LIVE}/logs/trades.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
    .filter(([ts]) => Date.parse(ts) >= fromTs && Date.parse(ts) <= toTs);
  const sells = (core) => csv.filter(([, s, side]) => side === 'SELL' && s.endsWith('#core') === core).length;
  const money = (x) => `$${x.toFixed(2)}`;
  console.log(`\nLive window ${w.from} → ${w.to}: start ${money(start)}, deposits ${deposits.map((d) => money(d.amount)).join(' + ') || 'none'}`);
  console.log('\n| Run | Final equity | Profit | TWR | Sharpe | Max DD (daily points) | Max DD (every cycle) | Scalper trades | Sleeve trades |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  console.log(`| **live (real)** | ${money(live.finalEquity)} | ${money(live.finalEquity - live.deposited)} | ${pct(live.twr)} | ${live.sharpe.toFixed(2)} | ${pct(live.maxDD)} | — | ${sells(false)} closed | ${sells(true)} sells |`);
  for (const r of results) {
    if (r.error) { console.log(`| ${r.id} | error | | | | | | | |`); continue; }
    console.log(`| ${r.id} | ${money(r.finalEquity)} | ${money(r.finalEquity - r.deposited)} | ${pct(r.twr)} | ${r.sharpe.toFixed(2)} | ${pct(r.dailyMaxDD)} | ${pct(r.maxDD)} | ${r.scalperTrades} | ${r.sleeveTrades} |`);
  }
  for (const r of results) {
    console.log(`\n  ${r.id}:`);
    for (const t of (r.trades ?? []).filter((x) => !x.symbol.endsWith('#core'))) {
      console.log(`    ${String(t.openedAt).slice(0, 16)} → ${String(t.closedAt).slice(0, 16)} ${t.symbol.padEnd(11)} ${String(t.reason).padEnd(14)} ${Number(t.pnl).toFixed(2)}`);
    }
  }
}

if (argv.includes('--worker')) await worker(JSON.parse(arg('--worker')), arg('--from'), arg('--to'));
else await driver();

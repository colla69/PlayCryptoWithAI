/**
 * Stop / target / break-even sweep on the live-timing engine (2026-10 rebuild).
 *
 * The per-symbol stop-loss and take-profit values and the +5% break-even were chosen
 * while the backtester checked stops only at the 12h close. Since the intrabar
 * replay (follow-ups item 4) the measured edge fell from Sharpe 1.03 to 0.69, almost
 * all of it in the exits. This re-measures them on the engine that now reproduces
 * live's trades.
 *
 * Pre-registered grid (declared before the first run, every cell reported, the
 * deflated Sharpe charged for all cells on top of the existing search burden):
 *   stop-loss scale    × {0.75, 1, 1.5}   (multiplies every per-symbol stopLossPct)
 *   take-profit scale  × {0.75, 1, 1.5}   (multiplies every per-symbol takeProfitPct)
 *   break-even trigger ∈ {off, 0.05, 0.10}
 * The reference is the committed config (scales 1, its break-even, no trailing).
 * Forward-only walk-forward at live sizing.
 * Acceptance (project rules): ≥ 8 trades, DSR ≥ 0.5, max DD no more than 2pp worse
 * than the reference, Sharpe above it. Nothing here writes the config.
 *
 * Trailing-stop grid (2026-10-24, pre-registered): --sl 1 --be 0.1 --tp 1,100
 *   --trail 0,0.04,0.07,0.1 --arm 0,0.05,0.1 → 20 cells (TP off = scale 100).
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runStopSweep.mjs [--out data/stop_sweep.json]
 *   … --sl 1.5,2,2.5 --tp 1.5,2,2.5 --be 0 --prior-trials 16307 --current-dd 0.0456
 *   … --sl 1 --tp 1,100 --be 0.1 --trail 0,0.04,0.07,0.1 --arm 0,0.05,0.1 --prior-trials 16343
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, gitMeta } from '../backtester/baselineFramework.js';
import { generateFolds, runFold, aggregateFolds } from '../backtester/walkForward.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const list = (name, fallback) => (arg(name) ? arg(name).split(',').map(Number) : fallback);
// A follow-up grid (e.g. the plateau check past a corner) is pre-registered on the
// command line, and --prior-trials charges every cell already run.
const SL_SCALES = list('--sl', [0.75, 1, 1.5]);
const TP_SCALES = list('--tp', [0.75, 1, 1.5]);
const BE_TRIGGERS = list('--be', [0, 0.05, 0.10]);
// Trailing stop (fraction below the high) and its arm level (gain before it starts).
// A take-profit scale of 100 or more means no take-profit ("TP off").
const TRAILS = list('--trail', [0]);
const ARMS = list('--arm', [0]);
const PRIOR_TRIALS = Number(arg('--prior-trials') ?? 16280); // the search burden every baseline already charges
const TRAIN_BARS = 365;
const FORWARD_BARS = 90;
const BUDGET = 1000;
const CYCLE_MS = 12 * 60 * 60 * 1000;

const outFile = arg('--out') ?? 'data/stop_sweep.json';

// --cells '<json array>' lists cells explicitly instead of the cross product, e.g.
// [{"sl":1,"tp":1,"be":0.1,"aging":false}] (aging false = no 7-day aging exit).
const cells = arg('--cells')
  ? JSON.parse(arg('--cells')).map((c) => ({ sl: 1, tp: 1, be: 0, trail: 0, arm: 0, ...c }))
  : SL_SCALES.flatMap((sl) => TP_SCALES.flatMap((tp) => BE_TRIGGERS.flatMap((be) => TRAILS.flatMap((trail) =>
    ARMS.filter((arm) => trail > 0 || arm === 0).map((arm) => ({ sl, tp, be, trail, arm }))))));
const nTrials = PRIOR_TRIALS + cells.length;
const label = (c) => `SL×${+c.sl.toFixed(3)} ${c.tp >= 100 ? 'TP off' : `TP×${+c.tp.toFixed(3)}`} BE ${c.be ? `${+(c.be * 100).toFixed(1)}%` : 'off'}`
  + (c.trail ? ` trail ${+(c.trail * 100).toFixed(1)}%${c.arm ? ` from +${+(c.arm * 100).toFixed(1)}%` : ''}` : '')
  + (c.aging === false ? ' no 7-day exit' : '');
// The reference is the committed config: scales 1, its break-even, no trailing stop.
const REF_BE = Number(config.risk?.breakEvenTriggerPct ?? 0.05);
const isRef = (c) => c.sl === 1 && c.tp === 1 && c.be === REF_BE && !c.trail && c.aging !== false;

// Live sizing, as runWalkForward.mjs --live-sizing.
config.risk.basePctOverride = config.risk.maxPositionPct;

const symbolCandles = await loadAllSymbols(config.symbols, '12h');
const mtf15mCandles = loadMtfCandles(config.symbols, '15m');
const mtf4hCandles = loadMtfCandles(config.symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
const anchor = symbolCandles[Object.keys(symbolCandles).find((s) => symbolCandles[s].length >= 730)];
const folds = generateFolds({
  firstTs: anchor[0].timestamp, lastTs: anchor.at(-1).timestamp,
  candleIntervalMs: CYCLE_MS, trainBars: TRAIN_BARS, forwardBars: FORWARD_BARS,
});
console.log(`\nStop sweep — ${cells.length} cells × ${folds.length} folds, DSR trials ${nTrials}\n`);

const common = {
  symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData,
  budget: BUDGET, maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
};
const cellArgs = (c) => ({
  riskScale: { stopLoss: c.sl, takeProfit: c.tp },
  filterOverrides: { breakEvenTriggerPct: c.be },
  riskOverrides: {
    trailingStopPct: c.trail, trailArmPct: c.arm,
    ...(c.aging === false && { positionAgingExit: { ...(config.risk?.positionAgingExit ?? {}), enabled: false } }),
  },
});
const perCell = cells.map(() => []);
const t0 = Date.now();
for (const fold of folds) {
  const { rows, skipped } = runFold({ ...common, fold, rowsOnly: true });
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    const result = skipped ? { fold, skipped: true } : runFold({
      ...common, fold, rows,
      ...cellArgs(c),
    });
    perCell[k].push(result);
  }
  // Reusing rows must be an identity: check the reference and one trailing cell
  // against a plain run.
  for (const k of [cells.findIndex(isRef), cells.findIndex((c) => c.trail > 0), cells.findIndex((c) => c.aging === false)]) {
    if (skipped || fold.index >= 2 || k < 0) continue;
    const plain = runFold({ ...common, fold, ...cellArgs(cells[k]) });
    const same = JSON.stringify(plain.forward_trades) === JSON.stringify(perCell[k].at(-1).forward_trades);
    if (!same) throw new Error(`fold ${fold.index}: reused rows differ from a plain run — sweep invalid`);
  }
  process.stdout.write(`  fold ${fold.index + 1}/${folds.length}  ${((Date.now() - t0) / 60000).toFixed(1)} min\n`);
}

const results = cells.map((c, k) => {
  const a = aggregateFolds(perCell[k], { budget: BUDGET, nTrialsForDSR: nTrials });
  return {
    ...c, label: label(c), total_return: a.total_return, sharpe: a.sharpe, max_drawdown: a.max_drawdown,
    win_rate: a.win_rate, profit_factor: a.profit_factor, total_trades: a.total_trades,
    dsr: a.deflated_sharpe?.dsr ?? a.deflated_sharpe ?? null,
  };
});
// The acceptance DD limit is relative to the current config's walk-forward DD.
const current = results.find(isRef);
const currentDD = Number(arg('--current-dd') ?? current?.max_drawdown);
for (const r of results) {
  r.accepted = r.total_trades >= 8 && Number(r.dsr) >= 0.5 && r.max_drawdown <= currentDD + 0.02
    && (r === current || r.sharpe > current.sharpe);
}

console.log('\n| Cell | Return | Sharpe | Max DD | WR | PF | Trades | DSR | Accept |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const r of [...results].sort((a, b) => b.sharpe - a.sharpe)) {
  console.log(`| ${r.label}${r === current ? ' (current)' : ''} | ${(r.total_return * 100).toFixed(2)}% | ${r.sharpe.toFixed(2)} | `
    + `${(-r.max_drawdown * 100).toFixed(2)}% | ${(r.win_rate * 100).toFixed(0)}% | ${Number(r.profit_factor).toFixed(2)} | `
    + `${r.total_trades} | ${Number(r.dsr).toFixed(2)} | ${r.accepted ? 'yes' : 'no'} |`);
}
writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), git: gitMeta(), n_trials: nTrials, folds: folds.length, results }, null, 1));
console.log(`\n  written: ${outFile}`);

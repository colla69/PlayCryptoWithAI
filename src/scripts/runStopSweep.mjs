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
 * The current config is cell (1, 1, 0.05). Forward-only walk-forward at live sizing.
 * Acceptance (project rules): ≥ 8 trades, DSR ≥ 0.5, max DD no more than 2pp worse
 * than the current cell. Nothing here writes the config.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runStopSweep.mjs [--out data/stop_sweep.json]
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, gitMeta } from '../backtester/baselineFramework.js';
import { generateFolds, runFold, aggregateFolds } from '../backtester/walkForward.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const SL_SCALES = [0.75, 1, 1.5];
const TP_SCALES = [0.75, 1, 1.5];
const BE_TRIGGERS = [0, 0.05, 0.10];
const PRIOR_TRIALS = 16280; // the search burden every baseline already charges
const TRAIN_BARS = 365;
const FORWARD_BARS = 90;
const BUDGET = 1000;
const CYCLE_MS = 12 * 60 * 60 * 1000;

const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'data/stop_sweep.json';

const cells = SL_SCALES.flatMap((sl) => TP_SCALES.flatMap((tp) => BE_TRIGGERS.map((be) => ({ sl, tp, be }))));
const nTrials = PRIOR_TRIALS + cells.length;
const label = (c) => `SL×${c.sl} TP×${c.tp} BE ${c.be ? `${c.be * 100}%` : 'off'}`;

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
const perCell = cells.map(() => []);
const t0 = Date.now();
for (const fold of folds) {
  const { rows, skipped } = runFold({ ...common, fold, rowsOnly: true });
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    const result = skipped ? { fold, skipped: true } : runFold({
      ...common, fold, rows,
      riskScale: { stopLoss: c.sl, takeProfit: c.tp },
      filterOverrides: { breakEvenTriggerPct: c.be },
    });
    perCell[k].push(result);
  }
  // Reusing rows must be an identity: check the current cell against a plain run.
  if (!skipped && fold.index < 2) {
    const ref = cells.findIndex((c) => c.sl === 1 && c.tp === 1 && c.be === 0.05);
    const plain = runFold({ ...common, fold, filterOverrides: { breakEvenTriggerPct: 0.05 } });
    const same = JSON.stringify(plain.forward_trades) === JSON.stringify(perCell[ref].at(-1).forward_trades);
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
const current = results.find((r) => r.sl === 1 && r.tp === 1 && r.be === 0.05);
for (const r of results) {
  r.accepted = r.total_trades >= 8 && Number(r.dsr) >= 0.5 && r.max_drawdown <= current.max_drawdown + 0.02;
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

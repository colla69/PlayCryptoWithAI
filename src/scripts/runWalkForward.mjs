#!/usr/bin/env node
/**
 * Walk-Forward backtest runner (Phase 8).
 *
 * Produces an honest equity curve assembled from non-overlapping forward
 * windows. Each fold runs the full live filter stack against data sliced
 * to [foldStart, forwardEnd]; only the FORWARD portion's trades and
 * equity points contribute to the global stitched curve.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runWalkForward.mjs
 *   PAPER_MODE=true node src/scripts/runWalkForward.mjs --train 365 --forward 90
 *   PAPER_MODE=true node src/scripts/runWalkForward.mjs --mc 1000
 *
 * Outputs:
 *   data/walkForward.json   — full structured results
 *   data/walkForward.txt    — human summary
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import {
  loadAllSymbols,
  loadMtfCandles,
  gitMeta,
} from '../backtester/baselineFramework.js';
import {
  generateFolds,
  runFold,
  aggregateFolds,
  monteCarloShuffle,
} from '../backtester/walkForward.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';

const argv = process.argv.slice(2);
let trainBars = 365;
let forwardBars = 90;
let budget = 1000;
let monteCarloIter = 1000;
let nTrials = 16280;
let symbolsOverride = null;
let outFile = 'data/walkForward.json';
let globalParams = false;
let mtfScoreOverride = NaN;
let mtfOff = false;
let momMin = NaN;
let momRank = false;
let rideTrail = 0;
let ridePartialPct = 0;
let ridePartialFrac = 0.5;
let trailArm = 0;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--train'   && argv[i+1]) { trainBars = Number(argv[++i]); continue; }
  if (a === '--forward' && argv[i+1]) { forwardBars = Number(argv[++i]); continue; }
  if (a === '--budget'  && argv[i+1]) { budget = Number(argv[++i]); continue; }
  if (a === '--mc'      && argv[i+1]) { monteCarloIter = Number(argv[++i]); continue; }
  if (a === '--nTrials' && argv[i+1]) { nTrials = Number(argv[++i]); continue; }
  if (a === '--symbols' && argv[i+1]) { symbolsOverride = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--out'     && argv[i+1]) { outFile = argv[++i]; continue; }
  if (a === '--global-params')        { globalParams = true; continue; }
  if (a === '--mtf-score' && argv[i+1]) { mtfScoreOverride = Number(argv[++i]); continue; }
  if (a === '--mtf-off')                { mtfOff = true; continue; }
  if (a === '--mom-min' && argv[i+1])   { momMin = Number(argv[++i]); continue; }
  if (a === '--mom-rank')               { momRank = true; continue; }
  if (a === '--ride-trail'   && argv[i+1]) { rideTrail = Number(argv[++i]); continue; }
  if (a === '--ride-partial' && argv[i+1]) { const [p, f] = argv[++i].split(','); ridePartialPct = Number(p); if (f != null) ridePartialFrac = Number(f); continue; }
  if (a === '--trail-arm'    && argv[i+1]) { trailArm = Number(argv[++i]); continue; }
}

// De-overfit check (Workstream 2b): strip the per-symbol curve-fit → global defaults.
if (globalParams) config.perSymbol = {};

// WS3(a): relax the 15m MTF throttle for this run (forward-only re-validation of the sweep).
const filterOverrides = {};
if (mtfOff) filterOverrides.mtfFilter = false;
else if (Number.isFinite(mtfScoreOverride)) filterOverrides.mtfMinScore = mtfScoreOverride;
// WS: momentum-leader selection (forward-only validation).
if (Number.isFinite(momMin)) filterOverrides.momentumMinPct = momMin;
if (momRank) filterOverrides.momentumRank = true;

// WS4: ride-winners exit (forward-only validation). --ride-trail >0 enables it.
const rideOpts = rideTrail > 0
  ? { rideWinnersTrail: rideTrail, trailArmPct: trailArm, ridePartial: ridePartialPct > 0 ? { pct: ridePartialPct, fraction: ridePartialFrac } : null }
  : {};

const symbols = symbolsOverride ?? config.symbols;
const candleIntervalMs = 12 * 60 * 60 * 1000; // hardcoded 12h
if (!existsSync('data')) mkdirSync('data');

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log('║   WALK-FORWARD BACKTEST  —  honest forward-only evaluation     ║');
console.log('╚════════════════════════════════════════════════════════════════╝\n');
console.log(`  Train: ${trainBars} bars (${(trainBars * 12 / 24).toFixed(0)}d)   Forward: ${forwardBars} bars (${(forwardBars * 12 / 24).toFixed(0)}d)`);
console.log(`  Budget: $${budget}   Monte Carlo: ${monteCarloIter} iter\n`);

console.log(`Loading 12h candles for ${symbols.length} symbols…`);
const symbolCandles = await loadAllSymbols(symbols, '12h');
console.log(`  ${Object.keys(symbolCandles).length} symbols ready\n`);

console.log('Loading 15m candles…');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
console.log(`  ${Object.keys(mtf15mCandles).length} symbols\n`);

console.log('Loading 4h candles…');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
console.log(`  ${Object.keys(mtf4hCandles).length} symbols\n`);

console.log('Loading Fear & Greed history…');
const fearGreedData = await loadFearGreedHistory();
console.log(`  ${fearGreedData?.length ?? 0} samples\n`);

console.log('Refreshing market context cache…');
await refreshMarketContext();
console.log('  done\n');

// Anchor folds to the longest-history symbol so we get the most folds
const anchorSymbol = Object.keys(symbolCandles).find((s) => symbolCandles[s].length >= 730) ?? Object.keys(symbolCandles)[0];
const anchor = symbolCandles[anchorSymbol];
const firstTs = anchor[0].timestamp;
const lastTs = anchor.at(-1).timestamp;
const totalDays = ((lastTs - firstTs) / (1000 * 60 * 60 * 24)).toFixed(0);
console.log(`Anchor: ${anchorSymbol}  span: ${totalDays}d  (${new Date(firstTs).toISOString().slice(0,10)} → ${new Date(lastTs).toISOString().slice(0,10)})\n`);

const folds = generateFolds({ firstTs, lastTs, candleIntervalMs, trainBars, forwardBars });
if (folds.length === 0) {
  console.error(`No folds generated — need at least ${trainBars + forwardBars} bars of contiguous data.`);
  process.exit(1);
}
console.log(`Generated ${folds.length} fold(s)\n`);

console.log('Running folds…');
const foldResults = [];
for (const fold of folds) {
  const fwdLabel = `${new Date(fold.forwardStart).toISOString().slice(0, 10)} → ${new Date(fold.forwardEnd).toISOString().slice(0, 10)}`;
  process.stdout.write(`  Fold ${fold.index + 1}/${folds.length}  forward ${fwdLabel}  `);
  const t0 = Date.now();
  const result = runFold({
    fold,
    symbolCandles,
    mtf15mCandles,
    mtf4hCandles,
    fearGreedData,
    budget,
    maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
    filterOverrides,
    ...rideOpts,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (result.skipped) {
    console.log(`SKIP (${result.reason})  [${elapsed}s]`);
  } else {
    const ret = (result.fold_return * 100).toFixed(2);
    const trades = result.forward_trades.length;
    console.log(`return ${(result.fold_return >= 0 ? '+' : '')}${ret}%   ${trades}t   [${elapsed}s]`);
  }
  foldResults.push(result);
}

const agg = aggregateFolds(foldResults, { budget, nTrialsForDSR: nTrials });

let mc = null;
if (monteCarloIter > 0) {
  const allTrades = foldResults.flatMap((f) => f.forward_trades ?? []);
  console.log(`\nMonte Carlo trade-order shuffle (${monteCarloIter} iter, ${allTrades.length} trades)…`);
  mc = monteCarloShuffle({ trades: allTrades, initialBalance: budget, iterations: monteCarloIter });
}

// ── Output ────────────────────────────────────────────────────────────────────
const output = {
  generated_at: new Date().toISOString(),
  git: gitMeta(),
  config: {
    train_bars: trainBars,
    forward_bars: forwardBars,
    budget,
    n_trials_for_dsr: nTrials,
    monte_carlo_iterations: monteCarloIter,
    anchor_symbol: anchorSymbol,
    first_ts: firstTs,
    last_ts: lastTs,
  },
  folds: foldResults.map((f) => ({
    index: f.fold?.index,
    forward_start: f.fold?.forwardStart,
    forward_end:   f.fold?.forwardEnd,
    skipped:       f.skipped ?? false,
    reason:        f.reason,
    fold_return:   f.fold_return ?? null,
    trades:        f.forward_trades?.length ?? 0,
    partial:       Boolean(f.fold?.partial),
  })),
  aggregate: agg,
  monte_carlo: mc,
};
writeFileSync(outFile, JSON.stringify(output, null, 2));

const txtPath = outFile.replace('.json', '.txt');
const lines = [];
lines.push(`# Walk-Forward Backtest`);
lines.push(`Generated: ${output.generated_at}`);
lines.push(`Git: ${output.git.branch} @ ${output.git.sha}${output.git.dirty ? ' (dirty)' : ''}`);
lines.push(`Config: train=${trainBars}b forward=${forwardBars}b budget=$${budget} N=${nTrials} MC=${monteCarloIter}`);
lines.push(`Anchor: ${anchorSymbol}  span: ${totalDays}d`);
lines.push('');
lines.push('## Per-fold returns');
lines.push('| Fold | Forward window         | Return  | Trades |');
lines.push('|------|------------------------|---------|--------|');
for (const f of foldResults) {
  if (f.skipped) {
    lines.push(`| ${String((f.fold?.index ?? 0) + 1).padStart(4)} | (skipped: ${f.reason}) |  -      |   -    |`);
    continue;
  }
  const fwd = `${new Date(f.fold.forwardStart).toISOString().slice(0,10)} → ${new Date(f.fold.forwardEnd).toISOString().slice(0,10)}`;
  const ret = `${f.fold_return >= 0 ? '+' : ''}${(f.fold_return * 100).toFixed(2)}%`;
  lines.push(`| ${String(f.fold.index + 1).padStart(4)} | ${fwd.padEnd(22)} | ${ret.padStart(7)} | ${String(f.forward_trades.length).padStart(6)} |`);
}
lines.push('');
lines.push('## Aggregate (stitched forward-only equity curve)');
lines.push(`Total return:    ${agg.total_return_pct}`);
lines.push(`Sharpe:          ${agg.sharpe.toFixed(2)}`);
lines.push(`Max drawdown:    ${agg.max_drawdown_pct}`);
lines.push(`Win rate:        ${(agg.win_rate * 100).toFixed(1)}%`);
lines.push(`Profit factor:   ${agg.profit_factor ?? '∞'}`);
lines.push(`Total trades:    ${agg.total_trades}`);
lines.push(`Folds evaluated: ${agg.folds_evaluated}`);
lines.push(`Deflated Sharpe: ${agg.deflated_sharpe?.dsr.toFixed(2) ?? 'n/a'}   PSR: ${agg.deflated_sharpe?.psr.toFixed(2) ?? 'n/a'}`);
if (mc) {
  lines.push('');
  lines.push(`## Monte Carlo trade-shuffle (${mc.iterations} iter)`);
  lines.push('Compares observed metrics vs metrics from shuffled trade orderings.');
  lines.push('Wide P5-P95 bands on DD = result is fragile to trade ordering (luck).');
  lines.push('');
  lines.push('| Metric        | Observed |  P5     |  P50    |  P95    |');
  lines.push('|---------------|----------|---------|---------|---------|');
  const fp = (v) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`;
  lines.push(`| total_return  | ${fp(mc.observed.total_return).padStart(8)} | ${fp(mc.shuffled.total_return.p5).padStart(7)} | ${fp(mc.shuffled.total_return.p50).padStart(7)} | ${fp(mc.shuffled.total_return.p95).padStart(7)} |`);
  lines.push(`| max_drawdown  | ${('-'+(mc.observed.max_drawdown*100).toFixed(2)+'%').padStart(8)} | ${('-'+(mc.shuffled.max_drawdown.p5*100).toFixed(2)+'%').padStart(7)} | ${('-'+(mc.shuffled.max_drawdown.p50*100).toFixed(2)+'%').padStart(7)} | ${('-'+(mc.shuffled.max_drawdown.p95*100).toFixed(2)+'%').padStart(7)} |`);
  lines.push(`| sharpe        | ${mc.observed.sharpe.toFixed(2).padStart(8)} | ${mc.shuffled.sharpe.p5.toFixed(2).padStart(7)} | ${mc.shuffled.sharpe.p50.toFixed(2).padStart(7)} | ${mc.shuffled.sharpe.p95.toFixed(2).padStart(7)} |`);
}
writeFileSync(txtPath, lines.join('\n'));

console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`  Wrote ${outFile}`);
console.log(`  Wrote ${txtPath}`);
console.log('══════════════════════════════════════════════════════════════════\n');
console.log(lines.join('\n'));

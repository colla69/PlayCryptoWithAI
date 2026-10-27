/**
 * runOverfitting.mjs — does picking the best trial from a set of trials work?
 * Probability of backtest overfitting (CSCV) and CPCV paths for "trade the best past
 * Sharpe" (src/backtester/overfitting.js), plus the deflated Sharpe of the best
 * full-period trial with the set's own trial count and Sharpe dispersion.
 *
 * Usage:
 *   node src/scripts/runOverfitting.mjs --runs a.json,b.json,...   — runSuperbot.mjs outputs, one per trial
 *   node src/scripts/runOverfitting.mjs --matrix m.json            — { labels: [...], rows: [[...], ...] }, rows = days
 *     [--blocks 16] [--groups 10] [--test-groups 2] [--purge 7] [--embargo 7]   (purge/embargo in rows)
 *     [--mark <label>]   — also report that trial's mean out-of-sample rank
 */
import fs from 'fs';
import { pboCscv, cpcvSelection, cpcvNPaths } from '../backtester/overfitting.js';
import { deflatedSharpeRatio, annualToPerObservation } from '../backtester/deflatedSharpe.js';
import { annualizedSharpe, dailyReturnsFromEquity } from '../backtester/metrics.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);

function loadRuns(files) {
  const runs = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const series = runs.map((r) => dailyReturnsFromEquity(r.equity, r.start, r.deposits, Date.parse(r.from)));
  const days = [...new Set(series.flatMap((s) => [...s.keys()]))].sort((a, b) => a - b);
  return { labels: runs.map((r) => r.cell), rows: days.map((d) => series.map((s) => s.get(d) ?? 0)) };
}

const { labels, rows } = arg('runs') ? loadRuns(arg('runs').split(','))
  : arg('matrix') ? JSON.parse(fs.readFileSync(arg('matrix'), 'utf8')) : {};
if (!rows) {
  console.error('usage: --runs a.json,b.json,...  or  --matrix m.json   [--blocks 16] [--groups 10] [--test-groups 2] [--purge 7] [--embargo 7] [--mark <label>]');
  process.exit(1);
}
const nBlocks = Number(arg('blocks', 16));
const nGroups = Number(arg('groups', 10));
const nTestGroups = Number(arg('test-groups', 2));
const purge = Number(arg('purge', 7));
const embargo = Number(arg('embargo', 7));
const f2 = (x) => x.toFixed(2);

const full = labels.map((_, j) => annualizedSharpe(rows.map((r) => r[j])));
const best = full.indexOf(Math.max(...full));
const perObs = full.map((s) => annualToPerObservation(s));
const meanPerObs = perObs.reduce((s, v) => s + v, 0) / perObs.length;
const varAcross = perObs.reduce((s, v) => s + (v - meanPerObs) ** 2, 0) / (perObs.length - 1);
const dsr = deflatedSharpeRatio({ observedSharpe: full[best], returns: rows.map((r) => r[best]), nTrials: labels.length, varianceAcrossTrials: varAcross });

console.log(`${labels.length} trials × ${rows.length} days`);
console.log(`Full-period best: ${labels[best]} (Sharpe ${f2(full[best])}); trial Sharpes ${f2(Math.min(...full))} … ${f2(Math.max(...full))}, median ${f2([...full].sort((a, b) => a - b)[full.length >> 1])}`);
console.log(`  deflated Sharpe of the best: ${dsr.dsr} (expected best by luck ${f2(dsr.sr0 * Math.sqrt(365))} annualized)`);

const p = pboCscv(rows, { nBlocks });
const logits = [...p.logits].sort((a, b) => a - b);
console.log(`\nPBO (CSCV, ${nBlocks} blocks, ${p.nCombos} halvings): ${f2(p.pbo)}`);
console.log(`  in-sample winner loses money out of sample: ${f2(p.probLoss)} of halvings`);
console.log(`  out-of-sample Sharpe ≈ ${f2(p.intercept)} + ${f2(p.slope)} × in-sample Sharpe (winner only)`);
console.log(`  logit quartiles ${[0.25, 0.5, 0.75].map((q) => f2(logits[Math.floor(q * (logits.length - 1))])).join(' / ')}`);
const top = p.picks.map((n, j) => [n, j]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]).slice(0, 5);
console.log(`  most-picked in-sample winners: ${top.map(([n, j]) => `${labels[j]} ${(100 * n / p.nCombos).toFixed(0)}% (oos rank ${f2(p.meanOosRank[j])})`).join(' · ')}`);
if (arg('mark')) {
  const j = labels.indexOf(arg('mark'));
  if (j < 0) throw new Error(`--mark ${arg('mark')}: no such trial`);
  const pct = p.meanOosRank.filter((v) => v < p.meanOosRank[j]).length / labels.length;
  console.log(`  ${labels[j]}: mean out-of-sample rank ${f2(p.meanOosRank[j])} (0.5 = median), above ${(100 * pct).toFixed(0)}% of trials; in-sample winner in ${(100 * p.picks[j] / p.nCombos).toFixed(1)}% of halvings`);
}

const c = cpcvSelection(rows, { nGroups, nTestGroups, purge, embargo });
const ps = c.paths.map((x) => x.sharpe).sort((a, b) => a - b);
console.log(`\nCPCV, best training Sharpe traded (${nGroups} groups, ${nTestGroups} test, purge ${purge}, embargo ${embargo}: ${c.nSplits} splits, ${cpcvNPaths(nGroups, nTestGroups)} paths)`);
console.log(`  path Sharpes ${ps.map(f2).join(' ')} — mean ${f2(ps.reduce((s, v) => s + v, 0) / ps.length)}`);
console.log(`  vs the median trial ${f2([...full].sort((a, b) => a - b)[full.length >> 1])} and the full-period best ${f2(full[best])}`);

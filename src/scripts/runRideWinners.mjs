#!/usr/bin/env node
/**
 * WS4 spearhead — "ride winners" exit test.
 *
 * Thesis: the entries find real momentum, but the fixed +12–30% take-profit sells
 * 10x runners at +15%. This disables the fixed TP and trails the stop instead, so a
 * winner runs until the trend breaks. Sweeps trailing width vs the fixed-TP baseline
 * on the 2yr + 6yr windows. Per-symbol ENTRIES and initial SL are unchanged — only
 * the exit changes.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runRideWinners.mjs
 *         PAPER_MODE=true node src/scripts/runRideWinners.mjs --mtf 0.30   # combine with relaxed MTF
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, defineWindows, runWindow, gitMeta } from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';

const argv = process.argv.slice(2);
let symbolsOverride = null;
let windowIds = ['y1y2_full', 'full_history'];
let mtfScore = NaN; // optionally combine with a relaxed MTF score
let outFile = 'data/ride_winners.json';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--symbols' && argv[i + 1]) { symbolsOverride = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--windows' && argv[i + 1]) { windowIds = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--mtf'     && argv[i + 1]) { mtfScore = Number(argv[++i]); continue; }
  if (a === '--out'     && argv[i + 1]) { outFile = argv[++i]; continue; }
}
const symbols = symbolsOverride ?? config.symbols;
if (!existsSync('data')) mkdirSync('data');
const filterOverrides = Number.isFinite(mtfScore) ? { mtfMinScore: mtfScore } : {};

// trail 0 = fixed-TP baseline; >0 = ride winners with that trailing width.
// ridePartial = lock `fraction` at +`pct`; arm = delay trailing until +arm (smarter trailing, WS#2).
const variants = [
  { id: 'fixed-TP (baseline)',      trail: 0,    partial: null,                         arm: 0 },
  { id: 'ride25% +2/3@+30% (best)', trail: 0.25, partial: { pct: 0.30, fraction: 0.667 }, arm: 0 },
  { id: 'ride25% arm@+15%',         trail: 0.25, partial: null,                         arm: 0.15 },
  { id: 'ride25% arm@+15% +2/3@30%',trail: 0.25, partial: { pct: 0.30, fraction: 0.667 }, arm: 0.15 },
  { id: 'ride35% arm@+20% +half@40%',trail: 0.35, partial: { pct: 0.40, fraction: 0.5 }, arm: 0.20 },
];

console.log(`\n══ Ride-winners exit test ══  ${Number.isFinite(mtfScore) ? `(combined with MTF ${mtfScore})` : '(baseline MTF 0.50)'}\n`);
const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();
console.log(`Loaded ${Object.keys(symbolCandles).length} symbols + filters\n`);

const windows = defineWindows(symbolCandles).filter((w) => windowIds.includes(w.id));
const report = { generated_at: new Date().toISOString(), git: gitMeta(), symbols: symbols.length, mtf: mtfScore, windows: {} };
const lines = [`# Ride-winners (${report.git.branch} @ ${report.git.sha})  symbols=${symbols.length}  mtf=${Number.isFinite(mtfScore) ? mtfScore : '0.50'}`];

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'variant'.padEnd(22)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'WR'.padStart(4)} ${'avgWin'.padStart(8)} ${'DSR'.padStart(5)}`);
  for (const v of variants) {
    process.stdout.write(`  ${window.id} / ${v.id}… `);
    const t0 = Date.now();
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, filterOverrides, rideWinnersTrail: v.trail, ridePartial: v.partial, trailArmPct: v.arm });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const m = r.metrics;
    report.windows[window.id].push({ variant: v.id, trail: v.trail, trades: m.total_trades, return_pct: m.total_return_pct, sharpe: m.sharpe, max_drawdown_pct: m.max_drawdown_pct, win_rate: m.win_rate, avg_win: m.avg_win, dsr: r.deflated_sharpe?.dsr ?? null });
    lines.push(`  ${v.id.padEnd(22)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(m.win_rate * 100).toFixed(0).padStart(3)}% ${('$' + (m.avg_win ?? 0).toFixed(0)).padStart(8)} ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}`);
  }
}

writeFileSync(outFile, JSON.stringify(report, null, 2));
const summary = lines.join('\n');
writeFileSync(outFile.replace('.json', '_summary.txt'), summary);
console.log(`\nWrote ${outFile}\n`);
console.log(summary);
console.log('\n(Looking for: ride variants with much higher return + bigger avgWin than fixed-TP, ideally without a Sharpe collapse. Higher maxDD is expected — that is the cost of letting winners run.)');

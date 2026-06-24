#!/usr/bin/env node
/**
 * Deployment / position-size sweep.
 *
 * The backtester sizes each position at 1/maxOpenPositions (=0.25 for 4 slots →
 * up to 100% deployment), but the LIVE bot uses maxPositionPct=0.15 (60% max).
 * This sweeps the per-position base size to (a) show the honest live-deployment
 * number, and (b) test whether deploying more capital compounds materially better
 * — the lever behind "the account grows / capture more of the 6yr upside".
 *
 * Runs on the committed config (relaxed MTF 0.30). Read-only; writes a report.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runDeploySweep.mjs
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, defineWindows, runWindow, gitMeta } from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';

const argv = process.argv.slice(2);
let windowIds = ['y1y2_full', 'full_history'];
let outFile = 'data/deploy_sweep.json';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--windows' && argv[i + 1]) { windowIds = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--out'     && argv[i + 1]) { outFile = argv[++i]; continue; }
}
if (!existsSync('data')) mkdirSync('data');
const symbols = config.symbols;

// per-position base size. 0.15 = live (60% max deploy); 0.25 = current backtest 1/N (100%).
const variants = [
  { id: '0.15 (live: 60% max)',  basePct: 0.15 },
  { id: '0.20 (80% max)',         basePct: 0.20 },
  { id: '0.25 (backtest 1/N)',    basePct: 0.25 },
  { id: '0.33 (concentrated ~3)', basePct: 0.33 },
];

console.log('\n══ Deployment / position-size sweep (committed config, MTF 0.30) ══\n');
const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();
console.log(`Loaded ${Object.keys(symbolCandles).length} symbols + filters\n`);

const windows = defineWindows(symbolCandles).filter((w) => windowIds.includes(w.id));
const report = { generated_at: new Date().toISOString(), git: gitMeta(), windows: {} };
const lines = [`# Deployment sweep (${report.git.branch} @ ${report.git.sha})`];

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'per-pos base'.padEnd(24)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'DSR'.padStart(5)}`);
  for (const v of variants) {
    process.stdout.write(`  ${window.id} / ${v.id}… `);
    const t0 = Date.now();
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, basePctOverride: v.basePct });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const m = r.metrics;
    report.windows[window.id].push({ variant: v.id, basePct: v.basePct, trades: m.total_trades, return_pct: m.total_return_pct, sharpe: m.sharpe, max_drawdown_pct: m.max_drawdown_pct, dsr: r.deflated_sharpe?.dsr ?? null });
    lines.push(`  ${v.id.padEnd(24)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}`);
  }
}

writeFileSync(outFile, JSON.stringify(report, null, 2));
const summary = lines.join('\n');
writeFileSync(outFile.replace('.json', '_summary.txt'), summary);
console.log(`\nWrote ${outFile}\n`);
console.log(summary);
console.log('\n(0.15 = honest live-deployment number; higher = more compounding but more DD. Windowed — WF-validate the chosen level before live.)');

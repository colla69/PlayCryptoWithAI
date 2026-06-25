#!/usr/bin/env node
/**
 * WS3(a) — 15m MTF throttle relaxation sweep.
 *
 * The MTF filter is the master throttle (blocks 3–5× more BUYs than it passes).
 * This sweeps `mtfMinScore` (and a fully-off variant) on the 2yr + 6yr windows to
 * see the frequency↔quality tradeoff: does letting more trades through raise the
 * trade count enough for DSR to become interpretable — and does the edge survive?
 *
 * Reuses runWindow (full live filter stack) via the new `filterOverrides` hook,
 * so numbers stay comparable to the baseline. Read-only; writes a report file.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runMtfSweep.mjs
 *         PAPER_MODE=true node src/scripts/runMtfSweep.mjs --symbols BTC/USDC,ETH/USDC
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
let outFile = 'data/mtf_sweep.json';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--symbols' && argv[i + 1]) { symbolsOverride = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--windows' && argv[i + 1]) { windowIds = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--out'     && argv[i + 1]) { outFile = argv[++i]; continue; }
}
const symbols = symbolsOverride ?? config.symbols;
if (!existsSync('data')) mkdirSync('data');

// Variants: baseline (0.50) → progressively looser → fully off.
const variants = [
  { id: 'mtf_0.50 (baseline)', overrides: {} },
  { id: 'mtf_0.40',            overrides: { mtfMinScore: 0.40 } },
  { id: 'mtf_0.30',            overrides: { mtfMinScore: 0.30 } },
  { id: 'mtf_0.20',            overrides: { mtfMinScore: 0.20 } },
  { id: 'mtf_OFF',             overrides: { mtfFilter: false } },
];

console.log('\n══ MTF throttle sweep ══\n');
const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();
console.log(`Loaded ${Object.keys(symbolCandles).length} symbols + filters\n`);

const windows = defineWindows(symbolCandles).filter((w) => windowIds.includes(w.id));
const report = { generated_at: new Date().toISOString(), git: gitMeta(), symbols: symbols.length, windows: {} };
const lines = [`# MTF sweep (${report.git.branch} @ ${report.git.sha})  symbols=${symbols.length}`];

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'variant'.padEnd(20)} ${'trades'.padStart(6)} ${'return'.padStart(9)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'WR'.padStart(4)} ${'DSR'.padStart(5)}`);
  for (const v of variants) {
    process.stdout.write(`  ${window.id} / ${v.id}… `);
    const t0 = Date.now();
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, filterOverrides: v.overrides });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const m = r.metrics;
    const row = {
      variant: v.id, trades: m.total_trades, return_pct: m.total_return_pct,
      sharpe: m.sharpe, max_drawdown_pct: m.max_drawdown_pct, win_rate: m.win_rate,
      dsr: r.deflated_sharpe?.dsr ?? null,
    };
    report.windows[window.id].push(row);
    lines.push(`  ${v.id.padEnd(20)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(9)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(m.win_rate * 100).toFixed(0).padStart(3)}% ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}`);
  }
}

writeFileSync(outFile, JSON.stringify(report, null, 2));
const summary = lines.join('\n');
writeFileSync(outFile.replace('.json', '_summary.txt'), summary);
console.log(`\nWrote ${outFile}\n`);
console.log(summary);
console.log('\n(Reminder: more trades with a lower Sharpe/DSR = washing out, not edge. Revert if risk-adjusted metrics worsen vs baseline.)');

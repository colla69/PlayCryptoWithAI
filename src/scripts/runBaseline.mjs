#!/usr/bin/env node
/**
 * Phase 0 baseline runner.
 *
 * Establishes the honest reference numbers for the current bot strategy
 * against which every subsequent overhaul phase reports a delta.
 *
 * Outputs:
 *   data/baseline.json         — full structured results
 *   data/baseline_summary.txt  — human-readable summary
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runBaseline.mjs
 *   PAPER_MODE=true node src/scripts/runBaseline.mjs --phase p1     # tag output as a phase-1 re-run
 *   PAPER_MODE=true node src/scripts/runBaseline.mjs --include-stress
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { sharpeOf, tradeReturnFraction } from '../monitor/driftMonitor.js';
import config from '../../config/default.js';
import {
  loadAllSymbols,
  loadMtfCandles,
  defineWindows,
  findStressWindows,
  runWindow,
  gitMeta,
} from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';
import { summarizeStress, LEVEL_EMOJI } from '../backtester/stressReport.js';

const argv = process.argv.slice(2);
let phaseTag = 'p0';
let includeStress = false;
let stoplight = false;
let budget = 1000;
let nTrials = 16280; // 37 symbols × 220 combos × 2 conf thresholds (per-symbol optimizer search space)
let symbolsOverride = null;
let outFile = null;
let globalParams = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--phase'           && argv[i+1]) { phaseTag = argv[++i]; continue; }
  if (a === '--include-stress')                { includeStress = true; continue; }
  if (a === '--stoplight')                      { stoplight = true; includeStress = true; continue; }
  if (a === '--budget'          && argv[i+1]) { budget = Number(argv[++i]); continue; }
  if (a === '--nTrials'         && argv[i+1]) { nTrials = Number(argv[++i]); continue; }
  if (a === '--symbols'         && argv[i+1]) { symbolsOverride = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--out'             && argv[i+1]) { outFile = argv[++i]; continue; }
  if (a === '--global-params')                 { globalParams = true; continue; }
}

// De-overfit check (Workstream 2b): strip the per-symbol curve-fit so every symbol
// falls back to the global defaults (strategies RSI/BB/Stoch/SR, SL/TP/conf from config.risk).
if (globalParams) {
  config.perSymbol = {};
  if (phaseTag === 'p0') phaseTag = 'global';
}

const symbols = symbolsOverride ?? config.symbols;
const outPath = outFile ?? (phaseTag === 'p0' ? 'data/baseline.json' : `data/baseline_${phaseTag}.json`);
const summaryPath = outPath.replace('.json', '_summary.txt');

if (!existsSync('data')) mkdirSync('data');

console.log('\n╔════════════════════════════════════════════════════════════════╗');
console.log(`║   PHASE 0 BASELINE  —  honest reference numbers (${phaseTag})              ║`);
console.log('╚════════════════════════════════════════════════════════════════╝\n');

console.log(`Loading 12h candles for ${symbols.length} symbols…`);
const symbolCandles = await loadAllSymbols(symbols, '12h');
console.log(`  ${Object.keys(symbolCandles).length} symbols ready\n`);

console.log('Loading 15m candles (MTF entry filter)…');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
console.log(`  ${Object.keys(mtf15mCandles).length} symbols with 15m data\n`);

console.log('Loading 4h candles (MTF momentum filter)…');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
console.log(`  ${Object.keys(mtf4hCandles).length} symbols with 4h data\n`);

console.log('Loading Fear & Greed history (Phase 3)…');
const fearGreedData = await loadFearGreedHistory();
console.log(`  ${fearGreedData?.length ?? 0} daily samples\n`);

console.log('Refreshing market context cache (Phase 3)…');
await refreshMarketContext();
console.log(`  done\n`);

const windows = defineWindows(symbolCandles);
const stressWindows = includeStress ? findStressWindows(symbolCandles) : [];
const allWindows = [...windows, ...stressWindows];

console.log(`Running ${allWindows.length} windows (${windows.length} standard + ${stressWindows.length} stress)…\n`);

const results = [];
for (const window of allWindows) {
  const days = Math.round((window.endTs - window.startTs) / (1000 * 60 * 60 * 24));
  process.stdout.write(`  ${window.id.padEnd(22)} ${window.label.padEnd(36)} ${String(days).padStart(4)}d  `);
  const t0 = Date.now();
  const r = runWindow({
    window,
    symbolCandles,
    mtf15mCandles,
    mtf4hCandles,
    fearGreedData,
    nTrials,
    budget,
    maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
    includeRaw: true, // per-trade Sharpe below needs the trade list
  });
  // Per-trade Sharpe (mean/std of per-trade returns, UN-annualised) — the basis
  // the live drift monitor compares against (see src/monitor/driftMonitor.js).
  // The daily-equity Sharpe printed above is NOT comparable to it.
  if (!r.skipped && Array.isArray(r.trades)) {
    const rets = r.trades
      .map((t) => tradeReturnFraction(t))
      .filter((x) => Number.isFinite(x));
    r.per_trade_sharpe = Number(sharpeOf(rets).toFixed(4));
    r.per_trade_n = rets.length;
    delete r.trades; // keep the baseline JSON lean (raw only served this stat)
    delete r.symbol_stats;
    delete r.equity_curve;
  }
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.skipped) {
    console.log(`SKIP (${r.reason})  [${elapsed}s]`);
  } else {
    const ret = r.metrics.total_return_pct;
    const sh  = r.metrics.sharpe.toFixed(2);
    const dd  = r.metrics.max_drawdown_pct;
    const wr  = (r.metrics.win_rate * 100).toFixed(0);
    const t   = r.metrics.total_trades;
    const dsr = r.deflated_sharpe.dsr.toFixed(2);
    console.log(`${ret.padStart(8)}  Sh ${sh.padStart(5)}  DD ${dd.padStart(8)}  WR ${wr.padStart(2)}%  ${String(t).padStart(3)}t  DSR ${dsr}  [${elapsed}s]`);
  }
  results.push(r);
}

// ── Persist structured + human-readable output ────────────────────────────────
const output = {
  phase: phaseTag,
  generated_at: new Date().toISOString(),
  git: gitMeta(),
  symbols_configured: symbols.length,
  symbols_loaded: Object.keys(symbolCandles).length,
  mtf_15m_coverage: Object.keys(mtf15mCandles).length,
  mtf_4h_coverage: Object.keys(mtf4hCandles).length,
  search_burden_n_trials: nTrials,
  notes: [
    'nTrials reflects the per-symbol optimizer search space: 37 symbols × 220 combos × 2 conf thresholds',
    'Deflated Sharpe uses Bailey & López de Prado (2014) with V_across = 1/(n-1)',
    'Full live filter stack enabled: mtf15m + mtf4h + regimeSizing + macroFilter + confSizing + BE stop',
  ],
  windows: results,
};
writeFileSync(outPath, JSON.stringify(output, null, 2));

const summary = renderSummary(output);
writeFileSync(summaryPath, summary);
console.log('\n══════════════════════════════════════════════════════════════════');
console.log(`  Wrote ${outPath}`);
console.log(`  Wrote ${summaryPath}`);
console.log('══════════════════════════════════════════════════════════════════\n');
console.log(summary);

// ── Stress stoplight report (Phase 8) ─────────────────────────────────────────
if (stoplight) {
  const report = summarizeStress(results);
  const reportPath = outPath.replace('.json', '_stoplight.json');
  writeFileSync(reportPath, JSON.stringify({
    phase: phaseTag,
    generated_at: new Date().toISOString(),
    git: gitMeta(),
    overall: report.overall,
    counts: report.counts,
    rows: report.rows,
  }, null, 2));

  console.log(`\n┌─ Stress stoplight ${'─'.repeat(46)}`);
  for (const row of report.rows) {
    const emoji = LEVEL_EMOJI[row.level] ?? '⚪';
    const id = String(row.id).padEnd(24);
    console.log(`│ ${emoji} ${id} ${row.reasons.join('; ')}`);
  }
  const { green, yellow, red, na, skipped } = report.counts;
  console.log(`└─ overall ${LEVEL_EMOJI[report.overall]} ${report.overall.toUpperCase()}  `
    + `(🟢${green} 🟡${yellow} 🔴${red} ⚪${na} ⏭️${skipped})`);
  console.log(`  Wrote ${reportPath}\n`);
  if (report.overall === 'red') process.exitCode = 1; // non-zero so CI can gate on it
}

function renderSummary(out) {
  const lines = [];
  lines.push(`# Phase ${out.phase} baseline`);
  lines.push(`Generated: ${out.generated_at}`);
  lines.push(`Git: ${out.git.branch} @ ${out.git.sha}${out.git.dirty ? ' (dirty)' : ''}`);
  lines.push(`Symbols: ${out.symbols_loaded}/${out.symbols_configured} loaded   MTF coverage: 15m=${out.mtf_15m_coverage}, 4h=${out.mtf_4h_coverage}`);
  lines.push(`Search burden: N=${out.search_burden_n_trials} trials`);
  lines.push('');
  lines.push('| Window                 | Days | Sym | Trades |  Return  | Sharpe |  Sortino |   DD    | WR  |   PF   |  DSR  |  PSR  |');
  lines.push('|------------------------|------|-----|--------|----------|--------|----------|---------|-----|--------|-------|-------|');
  for (const r of out.windows) {
    if (r.skipped) {
      lines.push(`| ${r.window.id.padEnd(22)} | ${String(r.window.days ?? '-').padStart(4)} | ${String(r.symbols_used).padStart(3)} | SKIPPED — ${r.reason} |`);
      continue;
    }
    const m = r.metrics;
    const sortino = m.sortino == null ? '   ∞   ' : m.sortino.toFixed(2).padStart(8);
    const pf = m.profit_factor == null ? '  ∞  ' : m.profit_factor.toFixed(2).padStart(6);
    lines.push(`| ${r.window.id.padEnd(22)} | ${String(r.window.days ?? '-').padStart(4)} | ${String(r.symbols_used).padStart(3)} | ${String(m.total_trades).padStart(6)} | ${m.total_return_pct.padStart(8)} | ${m.sharpe.toFixed(2).padStart(6)} | ${sortino} | ${m.max_drawdown_pct.padStart(7)} | ${(m.win_rate*100).toFixed(0).padStart(2)}% | ${pf} | ${r.deflated_sharpe.dsr.toFixed(2).padStart(5)} | ${r.deflated_sharpe.psr.toFixed(2).padStart(5)} |`);
  }
  lines.push('');
  lines.push('Interpretation:');
  lines.push('  DSR ≥ 0.95 — observed Sharpe is significant after correcting for multiple-testing burden');
  lines.push('  DSR < 0.50 — observed Sharpe is statistically indistinguishable from data-dredging noise');
  lines.push('  PSR        — probability the true Sharpe > 0 (ignores multiple-testing)');
  return lines.join('\n');
}

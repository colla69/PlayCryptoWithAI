#!/usr/bin/env node
/**
 * Momentum-leader selection test (the Sharpe lever).
 *
 * Instead of filling limited slots by signal confidence and trading every coin
 * that fires, prefer/require strong relative strength (trailing 20-bar return):
 *   - momentumRank: fill slots with the strongest-momentum candidates
 *   - momentumMinPct: skip BUYs in laggards (mom below threshold)
 * Compares vs the committed config (relaxed MTF) on the 2yr + 6yr windows.
 * Read-only.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runMomentum.mjs
 */
import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, defineWindows, runWindow, gitMeta } from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';

if (!existsSync('data')) mkdirSync('data');
const symbols = config.symbols;
const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();

const variants = [
  { id: 'baseline (conf-rank)',  overrides: {} },
  { id: 'momentum-rank',         overrides: { momentumRank: true } },
  { id: 'mom filter >0%',        overrides: { momentumMinPct: 0.0 } },
  { id: 'mom filter >10%',       overrides: { momentumMinPct: 0.10 } },
  { id: 'mom filter >20%',       overrides: { momentumMinPct: 0.20 } },
  { id: 'rank + filter >10%',    overrides: { momentumRank: true, momentumMinPct: 0.10 } },
];
const windows = defineWindows(symbolCandles).filter((w) => ['y1y2_full', 'full_history'].includes(w.id));
const report = { generated_at: new Date().toISOString(), git: gitMeta(), windows: {} };
const lines = [`# Momentum-leader selection (${gitMeta().branch} @ ${gitMeta().sha})`];

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'variant'.padEnd(20)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'WR'.padStart(4)} ${'DSR'.padStart(5)} ${'filtered'.padStart(9)}`);
  for (const v of variants) {
    process.stdout.write(`  ${window.id} / ${v.id}… `);
    const t0 = Date.now();
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, filterOverrides: v.overrides });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const m = r.metrics;
    report.windows[window.id].push({ variant: v.id, ...m, dsr: r.deflated_sharpe?.dsr, filtered: r.filters_applied?.momentum ?? 0 });
    lines.push(`  ${v.id.padEnd(20)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(m.win_rate * 100).toFixed(0).padStart(3)}% ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)} ${String(r.filters_applied?.momentum ?? 0).padStart(9)}`);
  }
}
writeFileSync('data/momentum_select.json', JSON.stringify(report, null, 2));
const summary = lines.join('\n');
writeFileSync('data/momentum_select_summary.txt', summary);
console.log('\n' + summary);
console.log('\n(Want: a variant with higher Sharpe/DSR than baseline — that is genuine selection edge, not just a risk dial.)');

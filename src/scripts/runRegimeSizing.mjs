#!/usr/bin/env node
/**
 * Regime-conditional sizing (the viable "adapt to momentum" lever).
 *
 * Deployment is a Sharpe-neutral risk dial GLOBALLY — but tilting it by REGIME
 * (more in BULL_TREND where the edge concentrates, less in chop/bear where it
 * bleeds) can lift BLENDED Sharpe. Tests several regime-label size multipliers on
 * the committed config (MTF 0.30) over 2yr + 6yr. Read-only.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runRegimeSizing.mjs
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
  { id: 'baseline (no tilt)',          ov: {} },
  { id: 'BULL_TREND ×1.5',             ov: { regimeSizeMult: { BULL_TREND: 1.5 } } },
  { id: 'tilt TR1.5/RG0.75/bears0.5',  ov: { regimeSizeMult: { BULL_TREND: 1.5, BULL_RANGE: 0.75, BEAR_CHOP: 0.5, BEAR_TREND: 0.25 } } },
  { id: 'aggressive TR2.0/bears0.3',   ov: { regimeSizeMult: { BULL_TREND: 2.0, BULL_RANGE: 1.0, BEAR_CHOP: 0.5, BEAR_TREND: 0.3 } } },
];
const windows = defineWindows(symbolCandles).filter((w) => ['y1y2_full', 'full_history'].includes(w.id));
const report = { generated_at: new Date().toISOString(), git: gitMeta(), windows: {} };
const L = [`# Regime-conditional sizing (${gitMeta().branch} @ ${gitMeta().sha})`];

for (const window of windows) {
  report.windows[window.id] = [];
  L.push(`\n══════ ${window.id} ══════`);
  L.push(`  ${'variant'.padEnd(28)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'DSR'.padStart(5)}`);
  for (const v of variants) {
    process.stdout.write(`  ${window.id} / ${v.id}… `);
    const t0 = Date.now();
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, filterOverrides: v.ov });
    console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const m = r.metrics;
    report.windows[window.id].push({ variant: v.id, ...m, dsr: r.deflated_sharpe?.dsr });
    L.push(`  ${v.id.padEnd(28)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}`);
  }
}
writeFileSync('data/regime_sizing.json', JSON.stringify(report, null, 2));
const summary = L.join('\n');
writeFileSync('data/regime_sizing_summary.txt', summary);
console.log('\n' + summary);
console.log('\n(Want: a tilt with higher Sharpe/DSR than baseline — concentrating risk where the edge lives. Windowed; WF-validate the winner.)');

#!/usr/bin/env node
/**
 * Test the loss-avoidance rule from the autopsy: skip entries in BEAR_TREND
 * (the only net-negative regime bucket). Compares committed config (relaxed MTF)
 * with vs without the skip on the 2yr + 6yr windows. Read-only.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runBearSkip.mjs
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
  { id: 'committed (no skip)', overrides: {} },
  { id: 'skip BEAR_TREND',     overrides: { skipBearTrendEntries: true } },
];
const windows = defineWindows(symbolCandles).filter((w) => ['y1y2_full', 'full_history'].includes(w.id));
const lines = [`# Bear-trend skip test (${gitMeta().branch} @ ${gitMeta().sha})`];
const report = { generated_at: new Date().toISOString(), windows: {} };

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'variant'.padEnd(22)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'WR'.padStart(4)} ${'DSR'.padStart(5)}`);
  for (const v of variants) {
    const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, filterOverrides: v.overrides });
    const m = r.metrics;
    report.windows[window.id].push({ variant: v.id, ...m, dsr: r.deflated_sharpe?.dsr, skipped: r.filters_applied?.bearTrendSkip ?? 0 });
    lines.push(`  ${v.id.padEnd(22)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(m.win_rate * 100).toFixed(0).padStart(3)}% ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}  (skipped ${r.filters_applied?.bearTrendSkip ?? 0})`);
  }
}
writeFileSync('data/bear_skip.json', JSON.stringify(report, null, 2));
console.log(lines.join('\n'));
console.log('\n(Want: skip variant with lower maxDD and equal-or-better Sharpe/return. Frees slots for non-bear trades.)');

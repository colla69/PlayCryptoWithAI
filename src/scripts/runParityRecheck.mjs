/**
 * Re-check the two portfolio gates whose backtest side was broken until 2026-09.
 *
 *   · correlation cap   — the backtester used one static matrix from the first half
 *                         of each symbol's history (future bars for half the run)
 *                         instead of live's trailing correlation.period window
 *   · weekly DD breaker — never fired in a backtest: simulator trades lacked the
 *                         SELL/timestamp shape calcWeeklyDDBreaker reads
 *
 * Both were shipped ON on the strength of A/B runs made with those bugs. This runs
 * the committed config with each gate switched off on the Y2, 2yr and full windows,
 * on the corrected engine, at live deployment (maxPositionPct per slot — the
 * breaker's threshold is a % of equity, so the research default of ~100%
 * deployment would trip it more often than live does). Windowed numbers only: a
 * keep/drop call needs the forward-only runs too —
 *   runWalkForward.mjs --live-sizing [--corr-off | --wdd-off]
 * Read-only; writes data/parity_recheck.json.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runParityRecheck.mjs
 */

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
  { id: 'committed (both ON)', filterOverrides: {}, riskOverrides: {} },
  { id: 'correlation cap OFF', filterOverrides: { correlationFilter: false }, riskOverrides: {} },
  { id: 'weekly DD OFF', filterOverrides: {}, riskOverrides: { weeklyDDBreaker: { enabled: false } } },
];
const windows = defineWindows(symbolCandles).filter((w) => ['y2_365d', 'y1y2_full', 'full_history'].includes(w.id));
const basePctOverride = config.risk.maxPositionPct;
const lines = [`# Correlation cap + weekly DD re-check (${gitMeta().branch} @ ${gitMeta().sha}) — live sizing ${basePctOverride}/slot`];
const report = { generated_at: new Date().toISOString(), windows: {} };

for (const window of windows) {
  report.windows[window.id] = [];
  lines.push(`\n══════ ${window.id} ══════`);
  lines.push(`  ${'variant'.padEnd(22)} ${'trades'.padStart(6)} ${'return'.padStart(10)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(8)} ${'WR'.padStart(4)} ${'DSR'.padStart(5)}  blocks`);
  for (const v of variants) {
    const r = runWindow({
      window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData,
      filterOverrides: v.filterOverrides, riskOverrides: v.riskOverrides, basePctOverride,
    });
    const m = r.metrics;
    const blocks = { correlation: r.filters_applied?.correlation ?? 0, weeklyDD: r.filters_applied?.weeklyDDBreaker ?? 0 };
    report.windows[window.id].push({ variant: v.id, ...m, dsr: r.deflated_sharpe?.dsr, blocks });
    lines.push(`  ${v.id.padEnd(22)} ${String(m.total_trades).padStart(6)} ${m.total_return_pct.padStart(10)} ${m.sharpe.toFixed(2).padStart(7)} ${m.max_drawdown_pct.padStart(8)} ${(m.win_rate * 100).toFixed(0).padStart(3)}% ${(r.deflated_sharpe?.dsr ?? 0).toFixed(2).padStart(5)}  corr ${blocks.correlation} / wDD ${blocks.weeklyDD}`);
  }
}
writeFileSync('data/parity_recheck.json', JSON.stringify(report, null, 2));
console.log(lines.join('\n'));
console.log('\n(Windowed only. A keep/drop call needs runWalkForward --live-sizing [--corr-off | --wdd-off] and DSR.)');

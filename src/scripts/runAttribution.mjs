#!/usr/bin/env node
/**
 * Attribution deep-dive (Workstream 1).
 *
 * Answers: is the bot's P&L broad, or concentrated in a few coins / exit-reasons
 * / regimes? Concentration ⇒ the edge is thinner than the headline trade count.
 *
 * Reuses the SAME backtest path as runBaseline (runWindow with the full live
 * filter stack) via the new `includeRaw` flag, so attribution can never diverge
 * from the baseline numbers. Pure read-only analysis — writes only report files.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runAttribution.mjs
 *   PAPER_MODE=true node src/scripts/runAttribution.mjs --symbols BTC/USDC,ETH/USDC
 *   PAPER_MODE=true node src/scripts/runAttribution.mjs --windows y1y2_full,full_history
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import {
  loadAllSymbols,
  loadMtfCandles,
  defineWindows,
  runWindow,
  gitMeta,
} from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';
import { classifySeries } from '../engine/regimeClassifier.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let symbolsOverride = null;
let windowIds = ['y1y2_full', 'full_history']; // 2yr (in-sample) + 6yr (full OOS)
let outFile = 'data/attribution_deep6y.json';
let budget = 1000;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--symbols' && argv[i + 1]) { symbolsOverride = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--windows' && argv[i + 1]) { windowIds = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (a === '--out'     && argv[i + 1]) { outFile = argv[++i]; continue; }
  if (a === '--budget'  && argv[i + 1]) { budget = Number(argv[++i]); continue; }
}

const symbols = symbolsOverride ?? config.symbols;
const summaryPath = outFile.replace('.json', '_summary.txt');
if (!existsSync('data')) mkdirSync('data');

const pct = (x) => `${x >= 0 ? '+' : ''}${(x).toFixed(1)}%`;
const usd = (x) => `${x >= 0 ? '+' : ''}$${x.toFixed(2)}`;

// ── Load data (identical to runBaseline) ──────────────────────────────────────
console.log('\n══ Attribution deep-dive ══\n');
console.log(`Loading 12h candles for ${symbols.length} symbols…`);
const symbolCandles = await loadAllSymbols(symbols, '12h');
console.log(`  ${Object.keys(symbolCandles).length} ready`);
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();
console.log('  filters: 15m + 4h + F&G + market-context loaded\n');

// ── Regime labels for the full BTC series (hysteresis warms up over full history) ──
const btcKey = symbolCandles['BTC/USDC'] ? 'BTC/USDC' : (symbolCandles['BTC/USDT'] ? 'BTC/USDT' : null);
const regimeSeries = btcKey ? classifySeries(symbolCandles[btcKey], config.regimeClassifier ?? {}) : [];
const regimeTs = regimeSeries.map((r) => r.ts);
const regimeByTs = new Map(regimeSeries.map((r) => [r.ts, r.regime]));
/** regime active at (or most recently before) a timestamp */
function regimeAt(ts) {
  if (regimeByTs.has(ts)) return regimeByTs.get(ts);
  // binary search for last regime ts <= ts
  let lo = 0, hi = regimeTs.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (regimeTs[mid] <= ts) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans >= 0 ? regimeByTs.get(regimeTs[ans]) : 'UNKNOWN';
}

// ── Run target windows ─────────────────────────────────────────────────────────
const windows = defineWindows(symbolCandles).filter((w) => windowIds.includes(w.id));
if (windows.length === 0) {
  console.error(`No matching windows (${windowIds.join(', ')}). Available defineWindows ids vary by data depth.`);
  process.exit(1);
}

const report = { generated_at: new Date().toISOString(), git: gitMeta(), symbols: symbols.length, windows: {} };

for (const window of windows) {
  process.stdout.write(`Running ${window.id} (${window.label})… `);
  const t0 = Date.now();
  const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, budget, includeRaw: true });
  console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (r.skipped) { console.log(`  SKIP: ${r.reason}`); continue; }

  const trades = r.trades ?? [];
  const netPnl = trades.reduce((s, t) => s + Number(t.pnl ?? 0), 0);

  // Per-symbol
  const bySymbol = Object.entries(r.symbol_stats ?? {})
    .map(([sym, st]) => ({
      sym, trades: st.trades, pnl: st.pnl, wins: st.wins,
      wr: st.trades ? st.wins / st.trades : 0,
      share: netPnl !== 0 ? (st.pnl / netPnl) * 100 : 0,
    }))
    .filter((s) => s.trades > 0)
    .sort((a, b) => b.pnl - a.pnl);

  // Per-exit-reason
  const byReason = {};
  for (const t of trades) {
    const k = t.reason ?? 'unknown';
    (byReason[k] ??= { count: 0, pnl: 0, wins: 0 });
    byReason[k].count++; byReason[k].pnl += Number(t.pnl ?? 0);
    if (Number(t.pnl) > 0) byReason[k].wins++;
  }

  // Per-regime (at entry)
  const byRegime = {};
  for (const t of trades) {
    const k = regimeAt(Number(t.entryTime));
    (byRegime[k] ??= { count: 0, pnl: 0, wins: 0 });
    byRegime[k].count++; byRegime[k].pnl += Number(t.pnl ?? 0);
    if (Number(t.pnl) > 0) byRegime[k].wins++;
  }

  // Concentration metrics
  const tradedCoins = bySymbol.length;
  const top3 = bySymbol.slice(0, 3).reduce((s, x) => s + x.pnl, 0);
  const top20pctN = Math.max(1, Math.ceil(tradedCoins * 0.2));
  const top20 = bySymbol.slice(0, top20pctN).reduce((s, x) => s + x.pnl, 0);
  const netPositiveCoins = bySymbol.filter((s) => s.pnl > 0).length;
  const netNegativeCoins = bySymbol.filter((s) => s.pnl < 0).length;
  const concentration = {
    traded_coins: tradedCoins,
    top3_share_pct: netPnl !== 0 ? (top3 / netPnl) * 100 : 0,
    top20pct_share_pct: netPnl !== 0 ? (top20 / netPnl) * 100 : 0,
    top20pct_n: top20pctN,
    net_positive_coins: netPositiveCoins,
    net_negative_coins: netNegativeCoins,
    fragile: (netPnl !== 0 && (top20 / netPnl) > 0.6), // >60% of P&L from <20% of coins
  };

  report.windows[window.id] = {
    days: window.days, net_pnl: Number(netPnl.toFixed(2)), total_trades: trades.length,
    metrics: r.metrics, deflated_sharpe: r.deflated_sharpe, concentration,
    by_symbol: bySymbol, by_reason: byReason, by_regime: byRegime,
  };
}

writeFileSync(outFile, JSON.stringify(report, null, 2));

// ── Human-readable summary ──────────────────────────────────────────────────────
const L = [];
L.push(`# Attribution deep-dive  (${report.git.branch ?? ''} @ ${report.git.sha ?? ''})`);
L.push(`Generated: ${report.generated_at}   Symbols: ${report.symbols}\n`);
for (const [id, w] of Object.entries(report.windows)) {
  L.push(`\n══════ ${id}  (${w.days}d) ══════`);
  L.push(`Net P&L ${usd(w.net_pnl)}   trades ${w.total_trades}   return ${w.metrics.total_return_pct}   Sharpe ${w.metrics.sharpe.toFixed(2)}   DSR ${w.deflated_sharpe?.dsr?.toFixed?.(2) ?? '—'}`);

  L.push(`\n  CONCENTRATION  ── ${w.concentration.fragile ? '⚠️  FRAGILE' : '✅ broad-ish'}`);
  L.push(`    traded coins: ${w.concentration.traded_coins}  (net+ ${w.concentration.net_positive_coins} / net− ${w.concentration.net_negative_coins})`);
  L.push(`    top-3 coins   → ${w.concentration.top3_share_pct.toFixed(0)}% of net P&L`);
  L.push(`    top-${w.concentration.top20pct_n} (20%) coins → ${w.concentration.top20pct_share_pct.toFixed(0)}% of net P&L`);

  L.push(`\n  BY SYMBOL (P&L desc)`);
  L.push(`    ${'sym'.padEnd(8)} ${'trades'.padStart(6)} ${'pnl'.padStart(10)} ${'WR'.padStart(5)} ${'share'.padStart(7)}`);
  for (const s of w.by_symbol) {
    L.push(`    ${s.sym.replace('/USDC', '').padEnd(8)} ${String(s.trades).padStart(6)} ${usd(s.pnl).padStart(10)} ${(s.wr * 100).toFixed(0).padStart(4)}% ${(s.share).toFixed(0).padStart(6)}%`);
  }

  L.push(`\n  BY EXIT REASON`);
  for (const [k, v] of Object.entries(w.by_reason).sort((a, b) => b[1].pnl - a[1].pnl)) {
    L.push(`    ${k.padEnd(14)} ${String(v.count).padStart(4)}t  ${usd(v.pnl).padStart(10)}  WR ${v.count ? (v.wins / v.count * 100).toFixed(0) : 0}%`);
  }

  L.push(`\n  BY REGIME (at entry)`);
  for (const [k, v] of Object.entries(w.by_regime).sort((a, b) => b[1].pnl - a[1].pnl)) {
    L.push(`    ${k.padEnd(14)} ${String(v.count).padStart(4)}t  ${usd(v.pnl).padStart(10)}  WR ${v.count ? (v.wins / v.count * 100).toFixed(0) : 0}%`);
  }
}
L.push(`\n(NOTE: per-strategy attribution deferred — needs a winning-strategy tag in the parity-locked aggregator path.)`);
const summary = L.join('\n');
writeFileSync(summaryPath, summary);
console.log(`\nWrote ${outFile}\nWrote ${summaryPath}\n`);
console.log(summary);

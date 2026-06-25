#!/usr/bin/env node
/**
 * Loser autopsy — find factors common to losing trades so we can skip them
 * (cutting drawdown AND freeing slots for better trades = higher Sharpe).
 *
 * Runs the committed config (relaxed MTF) over the 6yr window, enriches each
 * trade with its ENTRY conditions (regime, volatility, extension/late-entry,
 * BTC macro, prior momentum, symbol, exit reason, hold bars), then compares the
 * winner vs loser distributions to surface discriminating factors.
 *
 * Read-only; touches no parity-locked code. Writes a report.
 *
 * Usage:  PAPER_MODE=true node src/scripts/runLoserAutopsy.mjs
 */

import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, defineWindows, runWindow, gitMeta } from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';
import { classifySeries } from '../engine/regimeClassifier.js';

const argv = process.argv.slice(2);
let windowId = argv.includes('--window') ? argv[argv.indexOf('--window') + 1] : 'full_history';
const outFile = 'data/loser_autopsy.json';
if (!existsSync('data')) mkdirSync('data');
const symbols = config.symbols;

const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();

// ── entry-feature helpers (computed from candles, no instrumentation) ──────────
const btc = symbolCandles['BTC/USDC'];
const regimeByTs = new Map(classifySeries(btc, config.regimeClassifier ?? {}).map((r) => [r.ts, r.regime]));
const regimeTsSorted = [...regimeByTs.keys()].sort((a, b) => a - b);
function regimeAt(ts) {
  if (regimeByTs.has(ts)) return regimeByTs.get(ts);
  let lo = 0, hi = regimeTsSorted.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (regimeTsSorted[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? regimeByTs.get(regimeTsSorted[ans]) : 'UNKNOWN';
}
// BTC above its 200-bar SMA at ts? (macro bull/bear proxy)
function btcMacroBull(ts) {
  let i = btc.findIndex((c) => c.timestamp >= ts);
  if (i < 0) i = btc.length - 1;
  if (i < 200) return null;
  const sma = btc.slice(i - 200, i).reduce((s, c) => s + c.close, 0) / 200;
  return btc[i].close > sma;
}
// per-symbol index for entry-feature lookups
const idx = {};
for (const [s, arr] of Object.entries(symbolCandles)) {
  const m = new Map(); arr.forEach((c, i) => m.set(c.timestamp, i)); idx[s] = { arr, m };
}
function entryFeatures(sym, entryTs) {
  const e = idx[sym]; if (!e) return null;
  const i = e.m.get(entryTs); if (i == null || i < 14) return null;
  const arr = e.arr, price = arr[i].close;
  // ATR% over prior 14 bars
  let tr = 0; for (let k = i - 13; k <= i; k++) tr += (arr[k].high - arr[k].low) / arr[k].close;
  const atrPct = (tr / 14) * 100;
  // extension: % above the prior 10-bar low (how late/extended the entry is)
  const lows = arr.slice(i - 10, i).map((c) => c.low); const lo10 = Math.min(...lows);
  const extPct = ((price - lo10) / lo10) * 100;
  // prior 5-bar momentum %
  const mom5 = ((price - arr[i - 5].close) / arr[i - 5].close) * 100;
  return { atrPct, extPct, mom5 };
}

const window = defineWindows(symbolCandles).find((w) => w.id === windowId);
const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, includeRaw: true });
const trades = (r.trades ?? []).filter((t) => t.reason !== 'partial_exit');

const rows = [];
for (const t of trades) {
  const f = entryFeatures(t.symbol, Number(t.entryTime));
  const holdBars = (Number(t.exitTime) - Number(t.entryTime)) / (12 * 3600 * 1000);
  rows.push({
    sym: t.symbol.replace('/USDC', ''), pnl: Number(t.pnl), win: Number(t.pnl) > 0,
    reason: t.reason, regime: regimeAt(Number(t.entryTime)), macroBull: btcMacroBull(Number(t.entryTime)),
    holdBars, atrPct: f?.atrPct ?? null, extPct: f?.extPct ?? null, mom5: f?.mom5 ?? null,
  });
}
const W = rows.filter((x) => x.win), L = rows.filter((x) => !x.win);
const avg = (a, k) => { const v = a.map((x) => x[k]).filter((n) => n != null); return v.length ? v.reduce((s, n) => s + n, 0) / v.length : NaN; };
const med = (a, k) => { const v = a.map((x) => x[k]).filter((n) => n != null).sort((p, q) => p - q); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
function byCat(a, k) { const o = {}; for (const x of a) { const c = String(x[k]); (o[c] ??= { n: 0, pnl: 0 }); o[c].n++; o[c].pnl += x.pnl; } return o; }

const fmt = (x) => Number.isNaN(x) ? '—' : x.toFixed(2);
const L2 = [];
L2.push(`# Loser autopsy — ${windowId}  (${rows.length} trades: ${W.length} win / ${L.length} loss)`);
L2.push(`Total net P&L $${rows.reduce((s, x) => s + x.pnl, 0).toFixed(0)}   loser drag $${L.reduce((s, x) => s + x.pnl, 0).toFixed(0)}`);
L2.push(`\n── Continuous entry features (winners vs losers: median | mean) ──`);
for (const k of ['atrPct', 'extPct', 'mom5', 'holdBars']) {
  L2.push(`  ${k.padEnd(9)}  win ${fmt(med(W, k))} | ${fmt(avg(W, k))}    loss ${fmt(med(L, k))} | ${fmt(avg(L, k))}`);
}
L2.push(`\n── By entry regime (n, net P&L, win-rate) ──`);
const rgW = byCat(W, 'regime'), rgAll = byCat(rows, 'regime');
for (const k of Object.keys(rgAll).sort((a, b) => rgAll[a].pnl - rgAll[b].pnl)) {
  const wn = rgW[k]?.n ?? 0; L2.push(`  ${k.padEnd(12)} n=${String(rgAll[k].n).padStart(3)}  $${rgAll[k].pnl.toFixed(0).padStart(6)}  WR ${(wn / rgAll[k].n * 100).toFixed(0)}%`);
}
L2.push(`\n── By BTC macro (above 200-SMA?) ──`);
const mAll = byCat(rows, 'macroBull'), mW = byCat(W, 'macroBull');
for (const k of Object.keys(mAll)) { const wn = mW[k]?.n ?? 0; L2.push(`  macroBull=${k.padEnd(6)} n=${String(mAll[k].n).padStart(3)}  $${mAll[k].pnl.toFixed(0).padStart(6)}  WR ${(wn / mAll[k].n * 100).toFixed(0)}%`); }
L2.push(`\n── By exit reason ──`);
const xAll = byCat(rows, 'reason');
for (const k of Object.keys(xAll).sort((a, b) => xAll[a].pnl - xAll[b].pnl)) L2.push(`  ${k.padEnd(14)} n=${String(xAll[k].n).padStart(3)}  $${xAll[k].pnl.toFixed(0).padStart(6)}`);
L2.push(`\n── Worst symbols (net P&L asc) ──`);
const sAll = byCat(rows, 'sym');
for (const k of Object.keys(sAll).sort((a, b) => sAll[a].pnl - sAll[b].pnl).slice(0, 8)) L2.push(`  ${k.padEnd(8)} n=${String(sAll[k].n).padStart(2)}  $${sAll[k].pnl.toFixed(0).padStart(6)}`);

writeFileSync(outFile, JSON.stringify({ generated_at: new Date().toISOString(), git: gitMeta(), window: windowId, rows }, null, 2));
writeFileSync(outFile.replace('.json', '_summary.txt'), L2.join('\n'));
console.log(L2.join('\n'));

#!/usr/bin/env node
/**
 * Stage 1 of the regime-adaptive plan: does each strategy ARCHETYPE specialise by
 * regime? Runs the canonical trend pack and mean-reversion pack GLOBALLY (per-symbol
 * tuning stripped, momentum filter ON) and buckets each pack's P&L by entry regime.
 *
 * Premise test: if the TREND pack earns mostly in BULL_TREND and the MR pack earns
 * mostly in BULL_RANGE, regime routing has merit. If both earn in the same regime,
 * routing won't add anything → don't build it.
 *
 * Read-only; mutates the in-memory config singleton only (not persisted).
 *
 * Usage:  PAPER_MODE=true node src/scripts/runArchetypeRegime.mjs
 */
import 'dotenv/config';
process.setMaxListeners(100);
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, defineWindows, runWindow, gitMeta } from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { refreshMarketContext } from '../data/marketContext.js';
import { classifySeries } from '../engine/regimeClassifier.js';
// NB: DEFAULT_REGIME_BUNDLES uses Donchian/VWAPσ which baselineFramework's strategy
// map doesn't include — so we use equivalent archetype packs from the 15 available.

if (!existsSync('data')) mkdirSync('data');
const symbols = config.symbols;
const symbolCandles = await loadAllSymbols(symbols, '12h');
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
await refreshMarketContext();

// regime label at a timestamp (full-series classification, no lookahead concern for bucketing)
const btc = symbolCandles['BTC/USDC'];
const regimeByTs = new Map(classifySeries(btc, config.regimeClassifier ?? {}).map((r) => [r.ts, r.regime]));
const tsSorted = [...regimeByTs.keys()].sort((a, b) => a - b);
function regimeAt(ts) {
  if (regimeByTs.has(ts)) return regimeByTs.get(ts);
  let lo = 0, hi = tsSorted.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tsSorted[m] <= ts) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? regimeByTs.get(tsSorted[ans]) : 'UNKNOWN';
}

// Strip per-symbol tuning so every symbol uses the same global pack; lower minConf
// so the packs actually trade (per-symbol thresholds were tuned for their own combos).
config.perSymbol = {};
config.risk.minConfidence = 0.55;

const MR = ['RSI', 'BB', 'Stoch', 'WilliamsR', 'SR'];
const packs = [
  { id: 'TREND pack',          set: ['EMA', 'MACD', 'Supertrend', 'ADX', 'OBV'], ov: {} },
  { id: 'MR pack (filters on)', set: MR, ov: {} },
  { id: 'MR pack (MTF off)',    set: MR, ov: { mtfFilter: false, mtf4hFilter: false } }, // do trend-align filters block MR?
];
const window = defineWindows(symbolCandles).find((w) => w.id === 'full_history');
const report = { generated_at: new Date().toISOString(), git: gitMeta(), packs: {} };
const L = [`# Archetype × regime (6yr, global packs, momentum ON)  ${gitMeta().branch} @ ${gitMeta().sha}`];

for (const pack of packs) {
  config.strategies = pack.set;
  // momentum OFF (it blocks oversold MR entries); each pack may also override MTF.
  const r = runWindow({ window, symbolCandles, mtf15mCandles, mtf4hCandles, fearGreedData, includeRaw: true, filterOverrides: pack.ov });
  const trades = (r.trades ?? []).filter((t) => t.reason !== 'partial_exit');
  const byReg = {};
  for (const t of trades) { const k = regimeAt(Number(t.entryTime)); (byReg[k] ??= { n: 0, pnl: 0, w: 0 }); byReg[k].n++; byReg[k].pnl += Number(t.pnl); if (Number(t.pnl) > 0) byReg[k].w++; }
  report.packs[pack.id] = { strategies: pack.set, total_return_pct: r.metrics.total_return_pct, sharpe: r.metrics.sharpe, total_trades: trades.length, byRegime: byReg };
  L.push(`\n══ ${pack.id} [${pack.set.join(',')}] ══   total ${r.metrics.total_return_pct}  Sharpe ${r.metrics.sharpe.toFixed(2)}  ${trades.length}t`);
  L.push(`  blocks: ${JSON.stringify(r.filters_applied)}`);
  L.push(`  ${'regime'.padEnd(12)} ${'trades'.padStart(6)} ${'pnl'.padStart(9)} ${'WR'.padStart(5)} ${'%ofPnL'.padStart(7)}`);
  const tot = trades.reduce((s, t) => s + Number(t.pnl), 0);
  for (const k of Object.keys(byReg).sort((a, b) => byReg[b].pnl - byReg[a].pnl)) {
    const v = byReg[k]; L.push(`  ${k.padEnd(12)} ${String(v.n).padStart(6)} ${('$' + v.pnl.toFixed(0)).padStart(9)} ${(v.w / v.n * 100).toFixed(0).padStart(4)}% ${(tot ? v.pnl / tot * 100 : 0).toFixed(0).padStart(6)}%`);
  }
}
writeFileSync('data/archetype_regime.json', JSON.stringify(report, null, 2));
const summary = L.join('\n');
writeFileSync('data/archetype_regime_summary.txt', summary);
console.log('\n' + summary);
console.log('\n(Premise holds if TREND pack concentrates P&L in BULL_TREND and MR pack in BULL_RANGE. If both peak in the same regime, routing adds nothing.)');

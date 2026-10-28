/**
 * Signal integrity checks, after Freqtrade's `recursive-analysis` and
 * `lookahead-analysis` (docs/EXTERNAL_BOTS_REVIEW.md).
 *
 * 1. Recursive: do the decisions depend on how much history is loaded? Live keeps
 *    the candles it seeded and fetched (about 1,600 12h bars); a walk-forward fold
 *    slices its window. Recursive indicators (EMA200, ADX, Supertrend) depend on where
 *    the series starts. For the newest bars, rows computed from H bars of history are
 *    compared with rows computed from all of it.
 * 2. Lookahead: does anything decided before time C change when data after C exists?
 *    The backtester runs on every series cut at C and on the full series; every trade
 *    that opened and closed before C must be identical. A difference is a leak of
 *    future data into a decision, a gate, the stop replay or the sizing.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runSignalIntegrity.mjs [--recent 120] [--cuts 3]
 */

import 'dotenv/config';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import {
  loadAllSymbols, loadMtfCandles, FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides,
} from '../backtester/baselineFramework.js';
import { buildStrategiesForSymbol } from '../utils/strategyBuilder.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback);
const RECENT = arg('--recent', 120);
const CUTS = arg('--cuts', 3);
const HISTORIES = [250, 500, 1000];

const symbolMinConfidence = Object.fromEntries(
  Object.entries(config.perSymbol ?? {}).filter(([, ps]) => ps.minConfidence != null).map(([s, ps]) => [s, ps.minConfidence]),
);
const signalConfig = (symbols) => ({
  signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
  symbolMinConfidence: Object.fromEntries(symbols.filter((s) => symbolMinConfidence[s] != null).map((s) => [s, symbolMinConfidence[s]])),
  confidenceThresholdScale: config.risk?.confidenceThresholdScale,
});
const newBacktester = (symbols, extra = {}) => new PortfolioBacktester(
  Object.fromEntries(symbols.map((s) => [s, buildStrategiesForSymbol(s)])),
  { ...signalConfig(symbols), ...extra },
);

const symbolCandles = await loadAllSymbols(config.symbols, config.timeframe);
const symbols = Object.keys(symbolCandles);

// ── 1. Recursive ─────────────────────────────────────────────────────────────
console.log(`\n1. Recursive analysis — the newest ${RECENT} bars per symbol, decision + confidence vs full history`);
const full = newBacktester(symbols).computeSignalRows(symbolCandles);
for (const H of HISTORIES) {
  let n = 0; let sameDecision = 0; let sameBoth = 0; let maxDelta = 0;
  const worst = {};
  for (const s of symbols) {
    const c = symbolCandles[s];
    if (c.length < H + RECENT) continue;
    const rows = newBacktester([s]).computeSignalRows({ [s]: c.slice(-(H + RECENT)) })[s];
    const byTs = new Map(full[s].map((r) => [r.timestamp, r]));
    for (const r of rows.slice(-RECENT)) {
      const f = byTs.get(r.timestamp);
      if (!f) continue;
      n++;
      const d = Math.abs(r.confidence - f.confidence);
      if (r.decision === f.decision) sameDecision++;
      if (r.decision === f.decision && d < 1e-9) sameBoth++;
      if (r.decision !== f.decision) worst[s] = (worst[s] ?? 0) + 1;
      maxDelta = Math.max(maxDelta, d);
    }
  }
  const top = Object.entries(worst).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, k]) => `${s}:${k}`).join(' ');
  console.log(`  ${String(H).padStart(5)} bars of history: ${n} rows — same decision ${(100 * sameDecision / n).toFixed(2)}%, `
    + `identical ${(100 * sameBoth / n).toFixed(2)}%, max |Δconf| ${maxDelta.toFixed(4)}${top ? `  (decision changes: ${top})` : ''}`);
}

// ── 2. Lookahead ─────────────────────────────────────────────────────────────
console.log(`\n2. Lookahead analysis — trades closed before a cut must not change when later data exists`);
const mtf15m = loadMtfCandles(symbols, '15m');
const mtf4h = loadMtfCandles(symbols, '4h');
const { symbolRisk } = buildPerSymbolOverrides(symbols);
const runAt = (cutTs) => {
  const cut = (series) => Object.fromEntries(Object.entries(series)
    .map(([s, c]) => [s, cutTs == null ? c : c.filter((x) => Number(x.timestamp) <= cutTs)])
    .filter(([, c]) => c.length >= 60));
  const c12 = cut(symbolCandles);
  return newBacktester(Object.keys(c12), {
    risk: { ...(config.risk ?? {}), initialBalance: 1000, basePctOverride: config.risk?.maxPositionPct, feePct: 0.001, slippagePct: 0.001 },
    maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
    symbolSlippage: SLIPPAGE_TIERS,
    symbolRisk,
    mtfSymbolCandles: cut(mtf15m),
    mtf4hSymbolCandles: cut(mtf4h),
    ...FULL_LIVE_FILTERS,
  }).run(c12);
};
const reference = runAt(null).trades;
const btc = symbolCandles['BTC/USDC'];
for (let k = 1; k <= CUTS; k++) {
  const cutTs = Number(btc[Math.floor((btc.length * k) / (CUTS + 1))].timestamp);
  // A trade's exit can be as late as its exit time; compare only trades fully inside.
  const before = (trades) => trades.filter((t) => t.exitTime < cutTs - 12 * 60 * 60 * 1000)
    .map((t) => [t.symbol, t.entryTime, t.exitTime, t.entryFillPrice, t.exitPrice, t.reason, t.qty]);
  const a = before(runAt(cutTs).trades);
  const b = before(reference);
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(`  cut ${new Date(cutTs).toISOString().slice(0, 10)}: ${a.length} trades closed before it — ${same ? 'identical' : 'DIFFERENT (future data leaks)'}`);
  if (!same) {
    const first = a.findIndex((t, i) => JSON.stringify(t) !== JSON.stringify(b[i]));
    console.log(`    first difference: cut ${JSON.stringify(a[first])}  full ${JSON.stringify(b[first])}`);
  }
}

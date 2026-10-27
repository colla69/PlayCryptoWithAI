/**
 * The live engine over history vs PortfolioBacktester — do the two engines trade
 * the same? (plan 2026-10 single-engine rebuild, step 4, slice 3b)
 *
 * Both run the same window with the same config, live sizing, start balance and
 * deposits; every trade is compared (symbol, entry and exit time, reason, fills,
 * size). A difference is a rule the two engines apply differently.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runEngineReplay.mjs --from 2026-08-20 --to 2026-10-24 \
 *     [--balance 118.4] [--deposits <snapshot>/data/deposits.json] [--show 10]
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import {
  loadAllSymbols, loadMtfCandles, FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides,
} from '../backtester/baselineFramework.js';
import { replayEngine } from '../backtester/engineReplay.js';
import { buildStrategiesForSymbol } from '../utils/strategyBuilder.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const fromTs = Date.parse(arg('--from', '2026-08-20'));
const toTs = Date.parse(arg('--to', '2026-10-24'));
const balance = Number(arg('--balance', 1000));
const show = Number(arg('--show', 10));
const deposits = arg('--deposits')
  ? JSON.parse(readFileSync(arg('--deposits'), 'utf8')).map((d) => ({ ts: Date.parse(d.timestamp), amount: Number(d.amount) }))
  : [];
const iso = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';

const symbolCandles = await loadAllSymbols(config.symbols, config.timeframe);
const symbols = Object.keys(symbolCandles);
const mtf15mCandles = loadMtfCandles(symbols, '15m');
const mtf4hCandles = loadMtfCandles(symbols, '4h');
const fearGreedData = await loadFearGreedHistory();
// Each engine sees history only up to the window's end.
const upTo = (series) => Object.fromEntries(Object.entries(series).map(([s, c]) => [s, c.filter((x) => Number(x.timestamp) <= toTs + 12 * 3_600_000)]));
const c12 = upTo(symbolCandles);

// ── PortfolioBacktester, live settings ───────────────────────────────────────
const { symbolRisk, symbolMinConfidence } = buildPerSymbolOverrides(symbols);
const pb = new PortfolioBacktester(
  Object.fromEntries(symbols.map((s) => [s, buildStrategiesForSymbol(s)])),
  {
    risk: {
      ...(config.risk ?? {}), initialBalance: balance, basePctOverride: config.risk?.maxPositionPct,
      feePct: 0.001, slippagePct: 0.001, breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
    },
    signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
    maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
    symbolSlippage: SLIPPAGE_TIERS, symbolRisk, symbolMinConfidence,
    mtfSymbolCandles: mtf15mCandles, mtf4hSymbolCandles: mtf4hCandles, fearGreedData,
    confidenceThresholdScale: config.risk?.confidenceThresholdScale,
    ...FULL_LIVE_FILTERS,
    tradeFromTs: fromTs, deposits,
  },
).run(c12);
const pbTrades = pb.trades.filter((t) => t.entryTime <= toTs);

// ── The live engine, replayed ────────────────────────────────────────────────
const t0 = Date.now();
// Scalper against scalper: PortfolioBacktester has no TSM sleeve, so the replay runs
// without it too (its cash use would change every scalper size). The sleeve has its
// own check against live, runSleeveReplay.mjs.
const replay = await replayEngine({
  symbolCandles: c12, mtf15mCandles, mtf4hCandles, fearGreedData,
  fromTs, toTs, initialBalance: balance, deposits, slippage: SLIPPAGE_TIERS,
  // PortfolioBacktester has no venue veto (the engine replay is the backtest of the
  // live cycle); no notice touched a trade in the replayed windows (plan, section E item 2).
  cfg: { ...config, tsmCore: { ...(config.tsmCore ?? {}), enabled: false }, exchangeEvents: { enabled: false } },
});
const rpTrades = replay.trades.map((t) => t.raw).filter((t) => t.entryTime <= toTs);

// ── Compare ──────────────────────────────────────────────────────────────────
const key = (t) => [t.symbol, t.entryTime, t.exitTime, t.reason, t.entryFillPrice, t.exitPrice, t.qty];
const fmt = (t) => `${t.symbol.padEnd(10)} in ${iso(t.entryTime)} @${t.entryFillPrice}  out ${iso(t.exitTime)} @${t.exitPrice} ${t.reason} qty ${t.qty}`;
const used = new Set();
let identical = 0;
const onlyPb = [];
for (const a of pbTrades) {
  const k = rpTrades.findIndex((b, i) => !used.has(i) && JSON.stringify(key(a)) === JSON.stringify(key(b)));
  if (k >= 0) { used.add(k); identical++; } else onlyPb.push(a);
}
const onlyRp = rpTrades.filter((_, i) => !used.has(i));

console.log(`\nEngine replay vs PortfolioBacktester — ${iso(fromTs)} → ${iso(toTs)}, balance $${balance}, ${deposits.filter((d) => d.ts >= fromTs).length} deposit(s)  [replay ${((Date.now() - t0) / 1000).toFixed(0)} s]`);
console.log(`  PortfolioBacktester trades: ${pbTrades.length}   live-engine replay trades: ${rpTrades.length}   identical: ${identical}`);
for (const t of onlyPb.slice(0, show)) console.log(`    backtester only: ${fmt(t)}`);
for (const t of onlyRp.slice(0, show)) console.log(`    replay only    : ${fmt(t)}`);
// Same trade, different size: is it the sizing chain (positionPct) or the balance?
const sameButSize = onlyPb.map((a) => [a, onlyRp.find((b) => b.symbol === a.symbol && b.entryTime === a.entryTime)]).filter(([, b]) => b);
for (const [a, b] of sameButSize.slice(0, show)) {
  console.log(`    size: ${a.symbol.padEnd(10)} ${iso(a.entryTime)}  positionPct backtester ${a.positionPct?.toFixed(6)} replay ${b.positionPct?.toFixed(6)}  `
    + `cost backtester ${a.costBasis} replay ${b.costBasis}`);
}
const pnl = (ts) => ts.reduce((s, t) => s + Number(t.pnl), 0).toFixed(2);
console.log(`  realised P&L: backtester ${pnl(pbTrades)}   replay ${pnl(rpTrades)}`);

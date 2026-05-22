/**
 * shortTfBacktest.mjs — Short-timeframe strategy tester (15m / 1h)
 *
 * Two modes:
 *   Default      — single-symbol strategy comparisons (great for research)
 *   --portfolio  — multi-symbol portfolio mode using PortfolioBacktester
 *                  with shared capital — apples-to-apples vs the 12h results
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/shortTfBacktest.mjs [options]
 *
 * Options:
 *   --symbol   <string>   Symbol to test (single mode)   (default: BTC/USDT)
 *   --tf       <string>   Timeframe: 15m | 1h             (default: 15m)
 *   --candles  <number>   Number of candles               (default: all)
 *   --sl       <number>   Stop loss pct  (0.015 = 1.5%)   (default: 0.015)
 *   --tp       <number>   Take profit pct                 (default: 0.04)
 *   --balance  <number>   Initial balance                 (default: 1000)
 *   --slots    <number>   Max open positions (portfolio)  (default: 5)
 *   --combos              Run all strategy combos (single mode only)
 *   --portfolio           Multi-symbol portfolio mode
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

// ── Strategy imports ────────────────────────────────────────────────────────
import { RSIStrategy }            from '../strategies/rsi.js';
import { EMAStrategy }            from '../strategies/ema.js';
import { MACDStrategy }           from '../strategies/macd.js';
import { BollingerBandsStrategy } from '../strategies/bollingerBands.js';
import { StochasticStrategy }     from '../strategies/stochastic.js';
import { ADXStrategy }            from '../strategies/adx.js';
import { CCIStrategy }            from '../strategies/cci.js';
import { SupertrendStrategy }     from '../strategies/supertrend.js';
import { MFIStrategy }            from '../strategies/mfi.js';
import { OBVStrategy }            from '../strategies/obv.js';
import { PSARStrategy }           from '../strategies/psar.js';
import { WilliamsRStrategy }      from '../strategies/williamsR.js';
import { StochRSIStrategy }       from '../strategies/stochRsi.js';
import { HeikinAshiStrategy }     from '../strategies/heikinAshi.js';
import SignalAggregator            from '../engine/signalAggregator.js';
import { BacktestSimulator }       from '../backtester/backtestSimulator.js';
import { PortfolioBacktester }     from '../backtester/portfolioBacktester.js';
import { calculateMetrics }        from '../backtester/metrics.js';

// ── CLI args ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const args = {
  symbol:    'BTC/USDT',
  tf:        '15m',
  candles:   null,
  sl:        0.015,
  tp:        0.040,
  balance:   1000,
  slots:     5,
  combos:    false,
  portfolio: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--symbol'    && argv[i+1]) { args.symbol    = argv[++i];        continue; }
  if (a === '--tf'        && argv[i+1]) { args.tf         = argv[++i];        continue; }
  if (a === '--candles'   && argv[i+1]) { args.candles    = Number(argv[++i]); continue; }
  if (a === '--sl'        && argv[i+1]) { args.sl         = Number(argv[++i]); continue; }
  if (a === '--tp'        && argv[i+1]) { args.tp         = Number(argv[++i]); continue; }
  if (a === '--balance'   && argv[i+1]) { args.balance    = Number(argv[++i]); continue; }
  if (a === '--slots'     && argv[i+1]) { args.slots      = Number(argv[++i]); continue; }
  if (a === '--combos')                 { args.combos     = true;              continue; }
  if (a === '--portfolio')              { args.portfolio   = true;              continue; }
}

// ── Load candles ─────────────────────────────────────────────────────────────
function loadCandles(symbol, tf) {
  const safeSym = symbol.replace('/', '_');
  // Prefer y1 (prior year) + current year combined when both exist
  const paths = [
    resolve(ROOT, `data/candles/${safeSym}_${tf}.json`),
    resolve(ROOT, `data/candles/${safeSym}_${tf}_y1.json`),
  ];
  const all = [];
  for (const p of paths) {
    if (existsSync(p)) {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      all.push(...data);
    }
  }
  if (!all.length) throw new Error(`No cached candles found for ${symbol} ${tf}`);
  // Deduplicate + sort by timestamp
  const seen = new Set();
  const deduped = all.filter((c) => {
    if (seen.has(c.timestamp)) return false;
    seen.add(c.timestamp);
    return true;
  });
  deduped.sort((a, b) => a.timestamp - b.timestamp);
  return deduped;
}

// ── Strategy factory ─────────────────────────────────────────────────────────
/**
 * Strategy defaults tuned for 15m:
 *   - RSI period 21 (vs 14 on 12h) — longer lookback to reduce noise
 *   - Stoch period 21 for same reason
 *   - EMA fast/slow scaled to 15m (9/26)
 *   - StochRSI uses rsi=14, stoch=14, signal=3 — standard
 *   - Supertrend period=7, multiplier=3.0 — faster reaction on 15m
 */
const STRATEGY_CONFIGS_15M = {
  RSI:        { period: 21, oversold: 30, overbought: 70 },
  EMA:        { fast: 9, slow: 26 },
  MACD:       { fast: 12, slow: 26, signal: 9 },
  BB:         { period: 20, stdDev: 2 },
  Stoch:      { period: 21, signalPeriod: 5, oversold: 20, overbought: 80 },
  ADX:        { period: 14, threshold: 20 },
  CCI:        { period: 20, oversold: -100, overbought: 100 },
  ST:         { period: 7, multiplier: 3.0 },
  MFI:        { period: 14, oversold: 20, overbought: 80 },
  OBV:        { emaPeriod: 20 },
  PSAR:       { step: 0.02, max: 0.2 },
  WilliamsR:  { period: 14, oversold: -80, overbought: -20 },
  StochRSI:   { rsiPeriod: 14, stochPeriod: 14, signalPeriod: 3, oversold: 20, overbought: 80 },
  HA:         { warmup: 10 },
};

function buildStrategies(names) {
  const cfg = STRATEGY_CONFIGS_15M;
  const map = {
    RSI:       () => new RSIStrategy(cfg.RSI),
    EMA:       () => new EMAStrategy(cfg.EMA),
    MACD:      () => new MACDStrategy(cfg.MACD),
    BB:        () => new BollingerBandsStrategy(cfg.BB),
    Stoch:     () => new StochasticStrategy(cfg.Stoch),
    ADX:       () => new ADXStrategy(cfg.ADX),
    CCI:       () => new CCIStrategy(cfg.CCI),
    ST:        () => new SupertrendStrategy(cfg.ST),
    MFI:       () => new MFIStrategy(cfg.MFI),
    OBV:       () => new OBVStrategy(cfg.OBV),
    PSAR:      () => new PSARStrategy(cfg.PSAR),
    WilliamsR: () => new WilliamsRStrategy(cfg.WilliamsR),
    StochRSI:  () => new StochRSIStrategy(cfg.StochRSI),
    HA:        () => new HeikinAshiStrategy(cfg.HA),
  };
  return names.map((n) => {
    if (!map[n]) throw new Error(`Unknown strategy: ${n}`);
    return map[n]();
  });
}

// ── Backtester ─────────────────────────────────────────────────────────────
const MIN_WARMUP = 50;
// Cap the candle slice fed to strategies — strategies only need a fixed
// lookback (longest is ~200 for EMA200). Capping avoids O(N²) slowness.
const MAX_LOOKBACK = 300;

async function runCombo(candles, strategyNames, sl, tp, balance) {
  const strategies = buildStrategies(strategyNames);
  const signalConfig = { minConfidence: 0.5, entryThreshold: 0.65 };
  const aggregator = new SignalAggregator(strategies, signalConfig);
  const riskConfig = {
    initialBalance:  balance,
    stopLossPct:     sl,
    takeProfitPct:   tp,
    feePct:          0.001,
    slippagePct:     0.0005,
    maxPositionPct:  1.0, // use full available balance per trade (single-symbol mode)
  };
  const simulator = new BacktestSimulator(riskConfig);
  const symbol = args.symbol;

  for (let i = MIN_WARMUP; i < candles.length; i++) {
    const start = Math.max(0, i - MAX_LOOKBACK);
    const slice = candles.slice(start, i + 1);
    const candle = candles[i];
    const result = aggregator.aggregate(slice, symbol, signalConfig);
    simulator.setTimestamp(candle.timestamp);
    simulator.execute(symbol, result.decision, Number(candle.close));
  }

  const trades = simulator.getTrades();
  const curve  = simulator.getEquityCurve();
  const final  = curve.at(-1)?.balance ?? balance;
  const returns = curve.map((e) => e.balance / balance - 1);
  const metrics = calculateMetrics(trades, curve, balance);

  aggregator.destroy(); // clean up EventEmitter listeners
  return { final, trades, returns, metrics, curve };
}

// ── Format result line ────────────────────────────────────────────────────
function fmt(label, result, balance) {
  const ret   = ((result.final - balance) / balance * 100).toFixed(2);
  const sign  = result.final >= balance ? '+' : '';
  const n     = result.trades.length;
  const wins  = result.trades.filter((t) => t.pnl > 0).length;
  const wr    = n > 0 ? ((wins / n) * 100).toFixed(0) : '-';
  const sharpe = result.metrics?.sharpeRatio?.toFixed(2) ?? '-';
  const dd    = result.metrics?.maxDrawdown != null
    ? (result.metrics.maxDrawdown * 100).toFixed(2) + '%'
    : '-';
  return `  ${label.padEnd(30)} ${sign}${ret}%  |  Sharpe ${sharpe}  |  DD ${dd}  |  ${n} trades  ${wr}% WR`;
}

// ── Portfolio mode helpers ─────────────────────────────────────────────────

/**
 * Auto-discover all symbols that have cached 15m candle files.
 * Combines _y1 (prior year) and current year into one deduplicated series.
 */
function discoverSymbols(tf) {
  const dir = resolve(ROOT, 'data/candles');
  const files = readdirSync(dir);
  const pattern = new RegExp(`^(.+)_${tf}(?:_y1)?\\.json$`);
  const safeSyms = new Set();
  for (const f of files) {
    const m = f.match(pattern);
    if (m) safeSyms.add(m[1]);
  }
  return [...safeSyms].map((s) => s.replace('_', '/'));
}

/**
 * Build HA+ST strategies for a symbol — the best 15m combo we found.
 */
function buildPortfolioStrategies() {
  return [
    new HeikinAshiStrategy({ warmup: 10, minStreak: 3 }),
    new SupertrendStrategy({ period: 10, multiplier: 3.0 }),
  ];
}

async function runPortfolio() {
  const tf     = args.tf;
  const sl     = args.sl;
  const tp     = args.tp;
  const slots  = args.slots;
  const budget = args.balance;

  // Discover and load all available symbols for this timeframe
  const allSymbols = discoverSymbols(tf);
  const symbolCandles = {};
  for (const sym of allSymbols) {
    try {
      let c = loadCandles(sym, tf);
      if (args.candles) c = c.slice(-args.candles);
      if (c.length >= 100) symbolCandles[sym] = c;
    } catch { /* skip */ }
  }

  const symList = Object.keys(symbolCandles);
  if (!symList.length) { console.error('No symbols with enough candles.'); process.exit(1); }

  const dateFrom = new Date(Math.min(...symList.map(s => symbolCandles[s][0].timestamp))).toISOString().slice(0,10);
  const dateTo   = new Date(Math.max(...symList.map(s => symbolCandles[s].at(-1).timestamp))).toISOString().slice(0,10);
  const minC     = Math.min(...symList.map(s => symbolCandles[s].length));
  const maxC     = Math.max(...symList.map(s => symbolCandles[s].length));

  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║      SHORT-TF PORTFOLIO BACKTEST — shared balance        ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Strategy   : HA + Supertrend (best 15m combo)`);
  console.log(`  Symbols    : ${symList.length} coins  [${symList.join(', ')}]`);
  console.log(`  Timeframe  : ${tf}  |  ${minC}–${maxC} candles per symbol`);
  console.log(`  Period     : ${dateFrom} → ${dateTo}`);
  console.log(`  Budget     : $${budget}  |  Slots: ${slots}  (~$${(budget/slots).toFixed(0)}/slot)`);
  console.log(`  Risk       : SL ${(sl*100).toFixed(1)}%  TP ${(tp*100).toFixed(1)}%\n`);

  // Build per-symbol strategies
  const symbolStrategies = Object.fromEntries(
    symList.map((sym) => [sym, buildPortfolioStrategies()])
  );

  const backtester = new PortfolioBacktester(symbolStrategies, {
    risk: {
      initialBalance:  budget,
      stopLossPct:     sl,
      takeProfitPct:   tp,
      feePct:          0.001,
      slippagePct:     0.001,
    },
    signals:           { minConfidence: 0.5 },
    maxOpenPositions:  slots,
    atrPositionSizing: false,
    regimeFilter:      false,
    correlationFilter: false,
    macroFilter:       false,
    maxLookback:       MAX_LOOKBACK,
  });

  console.log('Running portfolio simulation…');
  const start = Date.now();
  const result = await backtester.run(symbolCandles);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  const { summary, trades, equityCurve } = result;
  const initial = budget;
  const final   = equityCurve.at(-1)?.balance ?? initial;
  const ret     = ((final - initial) / initial * 100).toFixed(2);
  const sign    = final >= initial ? '+' : '';
  const wins    = trades.filter((t) => t.pnl > 0).length;
  const wr      = trades.length ? ((wins / trades.length) * 100).toFixed(0) : '-';
  const metrics = calculateMetrics(trades, equityCurve, initial);

  console.log(`\n  RESULT: $${initial} → $${final.toFixed(2)}  (${sign}${ret}%)  [${elapsed}s]`);
  console.log(`  Sharpe ratio  : ${metrics?.sharpeRatio?.toFixed(2) ?? '-'}`);
  console.log(`  Max drawdown  : ${metrics?.maxDrawdown != null ? (metrics.maxDrawdown*100).toFixed(2)+'%' : '-'}`);
  console.log(`  Total trades  : ${trades.length}  |  Win rate: ${wr}%`);
  console.log(`  Trades/symbol : ${(trades.length / symList.length).toFixed(1)} avg\n`);

  // Per-symbol breakdown
  const bySymbol = {};
  for (const t of trades) {
    if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, n: 0, wins: 0 };
    bySymbol[t.symbol].pnl  += t.pnl ?? 0;
    bySymbol[t.symbol].n++;
    if ((t.pnl ?? 0) > 0) bySymbol[t.symbol].wins++;
  }
  const sorted = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
  if (sorted.length) {
    console.log('  Per-symbol P&L:');
    for (const [sym, s] of sorted) {
      const wr2 = ((s.wins / s.n) * 100).toFixed(0);
      const sign2 = s.pnl >= 0 ? '+' : '';
      console.log(`    ${sym.padEnd(12)}  ${sign2}$${s.pnl.toFixed(2).padStart(8)}   ${s.n} trades  ${wr2}% WR`);
    }
  }
  console.log();
}

// ── Main ───────────────────────────────────────────────────────────────────

if (args.portfolio) {
  await runPortfolio();
  process.exit(0);
}

let candles = loadCandles(args.symbol, args.tf);
if (args.candles) candles = candles.slice(-args.candles);

console.log(`\n${'─'.repeat(90)}`);
console.log(`  Short-TF Backtester  |  ${args.symbol}  ${args.tf}  |  ${candles.length} candles`);
console.log(`  SL ${(args.sl*100).toFixed(1)}%  TP ${(args.tp*100).toFixed(1)}%  |  Balance $${args.balance}`);
console.log(`  From ${new Date(candles[0].timestamp).toISOString().slice(0,10)}  to  ${new Date(candles.at(-1).timestamp).toISOString().slice(0,10)}`);
console.log(`${'─'.repeat(90)}\n`);

if (args.combos) {
  // Comprehensive sweep: test many combinations
  const COMBOS = [
    // Baselines
    ['RSI', 'BB', 'MACD'],
    ['RSI', 'BB', 'CCI'],
    ['RSI', 'BB', 'ST'],
    // New strategies standalone
    ['StochRSI'],
    ['HA'],
    // New strategies paired
    ['StochRSI', 'HA'],
    ['StochRSI', 'ST'],
    ['HA', 'ST'],
    // Three-way combos featuring new strategies
    ['StochRSI', 'HA', 'ST'],
    ['StochRSI', 'HA', 'EMA'],
    ['StochRSI', 'HA', 'MACD'],
    ['StochRSI', 'HA', 'OBV'],
    ['StochRSI', 'HA', 'MFI'],
    ['StochRSI', 'HA', 'PSAR'],
    // Four-way
    ['StochRSI', 'HA', 'ST', 'MFI'],
    ['StochRSI', 'HA', 'ST', 'OBV'],
    ['StochRSI', 'HA', 'EMA', 'MFI'],
    // Best known 12h combos tested on 15m
    ['RSI', 'BB', 'ST', 'MFI'],
    ['CCI', 'ST', 'OBV'],
  ];

  console.log(`  Running ${COMBOS.length} combinations...\n`);
  const results = [];
  for (const combo of COMBOS) {
    const label = combo.join('+');
    try {
      const res = await runCombo(candles, combo, args.sl, args.tp, args.balance);
      results.push({ label, res });
      process.stdout.write(`  ✓ ${label.padEnd(35)} $${res.final.toFixed(2)}\n`);
    } catch (e) {
      process.stdout.write(`  ✗ ${label.padEnd(35)} ERROR: ${e.message}\n`);
    }
  }

  results.sort((a, b) => b.res.final - a.res.final);
  console.log(`\n${'─'.repeat(90)}`);
  console.log(`  RANKED RESULTS (best to worst)`);
  console.log(`${'─'.repeat(90)}`);
  for (const { label, res } of results) {
    console.log(fmt(label, res, args.balance));
  }
  console.log(`${'─'.repeat(90)}\n`);

} else {
  // Single focused comparison: baseline vs new strategies
  const tests = [
    { label: 'Baseline: RSI+BB+MACD',     names: ['RSI', 'BB', 'MACD'] },
    { label: 'Baseline: RSI+BB+ST',        names: ['RSI', 'BB', 'ST'] },
    { label: 'New: StochRSI only',         names: ['StochRSI'] },
    { label: 'New: HeikinAshi only',       names: ['HA'] },
    { label: 'New: StochRSI + HA',         names: ['StochRSI', 'HA'] },
    { label: 'New: StochRSI + HA + ST',    names: ['StochRSI', 'HA', 'ST'] },
    { label: 'New: StochRSI + HA + EMA',   names: ['StochRSI', 'HA', 'EMA'] },
    { label: 'New: StochRSI + HA + MFI',   names: ['StochRSI', 'HA', 'MFI'] },
    { label: 'New: StochRSI + HA + OBV',   names: ['StochRSI', 'HA', 'OBV'] },
  ];

  for (const t of tests) {
    try {
      const res = await runCombo(candles, t.names, args.sl, args.tp, args.balance);
      console.log(fmt(t.label, res, args.balance));
    } catch (e) {
      console.log(`  ${t.label.padEnd(30)} ERROR: ${e.message}`);
    }
  }
  console.log();
}

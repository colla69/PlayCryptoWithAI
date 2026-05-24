/**
 * Portfolio backtest — realistic multi-coin simulation with a single shared balance.
 *
 * Usage:
 *   node src/scripts/portfolioBacktest.mjs [options]
 *
 * Options:
 *   --budget     <number>   Starting balance in USD                (default: 1000)
 *   --slots      <number>   Max concurrent open positions          (default: 5)
 *   --timeframe  <string>   Candle timeframe                       (default: config value)
 *   --candles    <number>   Candles to load per symbol             (default: 730)
 *   --symbols    a,b,c      Comma-separated override list          (default: all config symbols)
 *
 *   -- Swap options --
 *   --swap                  Enable hot-swap of worst loser         (default: off)
 *   --swapConf   <number>   Min confidence to trigger swap         (default: 0.75)
 *   --minHold    <number>   Min bars a position must age before
 *                           it can be swapped out (anti-churn)     (default: 3)
 *
 *   -- Position sizing --
 *   --atr                   Enable ATR-based inverse-vol sizing    (default: off)
 *   --atrPeriod  <number>   ATR period                             (default: 14)
 *   --kelly                 Enable rolling fractional Kelly        (default: off)
 *   --kellyWindow <number>  Closed-trades window for Kelly         (default: 20)
 *   --kellyFrac  <number>   Fractional Kelly safety factor         (default: 0.25)
 *
 *   -- Regime filter --
 *   --regime                Skip BUY signals in ranging markets    (default: off)
 *   --adxThresh  <number>   ADX threshold for "trending"           (default: 20)
 *
 * Examples:
 *   PAPER_MODE=true node src/scripts/portfolioBacktest.mjs
 *   PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --slots 8 --atr --regime
 *   PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --swap --minHold 5 --swapConf 0.80
 *   PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --atr --kelly --regime --slots 6
 */

import 'dotenv/config';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import { loadCachedCandles, saveCachedCandles } from '../exchange/candleCache.js';
import { fetchHistoricalOHLCV } from '../exchange/binanceClient.js';
import {
  ADXStrategy, BollingerBandsStrategy, CCIStrategy,
  EMAStrategy, MACDStrategy, RSIStrategy, StochasticStrategy,
  SupertrendStrategy, MFIStrategy, OBVStrategy, PSARStrategy, WilliamsRStrategy,
  StochRSIStrategy, HeikinAshiStrategy, SupportResistanceStrategy,
} from '../strategies/index.js';

// ── Parse CLI args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = {
    budget:      1000,
    slots:       5,
    timeframe:   config.timeframe,
    candles:     730,
    symbols:     null,
    // swap
    swap:        false,
    swapConf:    0.75,
    minHold:     3,
    // position sizing
    atr:         config.atr?.enabled ?? false,
    atrPeriod:   config.atr?.period  ?? 14,
    kelly:       false,
    kellyWindow: 20,
    kellyFrac:   0.25,
    // regime
    regime:      config.regime?.enabled ?? false,
    adxThresh:   config.regime?.adxThreshold ?? 20,
    // trailing stop
    trailing:    0,
    // SL/TP override (overrides per-symbol config when set)
    sl:          null,
    tp:          null,
    // break-even stop (move SL to entry once +X% profit)
    breakEven:   config.risk?.breakEvenTriggerPct ?? 0,
    // correlation filter (block correlated concurrent positions)
    corrFilter:  config.correlation?.enabled ?? false,
    corrThresh:  config.correlation?.threshold ?? 0.8,
    corrPeriod:  config.correlation?.period ?? 60,
    // macro bear filter (reduce position size when BTC below EMA200)
    macro:       config.macroFilter?.enabled ?? false,
    macroEMA:    config.macroFilter?.emaPeriod ?? 200,
    macroReduce: config.macroFilter?.sizeReduceFactor ?? 0.5,
    // multi-timeframe alignment filter (check 15m trend before 12h entry)
    mtf:         config.mtfFilter?.enabled ?? false,
    mtfBars:     config.mtfFilter?.alignBars ?? 16,
    mtfScore:    config.mtfFilter?.minAlignScore ?? 0.50,
    mtfReduce:   config.mtfFilter?.reduceFactor ?? 0,
    // MTF early exit (close losing positions when 15m turns strongly bearish)
    mtfExit:          config.mtfEarlyExit?.enabled ?? false,
    mtfExitScore:     config.mtfEarlyExit?.exitScore ?? 0.35,
    mtfExitMinLoss:   config.mtfEarlyExit?.minLossPct ?? 0.02,
    // Confidence-proportional position sizing
    confSizing:    config.confSizing?.enabled ?? false,
    confSizingMid: config.confSizing?.mid ?? 0.65,
    confSizingMax: config.confSizing?.max ?? 1.5,
    confSizingMin: config.confSizing?.min ?? 0.6,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--budget'      && argv[i+1]) { args.budget      = Number(argv[++i]); continue; }
    if (a === '--slots'       && argv[i+1]) { args.slots       = Number(argv[++i]); continue; }
    if (a === '--timeframe'   && argv[i+1]) { args.timeframe   = argv[++i];         continue; }
    if (a === '--candles'     && argv[i+1]) { args.candles     = Number(argv[++i]); continue; }
    if (a === '--symbols'     && argv[i+1]) { args.symbols     = argv[++i].split(',').map(s => s.trim()); continue; }
    if (a === '--swap')                      { args.swap        = true;              continue; }
    if (a === '--swapConf'    && argv[i+1]) { args.swapConf    = Number(argv[++i]); continue; }
    if (a === '--minHold'     && argv[i+1]) { args.minHold     = Number(argv[++i]); continue; }
    if (a === '--atr')                       { args.atr         = true;              continue; }
    if (a === '--atrPeriod'   && argv[i+1]) { args.atrPeriod   = Number(argv[++i]); continue; }
    if (a === '--kelly')                     { args.kelly       = true;              continue; }
    if (a === '--kellyWindow' && argv[i+1]) { args.kellyWindow = Number(argv[++i]); continue; }
    if (a === '--kellyFrac'   && argv[i+1]) { args.kellyFrac   = Number(argv[++i]); continue; }
    if (a === '--regime')                    { args.regime      = true;              continue; }
    if (a === '--no-regime')                 { args.regime      = false;             continue; }
    if (a === '--adxThresh'   && argv[i+1]) { args.adxThresh   = Number(argv[++i]); continue; }
    if (a === '--trailing'    && argv[i+1]) { args.trailing    = Number(argv[++i]); continue; }
    if (a === '--sl'          && argv[i+1]) { args.sl          = Number(argv[++i]); continue; }
    if (a === '--tp'          && argv[i+1]) { args.tp          = Number(argv[++i]); continue; }
    if (a === '--breakEven'   && argv[i+1]) { args.breakEven   = Number(argv[++i]); continue; }
    if (a === '--no-corr')                   { args.corrFilter  = false;             continue; }
    if (a === '--corrThresh'  && argv[i+1]) { args.corrThresh  = Number(argv[++i]); continue; }
    if (a === '--macro')                     { args.macro       = true;              continue; }
    if (a === '--no-macro')                  { args.macro       = false;             continue; }
    if (a === '--macroReduce' && argv[i+1]) { args.macroReduce = Number(argv[++i]); continue; }
    if (a === '--mtf')                       { args.mtf         = true;              continue; }
    if (a === '--no-mtf')                    { args.mtf         = false;             continue; }
    if (a === '--mtfBars'     && argv[i+1]) { args.mtfBars     = Number(argv[++i]); continue; }
    if (a === '--mtfScore'    && argv[i+1]) { args.mtfScore    = Number(argv[++i]); continue; }
    if (a === '--mtfReduce'   && argv[i+1]) { args.mtfReduce   = Number(argv[++i]); continue; }
    if (a === '--mtfExit')                   { args.mtfExit     = true;              continue; }
    if (a === '--no-mtfExit')                { args.mtfExit     = false;             continue; }
    if (a === '--mtfExitScore'  && argv[i+1]) { args.mtfExitScore   = Number(argv[++i]); continue; }
    if (a === '--mtfExitLoss'   && argv[i+1]) { args.mtfExitMinLoss = Number(argv[++i]); continue; }
    if (a === '--confSizing')                { args.confSizing  = true;              continue; }
    if (a === '--no-confSizing')             { args.confSizing  = false;             continue; }
    if (a === '--confMax'     && argv[i+1]) { args.confSizingMax = Number(argv[++i]); continue; }
    if (a === '--confMin'     && argv[i+1]) { args.confSizingMin = Number(argv[++i]); continue; }
    if (a === '--confMid'     && argv[i+1]) { args.confSizingMid = Number(argv[++i]); continue; }
  }
  return args;
}

// ── Strategy builders ─────────────────────────────────────────────────────────
function getSymbolCfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}
const BUILDERS = {
  RSI:        (s) => new RSIStrategy(getSymbolCfg(s, 'rsi', config.rsi)),
  EMA:        (s) => new EMAStrategy(getSymbolCfg(s, 'ema', config.ema)),
  MACD:       (s) => new MACDStrategy(getSymbolCfg(s, 'macd', config.macd)),
  BB:         (s) => new BollingerBandsStrategy(getSymbolCfg(s, 'bollinger', config.bollinger)),
  Stoch:      (s) => new StochasticStrategy(getSymbolCfg(s, 'stochastic', config.stochastic)),
  ADX:        (s) => new ADXStrategy(getSymbolCfg(s, 'adx', config.adx)),
  CCI:        (s) => new CCIStrategy(getSymbolCfg(s, 'cci', config.cci)),
  Supertrend: (s) => new SupertrendStrategy(getSymbolCfg(s, 'supertrend', config.supertrend)),
  MFI:        (s) => new MFIStrategy(getSymbolCfg(s, 'mfi', config.mfi)),
  OBV:        (s) => new OBVStrategy(getSymbolCfg(s, 'obv', config.obv)),
  PSAR:       (s) => new PSARStrategy(getSymbolCfg(s, 'psar', config.psar)),
  WilliamsR:  (s) => new WilliamsRStrategy(getSymbolCfg(s, 'williamsR', config.williamsR)),
  StochRSI:   (s) => new StochRSIStrategy(getSymbolCfg(s, 'stochRsi', config.stochRsi ?? {})),
  HeikinAshi: (s) => new HeikinAshiStrategy(getSymbolCfg(s, 'heikinAshi', config.heikinAshi ?? {})),
  SR:         (s) => new SupportResistanceStrategy(getSymbolCfg(s, 'supportResistance', config.supportResistance ?? {})),
};
function buildStrategies(symbol) {
  const names = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI'];
  return names.map((n) => { const b = BUILDERS[n]; if (!b) throw new Error(`Unknown strategy: ${n}`); return b(symbol); });
}
function getSignalConfig(symbol) {
  return { minConfidence: config.perSymbol?.[symbol]?.minConfidence ?? config.risk.minConfidence ?? 0.70 };
}
function getRiskConfig(symbol) {
  const s = config.perSymbol?.[symbol];
  return {
    ...config.risk,
    ...(s?.stopLossPct     !== undefined && { stopLossPct:     s.stopLossPct }),
    ...(s?.takeProfitPct   !== undefined && { takeProfitPct:   s.takeProfitPct }),
    ...(s?.trailingStopPct !== undefined && { trailingStopPct: s.trailingStopPct }),
  };
}

// ── Candle loading ────────────────────────────────────────────────────────────
async function loadCandles(symbol, timeframe, count) {
  let cached = await loadCachedCandles(symbol, timeframe);
  if (cached.length >= count) return cached.slice(-count);
  if (cached.length > 0) return cached; // use whatever we have (short history)
  console.log(`  Fetching ${count} ${timeframe} candles for ${symbol}…`);
  try {
    const fresh = await fetchHistoricalOHLCV(symbol, timeframe, count);
    if (fresh.length) {
      await saveCachedCandles(symbol, timeframe, fresh);
      return fresh.slice(-count);
    }
  } catch (err) {
    console.log(`  ⚠️  ${symbol}: fetch failed (${err.constructor?.name ?? err.message}) — skipping`);
  }
  return cached;
}

function median(arr) {
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1] + sorted[mid]) / 2;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const symbols = args.symbols ?? config.symbols;

const featuresEnabled = [
  args.atr        && `ATR sizing (period ${args.atrPeriod})`,
  args.kelly      && `Kelly ×${args.kellyFrac} (window ${args.kellyWindow})`,
  args.regime     && `Regime filter ADX>${args.adxThresh}`,
  args.swap       && `Swap (conf≥${args.swapConf}, minHold=${args.minHold})`,
  args.breakEven  && `Break-even stop @+${(args.breakEven*100).toFixed(0)}%`,
  args.corrFilter && `Correlation filter r>${args.corrThresh}`,
  args.macro      && `Macro filter BTC EMA${args.macroEMA} (reduce×${args.macroReduce})`,
  args.mtf        && `MTF filter 15m×${args.mtfBars} score≥${args.mtfScore}${args.mtfReduce > 0 ? ` reduce×${args.mtfReduce}` : ' (skip)'}`,
  args.mtfExit    && `MTF early exit (score<${args.mtfExitScore}, loss>${(args.mtfExitMinLoss*100).toFixed(0)}%)`,
  args.confSizing && `Conf sizing [${args.confSizingMin}×–${args.confSizingMax}×] mid@${args.confSizingMid}`,
].filter(Boolean);

console.log('\n╔══════════════════════════════════════════════════════════╗');
console.log('║          PORTFOLIO BACKTEST — shared balance             ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log(`  Symbols    : ${symbols.length} coins`);
console.log(`  Budget     : $${args.budget}`);
console.log(`  Max slots  : ${args.slots} concurrent  (~$${(args.budget / args.slots).toFixed(0)}/slot base)`);
console.log(`  Timeframe  : ${args.timeframe}  |  Candles: ${args.candles}`);
console.log(`  Features   : ${featuresEnabled.length ? featuresEnabled.join('  ·  ') : 'baseline (no extras)'}`);
console.log('');

// Load candles
console.log('Loading candles…');
const symbolCandles = {};
let loaded = 0;
for (const sym of symbols) {
  const candles = await loadCandles(sym, args.timeframe, args.candles);
  if (candles.length >= 60) {
    symbolCandles[sym] = candles;
    loaded++;
  } else {
    console.log(`  ⚠️  ${sym}: only ${candles.length} candles — skipped`);
  }
}
console.log(`  ${loaded}/${symbols.length} symbols ready\n`);

// Load 15m candles for MTF filter and/or early exit (graceful if missing)
const mtfSymbolCandles = {};
if (args.mtf || args.mtfExit) {
  const label = [args.mtf && 'entry filter', args.mtfExit && 'early exit'].filter(Boolean).join(' + ');
  console.log(`Loading 15m candles for MTF ${label}…`);
  const { readFileSync, existsSync } = await import('fs');
  for (const sym of symbols) {
    const base = sym.replace('/', '_');
    const path = `data/candles/${base}_15m.json`;
    if (existsSync(path)) {
      mtfSymbolCandles[sym] = JSON.parse(readFileSync(path, 'utf8'));
    }
  }
  const mtfCount = Object.keys(mtfSymbolCandles).length;
  console.log(`  ${mtfCount} symbols have 15m data (${Object.keys(mtfSymbolCandles).map(s => s.replace('/USDC','').replace('/USDC','').replace('/USDT','')).join(', ')})\n`);
}

// Build strategy map
const symbolStrategies = Object.fromEntries(
  Object.keys(symbolCandles).map((sym) => [sym, buildStrategies(sym)])
);

// Use median risk config across symbols as portfolio defaults
const riskValues = symbols.map(s => getRiskConfig(s));
const portfolioRisk = {
  initialBalance:  args.budget,
  stopLossPct:     args.sl ?? median(riskValues.map(r => r.stopLossPct)),
  takeProfitPct:   args.tp ?? median(riskValues.map(r => r.takeProfitPct)),
  trailingStopPct: args.trailing,
  feePct:          0.001,
  slippagePct:     0.001,
};

const trailingLabel = args.trailing > 0 ? `  TrailingStop: ${(args.trailing*100).toFixed(0)}%` : '';
const slLabel = args.sl ? ` (override)` : '';
console.log(`  Risk config: SL=${(portfolioRisk.stopLossPct*100).toFixed(0)}%${slLabel}  TP=${(portfolioRisk.takeProfitPct*100).toFixed(0)}%${slLabel}${trailingLabel}  (median across all symbols)\n`);

// Build backtester
const backtester = new PortfolioBacktester(symbolStrategies, {
  risk:               { ...portfolioRisk, breakEvenTriggerPct: args.breakEven },
  signals:            { minConfidence: median(symbols.map(s => getSignalConfig(s).minConfidence)) },
  maxOpenPositions:   args.slots,
  swapEnabled:        args.swap,
  swapMinConfidence:  args.swapConf,
  swapMinHoldBars:    args.minHold,
  regimeFilter:       args.regime,
  regimeADXThreshold: args.adxThresh,
  atrPositionSizing:  args.atr,
  atrPeriod:          args.atrPeriod,
  kellyEnabled:       args.kelly,
  kellyWindow:        args.kellyWindow,
  kellyFraction:      args.kellyFrac,
  correlationFilter:  args.corrFilter,
  correlationThreshold: args.corrThresh,
  correlationPeriod:  args.corrPeriod,
  macroFilter:        args.macro,
  macroEMAPeriod:     args.macroEMA,
  macroSizeReduceFactor: args.macroReduce,
  mtfFilter:          args.mtf,
  mtfSymbolCandles,
  mtfAlignBars:       args.mtfBars,
  mtfMinScore:        args.mtfScore,
  mtfReduceFactor:    args.mtfReduce,
  mtfEarlyExit:       args.mtfExit,
  mtfEarlyExitScore:  args.mtfExitScore,
  mtfEarlyExitMinLoss: args.mtfExitMinLoss,
  confSizing:         args.confSizing,
  confSizingMid:      args.confSizingMid,
  confSizingMax:      args.confSizingMax,
  confSizingMin:      args.confSizingMin,
});

console.log('Running simulation…');
const t0 = Date.now();
const result = backtester.run(symbolCandles);
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

// ── Print results ─────────────────────────────────────────────────────────────
const m   = result.metrics;
const ret = result.finalBalance - result.initialBalance;
const retPct = (ret / result.initialBalance * 100).toFixed(2);
const retSign = ret >= 0 ? '+' : '';

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  RESULT: $${result.initialBalance} → $${result.finalBalance.toFixed(2)}  (${retSign}${retPct}%)  [${elapsed}s]`);
console.log('══════════════════════════════════════════════════════════');
console.log(`  Trades        : ${m.totalTrades}  (${m.winningTrades}W / ${m.losingTrades}L)`);
console.log(`  Win rate      : ${(m.winRate * 100).toFixed(1)}%`);
console.log(`  Profit factor : ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
console.log(`  Sharpe ratio  : ${m.sharpeRatio.toFixed(2)}`);
console.log(`  Max drawdown  : ${m.maxDrawdownPct}`);
console.log(`  Avg win       : $${m.avgWin.toFixed(2)}   Avg loss: $${m.avgLoss.toFixed(2)}`);
if (result.regimeFilteredCount > 0) {
  console.log(`  Regime skipped: ${result.regimeFilteredCount} BUY signals filtered by ADX<${args.adxThresh}`);
}
if (result.filtersApplied?.mtf > 0) {
  console.log(`  MTF skipped   : ${result.filtersApplied.mtf} BUY signals blocked (15m bearish alignment)`);
}
if (result.filtersApplied?.mtfEarlyExit > 0) {
  console.log(`  MTF early exit: ${result.filtersApplied.mtfEarlyExit} positions closed early (losing + 15m bearish)`);
}
console.log('');
console.log('  Exit reasons:');
for (const [reason, { count, totalPnL }] of Object.entries(m.byReason)) {
  if (count > 0) console.log(`    ${reason.padEnd(16)}: ${String(count).padStart(4)} trades   P&L: ${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}`);
}

// Per-symbol breakdown
const sorted = Object.entries(result.symbolStats)
  .filter(([, s]) => s.trades > 0)
  .sort(([, a], [, b]) => b.pnl - a.pnl);

console.log('\n  Per-symbol P&L (top performers):');
const maxShow = Math.min(sorted.length, 15);
for (const [sym, s] of sorted.slice(0, maxShow)) {
  const pnlStr = `${s.pnl >= 0 ? '+' : ''}$${s.pnl.toFixed(2)}`;
  const wr = s.trades ? `${((s.wins / s.trades) * 100).toFixed(0)}% WR` : '';
  console.log(`    ${sym.replace('/USDC','').replace('/USDT','').padEnd(8)}: ${pnlStr.padStart(9)}   ${s.trades} trades  ${wr}`);
}
if (sorted.length > maxShow) console.log(`    … and ${sorted.length - maxShow} more`);

const inactive = Object.entries(result.symbolStats).filter(([, s]) => s.trades === 0);
if (inactive.length) console.log(`\n  No trades: ${inactive.map(([s]) => s.replace('/USDC','').replace('/USDT','')).join(', ')}`);
console.log('');

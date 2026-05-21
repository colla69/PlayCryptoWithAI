/**
 * Supertrend strategy combination backtest.
 *
 * Tests Supertrend in different combos vs the pure mean-reversion baseline,
 * all with ATR position sizing + regime filter (the current best config).
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/supertrendBacktest.mjs
 *   PAPER_MODE=true node src/scripts/supertrendBacktest.mjs --candles 1460
 */

import 'dotenv/config';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import { loadCachedCandles, saveCachedCandles } from '../exchange/candleCache.js';
import { fetchHistoricalOHLCV } from '../exchange/binanceClient.js';
import {
  ADXStrategy, BollingerBandsStrategy, CCIStrategy,
  EMAStrategy, MACDStrategy, RSIStrategy, StochasticStrategy,
  SupertrendStrategy,
} from '../strategies/index.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let candleCount = 730;
let timeframe   = config.timeframe ?? '12h';
let symbols     = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--candles'   && argv[i+1]) { candleCount = Number(argv[++i]); continue; }
  if (argv[i] === '--timeframe' && argv[i+1]) { timeframe   = argv[++i];         continue; }
  if (argv[i] === '--symbols'   && argv[i+1]) { symbols     = argv[++i].split(',').map(s => s.trim()); continue; }
}

// ── Builders ──────────────────────────────────────────────────────────────────
function cfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}

const BUILDERS = {
  RSI:        (s) => new RSIStrategy(cfg(s, 'rsi', config.rsi)),
  EMA:        (s) => new EMAStrategy(cfg(s, 'ema', config.ema)),
  MACD:       (s) => new MACDStrategy(cfg(s, 'macd', config.macd)),
  BB:         (s) => new BollingerBandsStrategy(cfg(s, 'bollinger', config.bollinger)),
  Stoch:      (s) => new StochasticStrategy(cfg(s, 'stochastic', config.stochastic)),
  ADX:        (s) => new ADXStrategy(cfg(s, 'adx', config.adx)),
  CCI:        (s) => new CCIStrategy(cfg(s, 'cci', config.cci)),
  Supertrend: (s) => new SupertrendStrategy(cfg(s, 'supertrend', config.supertrend)),
};

function buildForCombo(combo) {
  return (symbol) => combo.map((name) => {
    const b = BUILDERS[name];
    if (!b) throw new Error(`Unknown strategy: ${name}`);
    return b(symbol);
  });
}

// ── Candle loading ─────────────────────────────────────────────────────────────
async function loadCandles(symbol) {
  const cached = await loadCachedCandles(symbol, timeframe);
  if (cached.length >= candleCount) return cached.slice(-candleCount);
  console.log(`  Fetching ${candleCount} ${timeframe} candles for ${symbol}…`);
  const fresh = await fetchHistoricalOHLCV(symbol, timeframe, candleCount);
  if (fresh.length > cached.length) {
    await saveCachedCandles(symbol, timeframe, fresh);
    return fresh.slice(-candleCount);
  }
  return cached.length ? cached : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function median(arr) {
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function fp(v, d = 1) { return `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`; }
function pad(v, w, align = 'end') {
  return align === 'start' ? String(v).padEnd(w) : String(v).padStart(w);
}

// ── Combos to test ─────────────────────────────────────────────────────────────
// Supertrend is now flip-only (HOLD during continuation), so it acts as a
// high-conviction 4th vote. With 4 strategies the 0.70 threshold is met at
// 3/4 = 0.75 (majority), letting the 3 core indicators still fire without ST.
const COMBOS = [
  { label: 'Baseline (current config)',         combo: null      },
  { label: 'RSI + BB + Stoch (no ST)',          combo: ['RSI', 'BB', 'Stoch'] },
  { label: 'RSI + BB + CCI (no ST)',            combo: ['RSI', 'BB', 'CCI']   },
  { label: 'RSI + BB + Stoch + ST',             combo: ['RSI', 'BB', 'Stoch', 'Supertrend'] },
  { label: 'RSI + BB + CCI + ST',               combo: ['RSI', 'BB', 'CCI',   'Supertrend'] },
  { label: 'MACD + Stoch + RSI + ST',           combo: ['MACD', 'Stoch', 'RSI', 'Supertrend'] },
  { label: 'ST + MACD + ADX + RSI',             combo: ['Supertrend', 'MACD', 'ADX', 'RSI'] },
  { label: 'RSI + BB + MACD + ST',              combo: ['RSI', 'BB', 'MACD', 'Supertrend'] },
  { label: 'RSI + CCI + MACD + ST',             combo: ['RSI', 'CCI', 'MACD', 'Supertrend'] },
  { label: 'BB + Stoch + MACD + ST',            combo: ['BB', 'Stoch', 'MACD', 'Supertrend'] },
  { label: 'RSI + BB + ADX + ST',               combo: ['RSI', 'BB', 'ADX', 'Supertrend'] },
];

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\n╔═══════════════════════════════════════════════════════════════════╗');
console.log('║            SUPERTREND COMBO BACKTEST — portfolio                 ║');
console.log('╚═══════════════════════════════════════════════════════════════════╝');
console.log(`  Timeframe  : ${timeframe}`);
console.log(`  Candles    : ${candleCount} (≈${(candleCount * (timeframe === '12h' ? 0.5 : timeframe === '1d' ? 1 : 0.25)).toFixed(0)} days)`);
console.log('  Budget     : $1000 | Max slots: 5');
console.log('  Filters    : ATR sizing + regime filter');
console.log('');
console.log('Loading candles…');

const watchList = symbols ?? config.symbols;
const symbolCandles = {};
for (const symbol of watchList) {
  const candles = await loadCandles(symbol);
  if (candles && candles.length >= 60) {
    symbolCandles[symbol] = candles;
  } else {
    console.log(`  ⚠️  ${symbol}: insufficient data — skipped`);
  }
}
const loadedSymbols = Object.keys(symbolCandles);
console.log(`  ${loadedSymbols.length}/${watchList.length} symbols ready\n`);

// Base risk config (median across all symbols)
const riskValues = loadedSymbols.map((s) => {
  const sc = config.perSymbol?.[s];
  return {
    stopLossPct:    sc?.stopLossPct    ?? config.risk?.stopLossPct    ?? 0.07,
    takeProfitPct:  sc?.takeProfitPct  ?? config.risk?.takeProfitPct  ?? 0.15,
    trailingStopPct: sc?.trailingStopPct ?? config.risk?.trailingStopPct ?? 0,
  };
});
const baseRiskConfig = {
  initialBalance:  1000,
  stopLossPct:     median(riskValues.map(r => r.stopLossPct)),
  takeProfitPct:   median(riskValues.map(r => r.takeProfitPct)),
  trailingStopPct: 0,
  feePct:          0.001,
  slippagePct:     0.001,
};
const runConfig = {
  risk:                 baseRiskConfig,
  signals:              { minConfidence: 0.70 },
  maxOpenPositions:     5,
  atrPositionSizing:    true,
  atrPeriod:            14,
  regimeFilter:         true,
  regimeADXThreshold:   20,
  kellyEnabled:         false,
  swapEnabled:          false,
  volumeFilter:         false,
  correlationFilter:    false,
  fearGreedFilter:      false,
  breakEvenTriggerPct:  0,
  atrSLTP:              false,
};

console.log(`  Risk: SL=${(baseRiskConfig.stopLossPct * 100).toFixed(0)}%  TP=${(baseRiskConfig.takeProfitPct * 100).toFixed(0)}%\n`);

const rows = [];

for (const { label, combo } of COMBOS) {
  const startedAt = Date.now();

  // Build per-symbol strategy maps
  let symbolStrategies;
  if (combo === null) {
    // Baseline: use each symbol's own configured strategy list
    symbolStrategies = Object.fromEntries(
      loadedSymbols.map((sym) => {
        const names = config.perSymbol?.[sym]?.strategies ?? config.strategies ?? ['RSI', 'BB', 'Stoch'];
        return [sym, names.map((n) => {
          const b = BUILDERS[n];
          if (!b) throw new Error(`Unknown strategy ${n} for ${sym}`);
          return b(sym);
        })];
      }),
    );
  } else {
    const builder = buildForCombo(combo);
    symbolStrategies = Object.fromEntries(loadedSymbols.map((sym) => [sym, builder(sym)]));
  }

  let result;
  try {
    const backtester = new PortfolioBacktester(symbolStrategies, runConfig);
    result = backtester.run(symbolCandles);
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.message}`);
    rows.push({ label, error: err.message });
    continue;
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const m = result.metrics;
  const returnPct = ((result.finalBalance - result.initialBalance) / result.initialBalance) * 100;

  rows.push({
    label,
    returnPct,
    trades:      m.totalTrades,
    winRate:     m.winRate * 100,
    sharpe:      m.sharpeRatio,
    maxDrawdown: m.maxDrawdownPct,
    profitFactor: m.profitFactor,
    elapsed,
  });
  console.log(`  ✓ ${label} (${elapsed}s)`);
}

// ── Print results table ────────────────────────────────────────────────────────
const validRows = rows.filter(r => !r.error);
const bestReturn  = validRows.reduce((b, r) => r.returnPct > b.returnPct ? r : b, validRows[0]);
const bestSharpe  = validRows.reduce((b, r) => r.sharpe    > b.sharpe    ? r : b, validRows[0]);
const bestDD      = validRows.reduce((b, r) => r.maxDrawdown < b.maxDrawdown ? r : b, validRows[0]);

const LW = Math.max('COMBO'.length, ...rows.map(r => r.label.length)) + 2;

console.log('\n' + '═'.repeat(LW + 63));
console.log(
  `${pad('COMBO', LW, 'start')} | ${pad('RETURN',6,'start')} | ${'TRADES'.padStart(6)} | ${'WR%'.padStart(6)} | ${'SHARPE'.padStart(6)} | ${'MAX DD'.padStart(7)} | ${'PF'.padStart(5)}`,
);
console.log('─'.repeat(LW + 63));

for (const row of rows) {
  if (row.error) {
    console.log(`${pad(row.label, LW, 'start')} | ERROR: ${row.error}`);
    continue;
  }
  const isReturnWin  = row.label === bestReturn.label;
  const isSharpeWin  = row.label === bestSharpe.label;
  const isDDWin      = row.label === bestDD.label;
  const stars = `${isReturnWin ? '★' : ' '}${isSharpeWin ? 'S' : ' '}${isDDWin ? 'D' : ' '}`;
  console.log(
    `${pad(row.label, LW, 'start')} | ${fp(row.returnPct).padStart(6)} | ${String(row.trades).padStart(6)} | ${row.winRate.toFixed(1).padStart(5)}% | ${row.sharpe.toFixed(2).padStart(6)} | ${fp(-row.maxDrawdown).padStart(7)} | ${(row.profitFactor === Infinity ? '∞' : row.profitFactor.toFixed(2)).padStart(5)} ${stars}`,
  );
}

console.log('─'.repeat(LW + 63));
console.log('  ★ = best return  S = best Sharpe  D = lowest drawdown\n');

// ── Ranking ────────────────────────────────────────────────────────────────────
const ranked = [...validRows].sort((a, b) => {
  // Composite score: return + 0.3*sharpe - 0.3*drawdown (normalised)
  const maxRet = Math.max(...validRows.map(r => r.returnPct));
  const maxSh  = Math.max(...validRows.map(r => r.sharpe));
  const maxDD  = Math.max(...validRows.map(r => r.maxDrawdown));
  const score  = (r) =>
    (r.returnPct / (maxRet || 1)) * 0.5 +
    (r.sharpe    / (maxSh  || 1)) * 0.3 +
    (1 - r.maxDrawdown / (maxDD || 1)) * 0.2;
  return score(b) - score(a);
});

console.log('Top 3 combos by composite score (50% return · 30% Sharpe · 20% drawdown):');
ranked.slice(0, 3).forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.label.padEnd(LW - 2)} return=${fp(r.returnPct)}  sharpe=${r.sharpe.toFixed(2)}  maxDD=${fp(-r.maxDrawdown)}`);
});
console.log('');

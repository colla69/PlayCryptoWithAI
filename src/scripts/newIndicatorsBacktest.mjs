/**
 * New indicators backtest: MFI, OBV, PSAR, Williams %R
 *
 * Tests all 4 new indicators in various combos vs the proven baseline,
 * using the same methodology as supertrendBacktest.mjs:
 * ATR sizing + regime filter, 730 candles (≈1 year), $1000 budget, 5 slots.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/newIndicatorsBacktest.mjs
 *   PAPER_MODE=true node src/scripts/newIndicatorsBacktest.mjs --candles 1460
 *   PAPER_MODE=true node src/scripts/newIndicatorsBacktest.mjs --symbols BTC/USDT,ETH/USDT
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
} from '../strategies/index.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let candleCount = 730;
let timeframe   = config.timeframe ?? '12h';
let symbols     = null;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--candles'   && argv[i + 1]) { candleCount = Number(argv[++i]); continue; }
  if (argv[i] === '--timeframe' && argv[i + 1]) { timeframe   = argv[++i];         continue; }
  if (argv[i] === '--symbols'   && argv[i + 1]) { symbols     = argv[++i].split(',').map((s) => s.trim()); continue; }
}

// ── Strategy builders ──────────────────────────────────────────────────────────
function cfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}

const BUILDERS = {
  RSI:       (s) => new RSIStrategy(cfg(s, 'rsi', config.rsi)),
  EMA:       (s) => new EMAStrategy(cfg(s, 'ema', config.ema)),
  MACD:      (s) => new MACDStrategy(cfg(s, 'macd', config.macd)),
  BB:        (s) => new BollingerBandsStrategy(cfg(s, 'bollinger', config.bollinger)),
  Stoch:     (s) => new StochasticStrategy(cfg(s, 'stochastic', config.stochastic)),
  ADX:       (s) => new ADXStrategy(cfg(s, 'adx', config.adx)),
  CCI:       (s) => new CCIStrategy(cfg(s, 'cci', config.cci)),
  ST:        (s) => new SupertrendStrategy(cfg(s, 'supertrend', config.supertrend)),
  MFI:       (s) => new MFIStrategy(cfg(s, 'mfi', config.mfi)),
  OBV:       (s) => new OBVStrategy(cfg(s, 'obv', config.obv)),
  PSAR:      (s) => new PSARStrategy(cfg(s, 'psar', config.psar)),
  WilliamsR: (s) => new WilliamsRStrategy(cfg(s, 'williamsR', config.williamsR)),
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
// Organised into groups by what they're testing. Baseline is the only
// per-symbol combo; all others apply the same strategies to every symbol.
//
// Key insight from Supertrend experiment:
//   3-strategy + conf=0.70 → requires unanimity (3/3=1.0)
//   4-strategy + conf=0.70 → 3/4=0.75 passes (majority)
//   Momentum symbols use conf=0.55 → 2/3=0.67 already passes
const COMBOS = [
  // ── Baseline ────────────────────────────────────────────────────────────────
  { group: 'baseline',  label: 'Baseline (current per-symbol config)', combo: null },

  // ── Mean-reversion: replace 3rd vote ───────────────────────────────────────
  // CCI/Stoch replaced by volume-based or faster oscillator
  { group: 'mr-swap',   label: 'RSI + BB + MFI',                       combo: ['RSI', 'BB', 'MFI']       },
  { group: 'mr-swap',   label: 'RSI + BB + WilliamsR',                 combo: ['RSI', 'BB', 'WilliamsR'] },
  { group: 'mr-swap',   label: 'RSI + MFI + WilliamsR',                combo: ['RSI', 'MFI', 'WilliamsR'] },

  // ── Mean-reversion: add 4th vote (3/4=0.75 > 0.70) ───────────────────────
  { group: 'mr-4th',    label: 'RSI + BB + CCI + MFI',                 combo: ['RSI', 'BB', 'CCI', 'MFI']       },
  { group: 'mr-4th',    label: 'RSI + BB + CCI + WilliamsR',           combo: ['RSI', 'BB', 'CCI', 'WilliamsR'] },
  { group: 'mr-4th',    label: 'RSI + BB + Stoch + MFI',               combo: ['RSI', 'BB', 'Stoch', 'MFI']     },
  { group: 'mr-4th',    label: 'RSI + BB + Stoch + WilliamsR',         combo: ['RSI', 'BB', 'Stoch', 'WilliamsR'] },

  // ── Momentum: swap Stochastic ────────────────────────────────────────────
  { group: 'mom-swap',  label: 'MACD + OBV + RSI',                     combo: ['MACD', 'OBV', 'RSI']           },
  { group: 'mom-swap',  label: 'MACD + WilliamsR + RSI',               combo: ['MACD', 'WilliamsR', 'RSI']     },
  { group: 'mom-swap',  label: 'MACD + MFI + RSI',                     combo: ['MACD', 'MFI', 'RSI']           },
  { group: 'mom-4th',   label: 'MACD + Stoch + RSI + OBV',             combo: ['MACD', 'Stoch', 'RSI', 'OBV']  },

  // ── Trend: swap EMA or add volume confirmation ────────────────────────────
  { group: 'trend-swap', label: 'PSAR + MACD + ADX',                   combo: ['PSAR', 'MACD', 'ADX']           },
  { group: 'trend-4th',  label: 'EMA + MACD + ADX + OBV',              combo: ['EMA', 'MACD', 'ADX', 'OBV']    },
  { group: 'trend-4th',  label: 'PSAR + MACD + ADX + OBV',             combo: ['PSAR', 'MACD', 'ADX', 'OBV']   },
];

// ── Run ───────────────────────────────────────────────────────────────────────
console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║       NEW INDICATORS BACKTEST — MFI / OBV / PSAR / Williams %R      ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');
console.log(`  Timeframe  : ${timeframe}`);
console.log(`  Candles    : ${candleCount} (≈${(candleCount * (timeframe === '12h' ? 0.5 : 1)).toFixed(0)} days)`);
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
    stopLossPct:   sc?.stopLossPct    ?? config.risk?.stopLossPct    ?? 0.07,
    takeProfitPct: sc?.takeProfitPct  ?? config.risk?.takeProfitPct  ?? 0.15,
  };
});
const baseRiskConfig = {
  initialBalance:  1000,
  stopLossPct:     median(riskValues.map((r) => r.stopLossPct)),
  takeProfitPct:   median(riskValues.map((r) => r.takeProfitPct)),
  trailingStopPct: 0,
  feePct:          0.001,
  slippagePct:     0.001,
};
const runConfig = {
  risk:               baseRiskConfig,
  signals:            { minConfidence: 0.70 },
  maxOpenPositions:   5,
  atrPositionSizing:  true,
  atrPeriod:          14,
  regimeFilter:       true,
  regimeADXThreshold: 20,
  kellyEnabled:       false,
  swapEnabled:        false,
  breakEvenTriggerPct: 0,
  atrSLTP:            false,
};

console.log(`  Risk: SL=${(baseRiskConfig.stopLossPct * 100).toFixed(0)}%  TP=${(baseRiskConfig.takeProfitPct * 100).toFixed(0)}%\n`);

const rows = [];

for (const { label, combo } of COMBOS) {
  const startedAt = Date.now();

  let symbolStrategies;
  if (combo === null) {
    // Baseline: each symbol uses its own configured strategy list
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
    trades:       m.totalTrades,
    winRate:      m.winRate * 100,
    sharpe:       m.sharpeRatio,
    maxDrawdown:  m.maxDrawdownPct,
    profitFactor: m.profitFactor,
    elapsed,
  });
  console.log(`  ✓ ${label} (${elapsed}s)`);
}

// ── Results table ─────────────────────────────────────────────────────────────
const validRows = rows.filter((r) => !r.error);
const bestReturn = validRows.reduce((b, r) => r.returnPct  > b.returnPct  ? r : b, validRows[0]);
const bestSharpe = validRows.reduce((b, r) => r.sharpe     > b.sharpe     ? r : b, validRows[0]);
const bestDD     = validRows.reduce((b, r) => r.maxDrawdown < b.maxDrawdown ? r : b, validRows[0]);

const LW = Math.max('COMBO'.length, ...rows.map((r) => r.label.length)) + 2;

console.log('\n' + '═'.repeat(LW + 63));
console.log(
  `${pad('COMBO', LW, 'start')} | ${'RETURN'.padStart(6)} | ${'TRADES'.padStart(6)} | ${'WR%'.padStart(6)} | ${'SHARPE'.padStart(6)} | ${'MAX DD'.padStart(7)} | ${'PF'.padStart(5)}`,
);
console.log('─'.repeat(LW + 63));

for (const row of rows) {
  if (row.error) {
    console.log(`${pad(row.label, LW, 'start')} | ERROR: ${row.error}`);
    continue;
  }
  const stars = [
    row.label === bestReturn.label ? '★' : ' ',
    row.label === bestSharpe.label ? 'S' : ' ',
    row.label === bestDD.label     ? 'D' : ' ',
  ].join('');
  console.log(
    `${pad(row.label, LW, 'start')} | ${fp(row.returnPct).padStart(6)} | ${String(row.trades).padStart(6)} | ${row.winRate.toFixed(1).padStart(5)}% | ${row.sharpe.toFixed(2).padStart(6)} | ${fp(-row.maxDrawdown).padStart(7)} | ${(row.profitFactor === Infinity ? '∞' : row.profitFactor.toFixed(2)).padStart(5)} ${stars}`,
  );
}

console.log('─'.repeat(LW + 63));
console.log('  ★ = best return  S = best Sharpe  D = lowest drawdown\n');

// ── Ranking ────────────────────────────────────────────────────────────────────
const ranked = [...validRows].sort((a, b) => {
  const maxRet = Math.max(...validRows.map((r) => r.returnPct));
  const maxSh  = Math.max(...validRows.map((r) => r.sharpe));
  const maxDD  = Math.max(...validRows.map((r) => r.maxDrawdown));
  const score  = (r) =>
    (r.returnPct  / (maxRet || 1)) * 0.5 +
    (r.sharpe     / (maxSh  || 1)) * 0.3 +
    (1 - r.maxDrawdown / (maxDD || 1)) * 0.2;
  return score(b) - score(a);
});

console.log('Top 5 combos by composite score (50% return · 30% Sharpe · 20% drawdown):');
ranked.slice(0, 5).forEach((r, i) => {
  console.log(`  ${i + 1}. ${r.label.padEnd(LW - 2)}  return=${fp(r.returnPct)}  sharpe=${r.sharpe.toFixed(2)}  maxDD=${fp(-r.maxDrawdown)}`);
});
console.log('');

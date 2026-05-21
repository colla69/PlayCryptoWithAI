import 'dotenv/config';

import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import { loadCachedCandles, saveCachedCandles } from '../exchange/candleCache.js';
import { fetchHistoricalOHLCV } from '../exchange/binanceClient.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import {
  ADXStrategy, BollingerBandsStrategy, CCIStrategy,
  EMAStrategy, MACDStrategy, RSIStrategy, StochasticStrategy,
  SupertrendStrategy,
} from '../strategies/index.js';

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
};

function buildStrategies(symbol) {
  const names = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI'];
  return names.map((name) => {
    const builder = BUILDERS[name];
    if (!builder) throw new Error(`Unknown strategy: ${name}`);
    return builder(symbol);
  });
}

function getSignalConfig(symbol) {
  return { minConfidence: config.perSymbol?.[symbol]?.minConfidence ?? config.risk.minConfidence ?? 0.70 };
}

function getRiskConfig(symbol) {
  const symbolConfig = config.perSymbol?.[symbol];
  return {
    ...config.risk,
    ...(symbolConfig?.stopLossPct !== undefined && { stopLossPct: symbolConfig.stopLossPct }),
    ...(symbolConfig?.takeProfitPct !== undefined && { takeProfitPct: symbolConfig.takeProfitPct }),
    ...(symbolConfig?.trailingStopPct !== undefined && { trailingStopPct: symbolConfig.trailingStopPct }),
  };
}

async function loadCandles(symbol, timeframe, count) {
  const cached = await loadCachedCandles(symbol, timeframe);
  if (cached.length >= count) return cached.slice(-count);

  console.log(`  Fetching ${count} ${timeframe} candles for ${symbol}…`);
  const fresh = await fetchHistoricalOHLCV(symbol, timeframe, count);
  if (fresh.length) {
    await saveCachedCandles(symbol, timeframe, fresh);
    return fresh.slice(-count);
  }
  return cached;
}

function median(arr) {
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatPercent(value, digits = 2) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function formatRatio(value) {
  return value === Infinity ? '∞' : value.toFixed(2);
}

function pad(value, width, align = 'end') {
  return align === 'start' ? String(value).padEnd(width) : String(value).padStart(width);
}

function getEnabledNewFeatures(extra) {
  const enabled = [];
  if (Number(extra.breakEvenTriggerPct ?? 0) > 0) enabled.push('breakEvenTriggerPct');
  if (extra.volumeFilter) enabled.push('volumeFilter');
  if (extra.atrSLTP) enabled.push('atrSLTP');
  if (extra.correlationFilter) enabled.push('correlationFilter');
  if (extra.fearGreedFilter) enabled.push('fearGreedFilter');
  return enabled;
}

function disableFeature(extra, feature) {
  const next = { ...extra };
  if (feature === 'breakEvenTriggerPct') next.breakEvenTriggerPct = 0;
  if (feature === 'volumeFilter') next.volumeFilter = false;
  if (feature === 'atrSLTP') next.atrSLTP = false;
  if (feature === 'correlationFilter') next.correlationFilter = false;
  if (feature === 'fearGreedFilter') next.fearGreedFilter = false;
  return next;
}

function createRunConfig(baseConfig, fgData, extra) {
  return {
    ...baseConfig,
    ...extra,
    fearGreedData: fgData,
  };
}

function runSingleBacktest(symbolCandles, runConfig) {
  const symbolStrategies = Object.fromEntries(
    Object.keys(symbolCandles).map((sym) => [sym, buildStrategies(sym)]),
  );
  const backtester = new PortfolioBacktester(symbolStrategies, runConfig);
  try {
    return backtester.run(symbolCandles);
  } finally {
    for (const aggregator of Object.values(backtester.aggregators ?? {})) {
      aggregator.destroy?.();
    }
  }
}

function runWithFallback(label, symbolCandles, baseConfig, fgData, extra) {
  let activeExtra = { ...extra };
  const disabledFeatures = [];

  while (true) {
    try {
      const result = runSingleBacktest(symbolCandles, createRunConfig(baseConfig, fgData, activeExtra));
      return { result, disabledFeatures, effectiveExtra: activeExtra };
    } catch (error) {
      const nextFeature = getEnabledNewFeatures(activeExtra).find((feature) => !disabledFeatures.includes(feature));
      if (!nextFeature) throw error;
      disabledFeatures.push(nextFeature);
      activeExtra = disableFeature(activeExtra, nextFeature);
      console.warn(`⚠️  ${label}: disabled ${nextFeature} after error: ${error.message}`);
    }
  }
}

const comparisons = [
  { label: 'Baseline', extra: {} },
  { label: '+BreakEven 5%', extra: { breakEvenTriggerPct: 0.05 } },
  { label: '+BreakEven 8%', extra: { breakEvenTriggerPct: 0.08 } },
  { label: '+VolumeFilter 1.5×', extra: { volumeFilter: true } },
  { label: '+ATR SL/TP 1.5×/3×', extra: { atrSLTP: true } },
  { label: '+ATR SL/TP 2×/4×', extra: { atrSLTP: true, atrSLMultiplier: 2, atrTPMultiplier: 4 } },
  { label: '+Correlation', extra: { correlationFilter: true } },
  { label: '+F&G < 50', extra: { fearGreedFilter: true, fearGreedThreshold: 50 } },
  { label: '+F&G < 40', extra: { fearGreedFilter: true, fearGreedThreshold: 40 } },
  { label: 'ATR+Kelly+Regime (prev)', extra: { atrPositionSizing: true, kellyEnabled: true, regimeFilter: true } },
  { label: 'All new combined', extra: { breakEvenTriggerPct: 0.05, volumeFilter: true, atrSLTP: true, correlationFilter: true, fearGreedFilter: true, fearGreedThreshold: 50 } },
  { label: 'All new + prev best', extra: { breakEvenTriggerPct: 0.05, volumeFilter: true, atrSLTP: true, correlationFilter: true, fearGreedFilter: true, fearGreedThreshold: 50, atrPositionSizing: true, kellyEnabled: true, regimeFilter: true } },
];

console.log('\n╔════════════════════════════════════════════════════════════════════╗');
console.log('║                 STRATEGY COMPARISON — portfolio                   ║');
console.log('╚════════════════════════════════════════════════════════════════════╝');
console.log(`  Symbols    : ${config.symbols.length} coins`);
console.log('  Budget     : $1000');
console.log('  Max slots  : 5');
console.log(`  Timeframe  : ${config.timeframe}`);
console.log('  Candles    : 730');
console.log('');
console.log('Loading candles…');

const symbolCandles = {};
for (const symbol of config.symbols) {
  const candles = await loadCandles(symbol, config.timeframe, 730);
  if (candles.length >= 60) {
    symbolCandles[symbol] = candles;
  } else {
    console.log(`  ⚠️  ${symbol}: only ${candles.length} candles — skipped`);
  }
}

const loadedSymbols = Object.keys(symbolCandles);
console.log(`  ${loadedSymbols.length}/${config.symbols.length} symbols ready`);

let fearGreedData = null;
try {
  fearGreedData = await loadFearGreedHistory();
  console.log(`  Fear & Greed: ${fearGreedData ? `${fearGreedData.length} cached points` : 'unavailable (neutral fallback)'}`);
} catch (error) {
  console.log(`  Fear & Greed: unavailable (${error.message})`);
}
console.log('');

const riskValues = loadedSymbols.map((symbol) => getRiskConfig(symbol));
const baseConfig = {
  risk: {
    initialBalance: 1000,
    stopLossPct: median(riskValues.map((risk) => risk.stopLossPct)),
    takeProfitPct: median(riskValues.map((risk) => risk.takeProfitPct)),
    trailingStopPct: 0,
    feePct: 0.001,
    slippagePct: 0.001,
  },
  signals: {
    minConfidence: median(loadedSymbols.map((symbol) => getSignalConfig(symbol).minConfidence)),
  },
  maxOpenPositions: 5,
  volumeFilter: false,
  volumePeriod: 20,
  volumeMultiplier: 1.5,
  atrSLTP: false,
  atrSLMultiplier: 1.5,
  atrTPMultiplier: 3.0,
  correlationFilter: false,
  correlationThreshold: 0.8,
  fearGreedFilter: false,
  fearGreedThreshold: 50,
  breakEvenTriggerPct: 0,
  atrPositionSizing: false,
  atrPeriod: 14,
  kellyEnabled: false,
  kellyWindow: 20,
  kellyFraction: 0.25,
  regimeFilter: false,
  regimeADXThreshold: config.regime?.adxThreshold ?? 20,
  swapEnabled: false,
  swapMinConfidence: 0.75,
  swapMinHoldBars: 3,
};

console.log(`  Risk config: SL=${(baseConfig.risk.stopLossPct * 100).toFixed(0)}%  TP=${(baseConfig.risk.takeProfitPct * 100).toFixed(0)}%`);
console.log('');

const rows = [];
const notes = [];
for (const comparison of comparisons) {
  const startedAt = Date.now();
  const { result, disabledFeatures } = runWithFallback(
    comparison.label,
    symbolCandles,
    baseConfig,
    fearGreedData,
    comparison.extra,
  );
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const metrics = result.metrics;
  const returnPct = ((result.finalBalance - result.initialBalance) / result.initialBalance) * 100;
  rows.push({
    label: comparison.label,
    returnPct,
    trades: metrics.totalTrades,
    winRate: metrics.winRate * 100,
    sharpe: metrics.sharpeRatio,
    maxDrawdown: metrics.maxDrawdownPct,
    profitFactor: metrics.profitFactor,
    disabledFeatures,
    elapsed,
  });
  if (disabledFeatures.length) {
    notes.push(`${comparison.label}: disabled ${disabledFeatures.join(', ')}`);
  }
  console.log(`  ✓ ${comparison.label} (${elapsed}s)`);
}

const bestReturn = rows.reduce((best, row) => (row.returnPct > best.returnPct ? row : best), rows[0]);
const bestSharpe = rows.reduce((best, row) => (row.sharpe > best.sharpe ? row : best), rows[0]);

const labelWidth = Math.max('CONFIG'.length, ...rows.map((row) => row.label.length)) + 2;
const returnWidth = 'RETURN'.length;
const tradesWidth = 'TRADES'.length;
const winRateWidth = 'WR'.length;
const sharpeWidth = 'SHARPE'.length;
const drawdownWidth = 'MAX DD'.length;
const pfWidth = 'PROFIT FACTOR'.length;

console.log('\nComparison table:');
console.log(
  `${pad('CONFIG', labelWidth, 'start')} | ${pad('RETURN', returnWidth, 'start')} | ${pad('TRADES', tradesWidth)} | ${pad('WR', winRateWidth)} | ${pad('SHARPE', sharpeWidth)} | ${pad('MAX DD', drawdownWidth)} | ${pad('PROFIT FACTOR', pfWidth)}`,
);
console.log('-'.repeat(labelWidth + returnWidth + tradesWidth + winRateWidth + sharpeWidth + drawdownWidth + pfWidth + 18));
for (const row of rows) {
  const returnCell = `${formatPercent(row.returnPct)}${row.label === bestReturn.label ? ' ★' : ''}`;
  const sharpeCell = `${row.sharpe.toFixed(2)}${row.label === bestSharpe.label ? ' ★' : ''}`;
  console.log(
    `${pad(row.label, labelWidth, 'start')} | ${pad(returnCell, returnWidth, 'start')} | ${pad(row.trades, tradesWidth)} | ${pad(`${row.winRate.toFixed(1)}%`, winRateWidth)} | ${pad(sharpeCell, sharpeWidth)} | ${pad(row.maxDrawdown, drawdownWidth)} | ${pad(formatRatio(row.profitFactor), pfWidth)}`,
  );
}

if (!fearGreedData) {
  notes.push('Fear & Greed data unavailable; F&G filters used neutral fallback (50).');
}

if (notes.length) {
  console.log('\nNotes:');
  for (const note of notes) console.log(`  - ${note}`);
}

import fs from 'fs/promises';
import config from '../../config/default.js';
import { BacktestSimulator } from '../backtester/backtestSimulator.js';
import { calculateMetrics } from '../backtester/metrics.js';
import { RSIStrategy } from '../strategies/rsi.js';
import { EMAStrategy } from '../strategies/ema.js';
import { MACDStrategy } from '../strategies/macd.js';
import { BollingerBandsStrategy } from '../strategies/bollingerBands.js';
import { StochasticStrategy } from '../strategies/stochastic.js';

const MIN_WARMUP_CANDLES = 50;
const MAX_CANDLES = 4000;
const TIMEFRAME = '4h';
const YEARS = 2;
const SYMBOLS = Array.isArray(config.symbols) ? config.symbols : [];
const CONFIDENCE_VARIANTS = [0.55, 0.65];
const RISK_PRESETS = [
  {
    key: 'conservative',
    label: 'con',
    stopLossPct: 0.02,
    takeProfitPct: 0.05,
    trailingStopPct: 0.015,
    feePct: 0.001,
    slippagePct: 0.001,
  },
  {
    key: 'moderate',
    label: 'mod',
    stopLossPct: 0.03,
    takeProfitPct: 0.07,
    trailingStopPct: 0.02,
    feePct: 0.001,
    slippagePct: 0.001,
  },
  {
    key: 'aggressive',
    label: 'agg',
    stopLossPct: 0.04,
    takeProfitPct: 0.1,
    trailingStopPct: 0.025,
    feePct: 0.001,
    slippagePct: 0.001,
  },
];
const STRATEGY_POOL = {
  RSI: () => new RSIStrategy({ period: 14, oversold: 30, overbought: 70 }),
  EMA: () => new EMAStrategy({ fast: 12, slow: 26 }),
  MACD: () => new MACDStrategy(),
  BB: () => new BollingerBandsStrategy(),
  Stoch: () => new StochasticStrategy(),
};
const STRATEGY_NAMES = Object.keys(STRATEGY_POOL);
const STRATEGY_COMBINATIONS = [
  ['RSI'],
  ['EMA'],
  ['MACD'],
  ['BB'],
  ['Stoch'],
  ['RSI', 'EMA'],
  ['RSI', 'MACD'],
  ['RSI', 'BB'],
  ['RSI', 'Stoch'],
  ['EMA', 'MACD'],
  ['EMA', 'BB'],
  ['EMA', 'Stoch'],
  ['MACD', 'BB'],
  ['MACD', 'Stoch'],
  ['BB', 'Stoch'],
  ['RSI', 'EMA', 'MACD'],
  ['RSI', 'EMA', 'BB'],
  ['RSI', 'EMA', 'Stoch'],
  ['RSI', 'MACD', 'BB'],
  ['EMA', 'MACD', 'Stoch'],
  ['MACD', 'BB', 'Stoch'],
  ['RSI', 'BB', 'Stoch'],
  ['RSI', 'EMA', 'MACD', 'BB'],
  ['RSI', 'EMA', 'MACD', 'Stoch'],
  ['EMA', 'MACD', 'BB', 'Stoch'],
  ['RSI', 'EMA', 'MACD', 'BB', 'Stoch'],
];
const RESULTS_URL = new URL('../../data/optimization_results.json', import.meta.url);
const RESULTS_FILE = 'data/optimization_results.json';

async function loadCandles(symbol, timeframe) {
  const safe = symbol.replace('/', '_');
  const file = new URL(`../../data/candles/${safe}_${timeframe}.json`, import.meta.url);
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw);
}

function score(metrics) {
  if (metrics.maxDrawdown > 0.3) {
    return Number.NEGATIVE_INFINITY;
  }

  if (metrics.totalTrades < 10) {
    return -100;
  }

  const calmar = metrics.maxDrawdown > 0 ? metrics.totalReturn / metrics.maxDrawdown : 0;
  const sharpe = Number.isFinite(metrics.sharpeRatio) ? metrics.sharpeRatio : 0;
  const pf = Math.min(Number.isFinite(metrics.profitFactor) ? metrics.profitFactor : 0, 5);

  return Number((
    sharpe * 0.3 +
    calmar * 0.25 +
    metrics.winRate * 0.2 +
    pf * 0.1 +
    Math.min(metrics.totalReturn, 2) * 0.15
  ).toFixed(4));
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatPct(value, digits = 1, signed = false) {
  const numeric = Number(value ?? 0);
  const prefix = signed && numeric > 0 ? '+' : '';
  return `${prefix}${(numeric * 100).toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  return Number(value ?? 0).toFixed(digits);
}

function formatCell(value, width, align = 'left') {
  const stringValue = String(value);

  if (stringValue.length >= width) {
    return stringValue.slice(0, width);
  }

  return align === 'right'
    ? stringValue.padStart(width, ' ')
    : stringValue.padEnd(width, ' ');
}

function buildProgressBar(current, total, width = 30) {
  const ratio = total === 0 ? 0 : current / total;
  const filled = Math.round(ratio * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}] ${current}/${total}`;
}

function updateProgress(current, total) {
  if (current !== total && current % 10 !== 0) {
    return;
  }

  process.stdout.write(`\r${buildProgressBar(current, total)}`);
}

function aggregateDecision(signals, minConfidence) {
  const votes = { BUY: 0, SELL: 0, HOLD: 0 };

  for (const signal of signals) {
    votes[signal] = (votes[signal] ?? 0) + 1;
  }

  const rankedSignals = Object.entries(votes).sort((left, right) => right[1] - left[1]);
  const [winningSignal = 'HOLD', winningVotes = 0] = rankedSignals[0] ?? [];
  const tie = rankedSignals.filter(([, count]) => Math.abs(count - winningVotes) < 1e-9).length > 1;
  const confidence = Number((winningVotes / (signals.length || 1)).toFixed(2));

  if (tie || winningSignal === 'HOLD' || confidence < minConfidence) {
    return { decision: 'HOLD', confidence };
  }

  return { decision: winningSignal, confidence };
}

async function precomputeSignals(candles) {
  const cache = {};

  for (const strategyName of STRATEGY_NAMES) {
    const strategy = STRATEGY_POOL[strategyName]();
    const signals = Array(candles.length).fill('HOLD');

    for (let index = MIN_WARMUP_CANDLES; index < candles.length; index += 1) {
      signals[index] = strategy.analyze(candles.slice(0, index + 1)).signal;
    }

    cache[strategyName] = signals;
  }

  return cache;
}

async function runOne(strategyNames, candles, signalCache, symbol, riskConfig, minConfidence) {
  const simulator = new BacktestSimulator(riskConfig);

  for (let index = MIN_WARMUP_CANDLES; index < candles.length; index += 1) {
    const candle = candles[index];
    const decision = aggregateDecision(
      strategyNames.map((strategyName) => signalCache[strategyName]?.[index] ?? 'HOLD'),
      minConfidence,
    );

    simulator.setTimestamp(candle.timestamp);
    simulator.execute(symbol, decision.decision, Number(candle.close));
  }

  const trades = simulator.getTrades();
  const equityCurve = simulator.getEquityCurve();
  const metrics = calculateMetrics(trades, equityCurve, simulator.initialBalance);
  const status = simulator.getStatus();

  return {
    ...metrics,
    finalBalance: equityCurve.at(-1)?.balance ?? simulator.initialBalance,
    initialBalance: simulator.initialBalance,
    totalFees: status.totalFees,
  };
}

function aggregateMetrics(perSymbol) {
  const completed = perSymbol.filter((entry) => entry.status === 'ok');

  if (completed.length === 0) {
    return null;
  }

  const totalTrades = completed.reduce((sum, entry) => sum + entry.metrics.totalTrades, 0);
  const winningTrades = completed.reduce((sum, entry) => sum + entry.metrics.winningTrades, 0);
  const losingTrades = completed.reduce((sum, entry) => sum + entry.metrics.losingTrades, 0);
  const totalPnL = completed.reduce((sum, entry) => sum + entry.metrics.totalPnL, 0);
  const totalFees = completed.reduce((sum, entry) => sum + Number(entry.metrics.totalFees ?? 0), 0);
  const avgTradeDurationMs = average(completed.map((entry) => entry.metrics.avgTradeDurationMs));
  const averageReturn = average(completed.map((entry) => entry.metrics.totalReturn));
  const averageDrawdown = average(completed.map((entry) => entry.metrics.maxDrawdown));

  return {
    symbolsTested: completed.length,
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: totalTrades > 0 ? winningTrades / totalTrades : 0,
    totalReturn: averageReturn,
    totalReturnPct: formatPct(averageReturn, 2, true),
    totalPnL: Number(totalPnL.toFixed(2)),
    totalFees: Number(totalFees.toFixed(2)),
    avgWin: Number(average(completed.map((entry) => entry.metrics.avgWin)).toFixed(2)),
    avgLoss: Number(average(completed.map((entry) => entry.metrics.avgLoss)).toFixed(2)),
    profitFactor: Number(average(completed.map((entry) => Number.isFinite(entry.metrics.profitFactor) ? entry.metrics.profitFactor : 0)).toFixed(4)),
    maxDrawdown: averageDrawdown,
    maxDrawdownPct: formatPct(averageDrawdown, 2),
    sharpeRatio: Number(average(completed.map((entry) => entry.metrics.sharpeRatio)).toFixed(4)),
    avgTradeDurationMs: Number(avgTradeDurationMs.toFixed(0)),
    finalBalance: Number(average(completed.map((entry) => entry.metrics.finalBalance)).toFixed(2)),
    initialBalance: Number(average(completed.map((entry) => entry.metrics.initialBalance)).toFixed(2)),
  };
}

function printTopTable(topResults) {
  const divider = '──────────────────────────────────────────────────────────────────────';
  console.log('');
  console.log(' TOP 10 CONFIGURATIONS (ranked by composite live-trading score)');
  console.log(divider);
  console.log(' Rank │ Strategies          │ Risk   │ Conf │ Score │ Sharpe │ Win%  │ MaxDD  │ Return │ Trades');
  console.log(divider);

  for (const [index, result] of topResults.entries()) {
    console.log([
      formatCell(index + 1, 5, 'right'),
      '│',
      formatCell(result.strategyLabel, 19),
      '│',
      formatCell(result.riskPresetLabel, 6),
      '│',
      formatCell(result.minConfidence.toFixed(2), 4, 'right'),
      '│',
      formatCell(result.score.toFixed(2), 5, 'right'),
      '│',
      formatCell(formatNumber(result.metrics.sharpeRatio), 6, 'right'),
      '│',
      formatCell(formatPct(result.metrics.winRate), 5, 'right'),
      '│',
      formatCell(formatPct(result.metrics.maxDrawdown), 5, 'right'),
      '│',
      formatCell(formatPct(result.metrics.totalReturn, 1, true), 6, 'right'),
      '│',
      formatCell(result.metrics.totalTrades, 6, 'right'),
    ].join(' '));
  }
}

function printBestDetails(best) {
  const frictionPerSide = (best.risk.feePct + best.risk.slippagePct) * 100;
  console.log('');
  console.log(' BEST CONFIGURATION DETAILS');
  console.log('──────────────────────────────────────────────────────────────────────');
  console.log(` Strategies : ${best.strategies.join(' + ')}`);
  console.log(` Risk preset: ${best.riskPreset} (SL=${formatPct(best.risk.stopLossPct)} TP=${formatPct(best.risk.takeProfitPct)} trailing=${formatPct(best.risk.trailingStopPct)})`);
  console.log(` Min confidence: ${best.minConfidence.toFixed(2)}`);
  console.log(` Friction applied: ${frictionPerSide.toFixed(1)}% per side (fee ${(best.risk.feePct * 100).toFixed(1)}% + slippage ${(best.risk.slippagePct * 100).toFixed(1)}%)`);
  console.log('');
  console.log(' Per-symbol breakdown:');

  for (const entry of best.perSymbol) {
    if (entry.status !== 'ok') {
      console.log(`   ${entry.symbol.padEnd(9, ' ')} skipped (${entry.reason})`);
      continue;
    }

    console.log(
      `   ${entry.symbol.padEnd(9, ' ')} Sharpe=${formatNumber(entry.metrics.sharpeRatio)}  Win=${formatPct(entry.metrics.winRate)}  DD=${formatPct(entry.metrics.maxDrawdown)}  Return=${formatPct(entry.metrics.totalReturn, 1, true)}  Trades=${entry.metrics.totalTrades}`,
    );
  }

  console.log('');
  console.log(' WORST-CASE NOTES:');
  console.log(' • Break-even per round trip: 0.40% (fee 0.20% + slippage 0.20%)');
  console.log(' • A 60% win rate with avg win/loss ratio of 2:1 gives expected value > 0 after friction');
  console.log(' • Drawdown < 15% suggests the strategy can survive typical bear markets');
  console.log('');
  console.log(' RECOMMENDED config/default.js changes:');
  console.log(`   strategies: [${best.strategies.map((name) => `'${name}'`).join(', ')}]`);
  console.log(`   minConfidence: ${best.minConfidence.toFixed(2)}`);
  console.log(`   stopLossPct: ${best.risk.stopLossPct}`);
  console.log(`   takeProfitPct: ${best.risk.takeProfitPct}`);
  console.log(`   trailingStopPct: ${best.risk.trailingStopPct}`);
}

async function main() {
  const candlesBySymbol = new Map();
  const signalCacheBySymbol = new Map();

  for (const symbol of SYMBOLS) {
    try {
      const candles = await loadCandles(symbol, TIMEFRAME);
      const trimmedCandles = Array.isArray(candles) ? candles.slice(-MAX_CANDLES) : [];

      candlesBySymbol.set(symbol, trimmedCandles);

      if (trimmedCandles.length >= MIN_WARMUP_CANDLES) {
        console.log(`Precomputing signals for ${symbol} (${trimmedCandles.length} candles)…`);
        signalCacheBySymbol.set(symbol, await precomputeSignals(trimmedCandles));
      } else {
        console.warn(`Warning: skipping ${symbol} (not enough candles)`);
      }
    } catch (error) {
      console.warn(`Warning: skipping ${symbol} (${error.message})`);
    }
  }

  const totalRuns = STRATEGY_COMBINATIONS.length * RISK_PRESETS.length * CONFIDENCE_VARIANTS.length * SYMBOLS.length;
  const results = [];
  let completedRuns = 0;

  console.log(`Optimizing ${totalRuns} configurations across ${SYMBOLS.length} symbols…`);

  for (const strategyNames of STRATEGY_COMBINATIONS) {
    for (const riskPreset of RISK_PRESETS) {
      for (const minConfidence of CONFIDENCE_VARIANTS) {
        const perSymbol = [];

        for (const symbol of SYMBOLS) {
          const candles = candlesBySymbol.get(symbol);
          const signalCache = signalCacheBySymbol.get(symbol);

          if (!candles?.length || !signalCache) {
            perSymbol.push({ symbol, status: 'skipped', reason: 'missing candles' });
            completedRuns += 1;
            updateProgress(completedRuns, totalRuns);
            continue;
          }

          const metrics = await runOne(strategyNames, candles, signalCache, symbol, {
            ...config.risk,
            ...riskPreset,
          }, minConfidence);

          perSymbol.push({ symbol, status: 'ok', metrics });
          completedRuns += 1;
          updateProgress(completedRuns, totalRuns);
        }

        const aggregatedMetrics = aggregateMetrics(perSymbol);

        if (!aggregatedMetrics) {
          continue;
        }

        results.push({
          strategies: [...strategyNames],
          strategyLabel: strategyNames.join('+'),
          riskPreset: riskPreset.key,
          riskPresetLabel: riskPreset.label,
          risk: { ...riskPreset },
          minConfidence,
          metrics: aggregatedMetrics,
          perSymbol,
          score: score(aggregatedMetrics),
        });
      }
    }
  }

  process.stdout.write('\n');

  const rankedResults = results
    .sort((left, right) => right.score - left.score)
    .map((result, index) => ({ ...result, rank: index + 1 }));
  const top10 = rankedResults.slice(0, 10);
  const best = rankedResults[0];

  if (!best) {
    throw new Error('No optimization results were produced');
  }

  const output = {
    runAt: new Date().toISOString(),
    params: {
      timeframe: TIMEFRAME,
      years: YEARS,
      maxCandles: MAX_CANDLES,
      friction: '0.4% round trip',
      symbols: SYMBOLS,
      combinations: STRATEGY_COMBINATIONS.length,
      riskVariants: RISK_PRESETS.length,
      confidenceVariants: CONFIDENCE_VARIANTS,
      totalRuns,
    },
    top10,
    best: {
      strategies: best.strategies,
      riskPreset: best.riskPreset,
      risk: best.risk,
      minConfidence: best.minConfidence,
      score: best.score,
      metrics: best.metrics,
      perSymbol: best.perSymbol,
    },
    allResults: rankedResults,
  };

  await fs.writeFile(RESULTS_URL, JSON.stringify(output, null, 2));

  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(' BACKTEST OPTIMIZATION RESULTS (2 years · 4h · 5 symbols · worst-case friction)');
  console.log('══════════════════════════════════════════════════════════════════════');
  printTopTable(top10);
  printBestDetails(best);
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`Saved full results to ${RESULTS_FILE}`);
}

main().catch((error) => {
  console.error(`Optimization failed: ${error.message}`);
  process.exit(1);
});

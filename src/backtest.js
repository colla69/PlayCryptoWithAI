import 'dotenv/config';
import config from '../config/default.js';
import { Backtester, calculateMetrics, printReport, saveReport } from './backtester/index.js';
import { fetchOHLCV } from './exchange/binanceClient.js';
import {
  ADXStrategy,
  BollingerBandsStrategy,
  CCIStrategy,
  EMAStrategy,
  MACDStrategy,
  RSIStrategy,
  StochasticStrategy,
} from './strategies/index.js';

function parseArgs(argv) {
  const args = {
    symbol: config.symbols[0],
    timeframe: config.timeframe,
    limit: 500,
    trailing: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--symbol' && argv[index + 1]) {
      args.symbol = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--timeframe' && argv[index + 1]) {
      args.timeframe = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--limit' && argv[index + 1]) {
      args.limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--trailing') {
      args.trailing = true;
    }
  }

  return args;
}

function getStrategyConfigForSymbol(symbol, key, defaults) {
  return {
    ...defaults,
    ...(config.perSymbol?.[symbol]?.[key] ?? {}),
  };
}

const STRATEGY_BUILDERS = {
  RSI: (symbol) => new RSIStrategy(getStrategyConfigForSymbol(symbol, 'rsi', config.rsi)),
  EMA: (symbol) => new EMAStrategy(getStrategyConfigForSymbol(symbol, 'ema', config.ema)),
  MACD: (symbol) => new MACDStrategy(getStrategyConfigForSymbol(symbol, 'macd', config.macd)),
  BB: (symbol) => new BollingerBandsStrategy(getStrategyConfigForSymbol(symbol, 'bollinger', config.bollinger)),
  Stoch: (symbol) => new StochasticStrategy(getStrategyConfigForSymbol(symbol, 'stochastic', config.stochastic)),
  ADX: (symbol) => new ADXStrategy(getStrategyConfigForSymbol(symbol, 'adx', config.adx)),
  CCI: (symbol) => new CCIStrategy(getStrategyConfigForSymbol(symbol, 'cci', config.cci)),
};

function buildStrategiesForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  const strategyNames = Array.isArray(symCfg?.strategies) && symCfg.strategies.length
    ? symCfg.strategies
    : Array.isArray(config.strategies) && config.strategies.length
      ? config.strategies
      : ['RSI', 'EMA'];

  return strategyNames.map((name) => {
    const buildStrategy = STRATEGY_BUILDERS[name];

    if (!buildStrategy) {
      throw new Error(`Unknown strategy configured: ${name}`);
    }

    return buildStrategy(symbol);
  });
}

function getRiskForSymbol(symbol, trailingEnabled = false) {
  const symCfg = config.perSymbol?.[symbol];
  const risk = {
    ...config.risk,
    ...(symCfg?.stopLossPct !== undefined && { stopLossPct: symCfg.stopLossPct }),
    ...(symCfg?.takeProfitPct !== undefined && { takeProfitPct: symCfg.takeProfitPct }),
    ...(symCfg?.trailingStopPct !== undefined && { trailingStopPct: symCfg.trailingStopPct }),
  };

  return {
    ...risk,
    trailingStopPct: trailingEnabled ? risk.trailingStopPct : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candles = await fetchOHLCV(args.symbol, args.timeframe, args.limit);
  const strategies = buildStrategiesForSymbol(args.symbol);
  const backtester = new Backtester(strategies, {
    signals: config.signals,
    risk: getRiskForSymbol(args.symbol, args.trailing),
  });

  const result = await backtester.run(args.symbol, candles);
  const metrics = calculateMetrics(result.trades, result.equityCurve, result.initialBalance);

  printReport(args.symbol, metrics, {
    timeframe: args.timeframe,
    trailing: args.trailing,
  });

  const reportPath = await saveReport(args.symbol, metrics, result.trades, {
    timeframe: args.timeframe,
    limit: args.limit,
    trailing: args.trailing,
    risk: getRiskForSymbol(args.symbol, args.trailing),
  });

  console.log(`Saved report: ${reportPath}`);
}

main().catch((error) => {
  console.error(`Backtest failed: ${error.message}`);
  process.exit(1);
});

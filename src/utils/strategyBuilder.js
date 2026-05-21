import config from '../../config/default.js';
import {
  ADXStrategy,
  BollingerBandsStrategy,
  CCIStrategy,
  EMAStrategy,
  MACDStrategy,
  RSIStrategy,
  StochasticStrategy,
  SupertrendStrategy,
  MFIStrategy,
  OBVStrategy,
  PSARStrategy,
  WilliamsRStrategy,
} from '../strategies/index.js';

const STRATEGY_REASON_PREFIX = {
  RSI:            'rsi',
  EMA:            'ema',
  MACD:           'macd',
  BollingerBands: 'bb',
  Stochastic:     'stoch',
  ADX:            'adx',
  CCI:            'cci',
  Supertrend:     'supertrend',
  MFI:            'mfi',
  OBV:            'obv',
  PSAR:           'psar',
  WilliamsR:      'williamsR',
};

const STRATEGY_TRIGGER_HINTS = {
  RSI:        'RSI < 30 → BUY (oversold) · RSI > 70 → SELL (overbought)',
  BB:         'Price touches lower Bollinger Band → BUY · upper band → SELL',
  MACD:       'MACD line crosses above signal line → BUY · below → SELL',
  Stoch:      'Stochastic K crosses above D below 20 → BUY · above 80 → SELL',
  EMA:        'Fast EMA crosses above slow EMA → BUY · below → SELL',
  ADX:        'ADX > 25 confirms trend; direction from price vs EMA',
  CCI:        'CCI crosses above −100 from oversold → BUY · below +100 from overbought → SELL',
  Supertrend: 'Supertrend flips bullish → BUY · flips bearish → SELL',
  MFI:        'MFI < 20 + turning up → BUY (oversold volume reversal) · MFI > 80 + turning down → SELL',
  OBV:        'OBV crosses above EMA-20 → BUY (volume buyers) · crosses below → SELL',
  PSAR:       'Parabolic SAR flips below price → BUY · flips above price → SELL',
  WilliamsR:  '%R < −80 + turning up → BUY (oversold) · %R > −20 + turning down → SELL',
};

function getStrategyConfigForSymbol(symbol, key, defaults) {
  return {
    ...defaults,
    ...(config.perSymbol?.[symbol]?.[key] ?? {}),
  };
}

const STRATEGY_BUILDERS = {
  RSI:        (symbol) => new RSIStrategy(getStrategyConfigForSymbol(symbol, 'rsi', config.rsi)),
  EMA:        (symbol) => new EMAStrategy(getStrategyConfigForSymbol(symbol, 'ema', config.ema)),
  MACD:       (symbol) => new MACDStrategy(getStrategyConfigForSymbol(symbol, 'macd', config.macd)),
  BB:         (symbol) => new BollingerBandsStrategy(getStrategyConfigForSymbol(symbol, 'bollinger', config.bollinger)),
  Stoch:      (symbol) => new StochasticStrategy(getStrategyConfigForSymbol(symbol, 'stochastic', config.stochastic)),
  ADX:        (symbol) => new ADXStrategy(getStrategyConfigForSymbol(symbol, 'adx', config.adx)),
  CCI:        (symbol) => new CCIStrategy(getStrategyConfigForSymbol(symbol, 'cci', config.cci)),
  Supertrend: (symbol) => new SupertrendStrategy(getStrategyConfigForSymbol(symbol, 'supertrend', config.supertrend)),
  MFI:        (symbol) => new MFIStrategy(getStrategyConfigForSymbol(symbol, 'mfi', config.mfi)),
  OBV:        (symbol) => new OBVStrategy(getStrategyConfigForSymbol(symbol, 'obv', config.obv)),
  PSAR:       (symbol) => new PSARStrategy(getStrategyConfigForSymbol(symbol, 'psar', config.psar)),
  WilliamsR:  (symbol) => new WilliamsRStrategy(getStrategyConfigForSymbol(symbol, 'williamsR', config.williamsR)),
};

export function buildStrategiesForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  const names = symCfg?.strategies ?? config.strategies ?? Object.keys(STRATEGY_BUILDERS);
  return names.map((name) => {
    const build = STRATEGY_BUILDERS[name];
    if (!build) throw new Error(`Unknown strategy: ${name}`);
    return build(symbol);
  });
}

export function getStrategyNamesForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  return symCfg?.strategies ?? config.strategies ?? [];
}

export function getStrategyTriggerHints(symbol) {
  return getStrategyNamesForSymbol(symbol)
    .map((name) => STRATEGY_TRIGGER_HINTS[name] ?? name)
    .filter(Boolean);
}

export function getRiskForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  if (!symCfg) return config.risk;
  return {
    ...config.risk,
    ...(symCfg.stopLossPct     !== undefined && { stopLossPct:     symCfg.stopLossPct }),
    ...(symCfg.takeProfitPct   !== undefined && { takeProfitPct:   symCfg.takeProfitPct }),
    ...(symCfg.trailingStopPct !== undefined && { trailingStopPct: symCfg.trailingStopPct }),
    ...(symCfg.minConfidence   !== undefined && { minConfidence:   symCfg.minConfidence }),
  };
}

export function getSignalConfigForSymbol(symbol, signalConfig) {
  const symConf = config.perSymbol?.[symbol]?.minConfidence;
  if (symConf === undefined) return signalConfig;
  return { ...signalConfig, minConfidence: symConf };
}

export function buildSignalReasons(signals = [], decision = 'HOLD') {
  if (decision === 'HOLD') return [];
  return [...new Set(
    signals
      .filter((signal) => signal?.signal === decision)
      .map((signal) => {
        const prefix = STRATEGY_REASON_PREFIX[signal?.name] ?? null;
        return prefix ? `${prefix}_${decision.toLowerCase()}` : signal?.reason ?? null;
      })
      .filter(Boolean),
  )];
}

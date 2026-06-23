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
  StochRSIStrategy,
  HeikinAshiStrategy,
  SupportResistanceStrategy,
  DonchianStrategy,
  VWAPSigmaStrategy,
  VolumeSurgeStrategy,
  IchimokuStrategy,
  PinBarStrategy,
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
  StochRSI:       'stochRsi',
  HeikinAshi:     'heikinAshi',
  SR:             'sr',
  Donchian:       'donchian',
  'VWAPσ':        'vwapsigma',
  VolSurge:       'volsurge',
  Ichimoku:       'ichimoku',
  PinBar:         'pinbar',
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
  StochRSI:   'StochRSI K < 20 crossing up → BUY · K > 80 crossing down → SELL',
  HeikinAshi: 'HA bullish candle (close>open, no lower wick) → BUY · bearish (no upper wick) → SELL',
  SR:         'Price near support zone ≥2 touches → BUY · near resistance zone ≥2 touches → SELL',
  Donchian:   'Close above 20-bar high + volume confirm → BUY · below 20-bar low → SELL',
  'VWAPσ':    'Price ≤ VWAP−2σ → BUY (oversold vs participation) · ≥ VWAP+2σ → SELL',
  VolSurge:   'Volume ≥ 2× mean + green candle → BUY · red candle → SELL',
  Ichimoku:   'Price above cloud + Tenkan>Kijun → BUY · below cloud + Tenkan<Kijun → SELL',
  PinBar:     'Long lower wick + close in upper 40% → BUY · long upper wick + close in lower 40% → SELL',
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
  StochRSI:   (symbol) => new StochRSIStrategy(getStrategyConfigForSymbol(symbol, 'stochRsi', config.stochRsi ?? {})),
  HeikinAshi: (symbol) => new HeikinAshiStrategy(getStrategyConfigForSymbol(symbol, 'heikinAshi', config.heikinAshi ?? {})),
  SR:         (symbol) => new SupportResistanceStrategy(getStrategyConfigForSymbol(symbol, 'supportResistance', config.supportResistance)),
  Donchian:   (symbol) => new DonchianStrategy(getStrategyConfigForSymbol(symbol, 'donchian', config.donchian ?? {})),
  'VWAPσ':    (symbol) => new VWAPSigmaStrategy(getStrategyConfigForSymbol(symbol, 'vwapSigma', config.vwapSigma ?? {})),
  VolSurge:   (symbol) => new VolumeSurgeStrategy(getStrategyConfigForSymbol(symbol, 'volumeSurge', config.volumeSurge ?? {})),
  Ichimoku:   (symbol) => new IchimokuStrategy(getStrategyConfigForSymbol(symbol, 'ichimoku', config.ichimoku ?? {})),
  PinBar:     (symbol) => new PinBarStrategy(getStrategyConfigForSymbol(symbol, 'pinBar', config.pinBar ?? {})),
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
    // Phase 1: ATR-based stops and two-stage exit are global toggles.
    // The spread of config.risk already carries them; this comment documents
    // intent for future maintainers (don't promote them to per-symbol unless
    // we add a clear reason to).
  };
}

export function getSignalConfigForSymbol(symbol, signalConfig) {
  const rawMinConf = config.perSymbol?.[symbol]?.minConfidence
    ?? signalConfig?.minConfidence
    ?? config.risk?.minConfidence
    ?? 0.5;
  // Phase 1 transition: per-symbol minConfidence values were calibrated against
  // the OLD aggregator formula where HOLD votes were suppressed from the
  // denominator (so 2/3 BUY + 1 HOLD = conf 1.00). The Phase 1 confidence-weighted
  // formula counts HOLDs in the denominator, dropping that case to 0.67.
  // `confidenceThresholdScale` is a one-shot multiplier applied uniformly so the
  // bot keeps trading at a sensible frequency while we measure the impact of
  // other Phase 1 changes. Phase 4 walk-forward retunes per-symbol values from
  // scratch and the scale should be reset to 1.0 once retune lands.
  const scale = Number.isFinite(config.risk?.confidenceThresholdScale)
    ? config.risk.confidenceThresholdScale
    : 1;
  const scaled = Math.max(0, Math.min(1, rawMinConf * scale));
  if (config.perSymbol?.[symbol]?.minConfidence === undefined && scale === 1) {
    return signalConfig;
  }
  return { ...signalConfig, minConfidence: scaled };
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

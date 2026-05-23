import { RSIStrategy } from './rsi.js';
import { EMAStrategy } from './ema.js';
import { MACDStrategy } from './macd.js';
import { BollingerBandsStrategy } from './bollingerBands.js';
import { StochasticStrategy } from './stochastic.js';
import { ADXStrategy } from './adx.js';
import { CCIStrategy } from './cci.js';
import { SupertrendStrategy } from './supertrend.js';
import { MFIStrategy } from './mfi.js';
import { OBVStrategy } from './obv.js';
import { PSARStrategy } from './psar.js';
import { WilliamsRStrategy } from './williamsR.js';
import { StochRSIStrategy } from './stochRsi.js';
import { HeikinAshiStrategy } from './heikinAshi.js';

/**
 * Registry of all available strategies.
 * Each entry describes the strategy class, its default config, and metadata
 * shown in the dashboard catalog.
 */
export const STRATEGY_REGISTRY = [
  {
    id: 'rsi',
    name: 'RSI',
    fullName: 'Relative Strength Index',
    Class: RSIStrategy,
    defaultConfig: { period: 14, oversold: 30, overbought: 70 },
    description: 'Measures momentum by comparing recent gains to losses. Buys when oversold (<30), sells when overbought (>70).',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 14 },
      { key: 'oversold', label: 'Oversold threshold', type: 'number', default: 30 },
      { key: 'overbought', label: 'Overbought threshold', type: 'number', default: 70 },
    ],
    tags: ['momentum', 'oscillator'],
  },
  {
    id: 'ema',
    name: 'EMA',
    fullName: 'Exponential Moving Average Crossover',
    Class: EMAStrategy,
    defaultConfig: { fast: 12, slow: 26 },
    description: 'Generates signals when the fast EMA crosses the slow EMA. Golden cross → BUY, death cross → SELL.',
    params: [
      { key: 'fast', label: 'Fast period', type: 'number', default: 12 },
      { key: 'slow', label: 'Slow period', type: 'number', default: 26 },
    ],
    tags: ['trend', 'moving average'],
  },
  {
    id: 'macd',
    name: 'MACD',
    fullName: 'Moving Average Convergence Divergence',
    Class: MACDStrategy,
    defaultConfig: { fast: 12, slow: 26, signal: 9 },
    description: 'Tracks the relationship between two EMAs. Buys when MACD crosses above the signal line, sells on the opposite cross.',
    params: [
      { key: 'fast', label: 'Fast period', type: 'number', default: 12 },
      { key: 'slow', label: 'Slow period', type: 'number', default: 26 },
      { key: 'signal', label: 'Signal period', type: 'number', default: 9 },
    ],
    tags: ['trend', 'momentum'],
  },
  {
    id: 'bollinger',
    name: 'Bollinger Bands',
    fullName: 'Bollinger Bands Mean Reversion',
    Class: BollingerBandsStrategy,
    defaultConfig: { period: 20, stdDev: 2 },
    description: 'Uses standard deviation bands around a moving average. Buys when price touches the lower band, sells at the upper band.',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 20 },
      { key: 'stdDev', label: 'Std deviation multiplier', type: 'number', default: 2 },
    ],
    tags: ['volatility', 'mean reversion'],
  },
  {
    id: 'stochastic',
    name: 'Stochastic',
    fullName: 'Stochastic Oscillator',
    Class: StochasticStrategy,
    defaultConfig: { period: 14, signalPeriod: 3, oversold: 20, overbought: 80 },
    description: 'Compares closing price to price range over a period. Signals when %K crosses %D in oversold or overbought zones.',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 14 },
      { key: 'signalPeriod', label: 'Signal period', type: 'number', default: 3 },
      { key: 'oversold', label: 'Oversold threshold', type: 'number', default: 20 },
      { key: 'overbought', label: 'Overbought threshold', type: 'number', default: 80 },
    ],
    tags: ['momentum', 'oscillator'],
  },
  {
    id: 'adx',
    name: 'ADX',
    fullName: 'Average Directional Index',
    Class: ADXStrategy,
    defaultConfig: { period: 14, threshold: 25 },
    description: 'Measures trend strength. Only signals BUY/SELL when ADX > 25 (strong trend). Acts as quality filter, blocking trades in choppy/ranging markets that cause false stop-losses.',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 14 },
      { key: 'threshold', label: 'Trend strength threshold', type: 'number', default: 25 },
    ],
    tags: ['trend', 'filter'],
  },
  {
    id: 'cci',
    name: 'CCI',
    fullName: 'Commodity Channel Index',
    Class: CCIStrategy,
    defaultConfig: { period: 20, oversold: -100, overbought: 100 },
    description: 'Mean-reversion oscillator. Buys below -100 (extreme oversold), sells above +100 (extreme overbought). More sensitive than RSI, good for catching reversals earlier.',
    params: [
      { key: 'period', label: 'Period', type: 'number', default: 20 },
      { key: 'oversold', label: 'Oversold threshold', type: 'number', default: -100 },
      { key: 'overbought', label: 'Overbought threshold', type: 'number', default: 100 },
    ],
    tags: ['momentum', 'oscillator'],
  },
  {
    id: 'supertrend',
    name: 'Supertrend',
    fullName: 'Supertrend',
    Class: SupertrendStrategy,
    defaultConfig: { period: 10, multiplier: 3.0 },
    description: 'Trend-following indicator based on ATR. Plots a line below price in uptrends (bullish) and above in downtrends (bearish). Signals on flip — complements mean-reversion strategies like RSI and BB.',
    params: [
      { key: 'period',     label: 'ATR period',   type: 'number', default: 10  },
      { key: 'multiplier', label: 'Multiplier',   type: 'number', default: 3.0 },
    ],
    tags: ['trend', 'atr', 'trailing stop'],
  },
  {
    id: 'mfi',
    name: 'MFI',
    fullName: 'Money Flow Index',
    Class: MFIStrategy,
    defaultConfig: { period: 14, oversold: 20, overbought: 80 },
    description: 'Volume-weighted RSI. Measures buying/selling pressure using both price direction and volume. Catches accumulation/distribution that RSI misses. Buys on oversold reversal (<20 turning up), sells on overbought reversal (>80 turning down).',
    params: [
      { key: 'period',     label: 'Period',             type: 'number', default: 14 },
      { key: 'oversold',   label: 'Oversold threshold', type: 'number', default: 20 },
      { key: 'overbought', label: 'Overbought threshold', type: 'number', default: 80 },
    ],
    tags: ['volume', 'momentum', 'oscillator'],
  },
  {
    id: 'obv',
    name: 'OBV',
    fullName: 'On-Balance Volume',
    Class: OBVStrategy,
    defaultConfig: { emaPeriod: 20 },
    description: 'Cumulative volume indicator. Adds volume on up-candles, subtracts on down-candles. A rising OBV confirms institutional buying. Signals when OBV crosses above/below its EMA — effective trend confirmation for momentum and trend-following strategies.',
    params: [
      { key: 'emaPeriod', label: 'EMA period', type: 'number', default: 20 },
    ],
    tags: ['volume', 'trend'],
  },
  {
    id: 'psar',
    name: 'PSAR',
    fullName: 'Parabolic SAR',
    Class: PSARStrategy,
    defaultConfig: { step: 0.02, max: 0.2 },
    description: 'Trailing stop-reversal system. The SAR dot tracks price, sitting below in uptrends and above in downtrends. Flip-only design: signals BUY/SELL only when the dot crosses to the other side of price — avoids noisy continuation signals on higher timeframes.',
    params: [
      { key: 'step', label: 'Acceleration factor step', type: 'number', default: 0.02 },
      { key: 'max',  label: 'Max acceleration factor',  type: 'number', default: 0.2  },
    ],
    tags: ['trend', 'trailing stop'],
  },
  {
    id: 'williamsR',
    name: 'Williams %R',
    fullName: 'Williams %R',
    Class: WilliamsRStrategy,
    defaultConfig: { period: 14, oversold: -80, overbought: -20 },
    description: 'Fast momentum oscillator (range −100 to 0). Responds more quickly than Stochastic. Buys when %R < −80 and turning up (oversold reversal), sells when %R > −20 and turning down (overbought reversal). Good complement to Bollinger Bands in mean-reversion setups.',
    params: [
      { key: 'period',     label: 'Period',             type: 'number', default: 14  },
      { key: 'oversold',   label: 'Oversold threshold', type: 'number', default: -80 },
      { key: 'overbought', label: 'Overbought threshold', type: 'number', default: -20 },
    ],
    tags: ['momentum', 'oscillator'],
  },
  {
    id: 'stochRsi',
    name: 'StochRSI',
    fullName: 'Stochastic RSI',
    Class: StochRSIStrategy,
    defaultConfig: { rsiPeriod: 14, stochPeriod: 14, signalPeriod: 3, oversold: 20, overbought: 80 },
    description: 'Applies the Stochastic formula to RSI values, creating a faster and more responsive oscillator. Especially effective on short timeframes (1h, 15m). Signals when %K crosses %D in oversold or overbought zones — gives 2–3× more signals than plain RSI without losing reversal confirmation.',
    params: [
      { key: 'rsiPeriod',    label: 'RSI period',           type: 'number', default: 14 },
      { key: 'stochPeriod',  label: 'Stoch window',         type: 'number', default: 14 },
      { key: 'signalPeriod', label: 'Signal (%D) period',   type: 'number', default: 3  },
      { key: 'oversold',     label: 'Oversold threshold',   type: 'number', default: 20 },
      { key: 'overbought',   label: 'Overbought threshold', type: 'number', default: 80 },
    ],
    tags: ['momentum', 'oscillator', 'short-tf'],
  },
  {
    id: 'heikinAshi',
    name: 'Heikin-Ashi',
    fullName: 'Heikin-Ashi Trend',
    Class: HeikinAshiStrategy,
    defaultConfig: { warmup: 10 },
    description: 'Converts OHLCV to synthetic Heikin-Ashi candles that filter wick noise on short timeframes. Signals only on trend flips (bear→bull or bull→bear). Confidence boosted when the signal candle has no shadow on the signal side (fully committed directional move). Pairs well with StochRSI for 15m and 1h.',
    params: [
      { key: 'warmup', label: 'HA warmup candles', type: 'number', default: 10 },
    ],
    tags: ['trend', 'noise-filter', 'short-tf'],
  },
  {
    id: 'telegram',
    name: 'Telegram',
    fullName: 'Telegram Channel Signals',
    Class: null,
    defaultConfig: { channelIds: [], weight: 0.6 },
    description: 'Monitors Telegram channels/groups for BUY/SELL text signals. Parses messages like "buy BTC", "LONG ETH/USDT". Requires TELEGRAM_TOKEN .env var.',
    params: [
      { key: 'channelIds', label: 'Channel IDs', type: 'array', default: [] },
      { key: 'weight', label: 'Signal weight', type: 'number', default: 0.6 },
    ],
    tags: ['external', 'social'],
    type: 'signal_source',
    requiresEnv: ['TELEGRAM_TOKEN'],
  },
  {
    id: 'twitter_sentiment',
    name: 'Twitter Sentiment',
    fullName: 'Twitter/X Sentiment Analysis',
    Class: null,
    defaultConfig: { intervalMs: 300000, minTweets: 5, confidenceThreshold: 0.1 },
    description: 'Polls Twitter/X API v2 for recent crypto mentions, scores sentiment from positive/negative keywords weighted by engagement. Requires TWITTER_BEARER_TOKEN.',
    params: [
      { key: 'intervalMs', label: 'Poll interval (ms)', type: 'number', default: 300000 },
      { key: 'minTweets', label: 'Min tweets threshold', type: 'number', default: 5 },
      { key: 'confidenceThreshold', label: 'Min confidence', type: 'number', default: 0.1 },
    ],
    tags: ['external', 'sentiment', 'social'],
    type: 'signal_source',
    requiresEnv: ['TWITTER_BEARER_TOKEN'],
  },
  {
    id: 'copy_trade',
    name: 'Copy Trade',
    fullName: 'Copy Trading',
    Class: null,
    defaultConfig: { intervalMs: 30000, sizeRatio: 1.0 },
    description: 'Monitors a leader Binance account\'s trades and mirrors them as signals. Requires separate LEADER_API_KEY and LEADER_API_SECRET .env vars.',
    params: [
      { key: 'intervalMs', label: 'Poll interval (ms)', type: 'number', default: 30000 },
      { key: 'sizeRatio', label: 'Position size ratio', type: 'number', default: 1.0 },
    ],
    tags: ['external', 'copy-trading'],
    type: 'signal_source',
    requiresEnv: ['LEADER_API_KEY', 'LEADER_API_SECRET'],
  },
  {
    id: 'webhook',
    name: 'Webhook',
    fullName: 'Webhook / TradingView Alerts',
    Class: null,
    defaultConfig: { port: 3000, weight: 0.8 },
    description: 'Receives JSON signals via HTTP POST. Compatible with TradingView alerts. Endpoints: POST /signal and POST /tradingview.',
    params: [
      { key: 'port', label: 'HTTP port', type: 'number', default: 3000 },
      { key: 'weight', label: 'Signal weight', type: 'number', default: 0.8 },
    ],
    tags: ['external', 'webhook'],
    type: 'signal_source',
    requiresEnv: [],
  },
];

/**
 * Build serializable metadata for the dashboard (no Class reference).
 */
export function getRegistryMeta() {
  return STRATEGY_REGISTRY.map(({ id, name, fullName, defaultConfig, description, params, tags, type, requiresEnv }) => ({
    id, name, fullName, defaultConfig, description, params, tags,
    type: type ?? 'strategy',
    requiresEnv: requiresEnv ?? [],
  }));
}

export default STRATEGY_REGISTRY;

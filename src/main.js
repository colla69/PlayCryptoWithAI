import 'dotenv/config';
import config from '../config/default.js';
import { fetchOHLCV, fetchHistoricalOHLCV, fetchTicker, paperMode, testnetMode } from './exchange/binanceClient.js';
import { loadCachedCandles, saveCachedCandles } from './exchange/candleCache.js';
import SignalAggregator from './engine/signalAggregator.js';
import PaperTrader from './executor/paperTrader.js';
import { LiveTrader } from './executor/liveTrader.js';
import RiskManager from './risk/index.js';
import { startCopyTrading, startTelegramListener, startTwitterSentiment, startWebhookServer } from './signals/index.js';
import {
  ADXStrategy,
  BollingerBandsStrategy,
  CCIStrategy,
  EMAStrategy,
  MACDStrategy,
  RSIStrategy,
  StochasticStrategy,
  getRegistryMeta,
} from './strategies/index.js';
import logger from './utils/logger.js';
import { dashboardState, startDashboardServer, pushEvent } from './dashboard/index.js';

const signalConfig = config.signals;
const STRATEGY_REASON_PREFIX = {
  RSI: 'rsi',
  EMA: 'ema',
  MACD: 'macd',
  BollingerBands: 'bb',
  Stochastic: 'stoch',
  ADX: 'adx',
  CCI: 'cci',
};

function buildSignalReasons(signals = [], decision = 'HOLD') {
  if (decision === 'HOLD') {
    return [];
  }

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

/** Returns the strategy names active for a symbol, e.g. ['MACD', 'Stoch', 'RSI'] */
function getStrategyNamesForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  return symCfg?.strategies ?? config.strategies ?? [];
}

/** One-line plain-English trigger explanation per strategy name */
const STRATEGY_TRIGGER_HINTS = {
  RSI:   'RSI < 30 → BUY (oversold) · RSI > 70 → SELL (overbought)',
  BB:    'Price touches lower Bollinger Band → BUY · upper band → SELL',
  MACD:  'MACD line crosses above signal line → BUY · below → SELL',
  Stoch: 'Stochastic K crosses above D below 20 → BUY · above 80 → SELL',
  EMA:   'Fast EMA crosses above slow EMA → BUY · below → SELL',
  ADX:   'ADX > 25 confirms trend; direction from price vs EMA',
  CCI:   'CCI crosses above −100 from oversold → BUY · below +100 from overbought → SELL',
};

/** Returns an array of trigger hint strings for a symbol's strategy combo */
function getStrategyTriggerHints(symbol) {
  return getStrategyNamesForSymbol(symbol)
    .map((name) => STRATEGY_TRIGGER_HINTS[name] ?? name)
    .filter(Boolean);
}

function getStrategyConfigForSymbol(symbol, key, defaults) {
  return {
    ...defaults,
    ...(config.perSymbol?.[symbol]?.[key] ?? {}),
  };
}

const STRATEGY_BUILDERS = {
  RSI:   (symbol) => new RSIStrategy(getStrategyConfigForSymbol(symbol, 'rsi', config.rsi)),
  EMA:   (symbol) => new EMAStrategy(getStrategyConfigForSymbol(symbol, 'ema', config.ema)),
  MACD:  (symbol) => new MACDStrategy(getStrategyConfigForSymbol(symbol, 'macd', config.macd)),
  BB:    (symbol) => new BollingerBandsStrategy(getStrategyConfigForSymbol(symbol, 'bollinger', config.bollinger)),
  Stoch: (symbol) => new StochasticStrategy(getStrategyConfigForSymbol(symbol, 'stochastic', config.stochastic)),
  ADX:   (symbol) => new ADXStrategy(getStrategyConfigForSymbol(symbol, 'adx', config.adx)),
  CCI:   (symbol) => new CCIStrategy(getStrategyConfigForSymbol(symbol, 'cci', config.cci)),
};

function buildStrategiesForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  const names = symCfg?.strategies ?? config.strategies ?? Object.keys(STRATEGY_BUILDERS);
  return names.map((name) => {
    const build = STRATEGY_BUILDERS[name];
    if (!build) throw new Error(`Unknown strategy: ${name}`);
    return build(symbol);
  });
}

function getRiskForSymbol(symbol) {
  const symCfg = config.perSymbol?.[symbol];
  if (!symCfg) return config.risk;
  return {
    ...config.risk,
    ...(symCfg.stopLossPct      !== undefined && { stopLossPct:      symCfg.stopLossPct }),
    ...(symCfg.takeProfitPct    !== undefined && { takeProfitPct:    symCfg.takeProfitPct }),
    ...(symCfg.trailingStopPct  !== undefined && { trailingStopPct:  symCfg.trailingStopPct }),
    ...(symCfg.minConfidence    !== undefined && { minConfidence:    symCfg.minConfidence }),
  };
}

function getSignalConfigForSymbol(symbol) {
  const symConf = config.perSymbol?.[symbol]?.minConfidence;
  if (symConf === undefined) return signalConfig;
  return { ...signalConfig, minConfidence: symConf };
}

// Build per-symbol aggregators (each coin gets its own strategy set)
const symbolAggregators = Object.fromEntries(
  config.symbols.map((sym) => [sym, new SignalAggregator(buildStrategiesForSymbol(sym), getSignalConfigForSymbol(sym))])
);

// Default aggregator (for dashboard display — uses default strategy set)
const defaultStrategies = buildStrategiesForSymbol(config.symbols[0]);

const trader = paperMode
  ? new PaperTrader(config.risk)
  : new LiveTrader(config.risk);
const riskManager = new RiskManager(config.risk);

// Register active strategies and full strategy catalog in the dashboard once at startup
dashboardState.setStrategiesConfig(defaultStrategies);
dashboardState.setStrategyRegistry(getRegistryMeta());
dashboardState.setRuntimeConfig({
  timeframe: config.timeframe,
  pollIntervalMs: config.pollIntervalMs,
  symbols: config.symbols,
});
const webhookPort = Number(process.env.WEBHOOK_PORT ?? signalConfig.webhook.port);
const dashboardPort = Number(process.env.DASHBOARD_PORT ?? config.dashboard?.port ?? 3001);
const telegramChannelIds = (process.env.TELEGRAM_CHANNEL_IDS?.split(',') ?? signalConfig.telegram.channelIds)
  .map((channelId) => String(channelId).trim())
  .filter(Boolean);

let cycleInProgress = false;
let shuttingDown = false;
let webhookApp = null;
let telegramBot = null;
let twitterSentimentService = null;
let copyTradingService = null;
let dashboardServer = null;

function initializeExternalSignalSources() {
  if (signalConfig.webhook?.enabled) {
    webhookApp = startWebhookServer(webhookPort);
  }

  if (signalConfig.telegram?.enabled && process.env.TELEGRAM_TOKEN) {
    telegramBot = startTelegramListener(process.env.TELEGRAM_TOKEN, telegramChannelIds);
  } else if (signalConfig.telegram?.enabled) {
    logger.warn('Telegram listener enabled but TELEGRAM_TOKEN is not set');
  }

  if (process.env.TWITTER_BEARER_TOKEN) {
    twitterSentimentService = startTwitterSentiment({
      bearerToken: process.env.TWITTER_BEARER_TOKEN,
      symbols: config.symbols,
      intervalMs: 300_000,
    });
  }

}

async function runCycle(symbol) {
  try {
    const freshCandles = await fetchOHLCV(symbol, config.timeframe, config.candleLimit);

    if (!freshCandles.length) {
      logger.warn(`${symbol}: no candles returned`);
      return;
    }

    // Merge fresh candles into the historical cache so indicators always use
    // the full history (730 candles), not just the last 200 from the exchange.
    // This keeps signal values consistent with runInitialSignals().
    dashboardState.updateCandles(symbol, freshCandles);
    const candles = dashboardState.getCandles(symbol);

    const aggregator = symbolAggregators[symbol];
    const symSignalConfig = getSignalConfigForSymbol(symbol);
    const result = aggregator.aggregate(candles, symbol, symSignalConfig);
    const currentPrice = Number(candles.at(-1).close);
    const currentStatus = await trader.getStatus();
    const symRisk = getRiskForSymbol(symbol);
    const tradeCheck = riskManager.canTrade(symbol, result.decision, result.confidence, currentStatus, symRisk.minConfidence);
    let tradeResult = null;

    if (!tradeCheck.allowed) {
      logger.info(`${symbol}: trade blocked - ${tradeCheck.reason}`);
    } else {
      tradeResult = await trader.execute(symbol, result.decision, currentPrice, symRisk);

      if (tradeResult) {
        if (typeof tradeResult.pnl === 'number' && tradeResult.side === 'SELL') {
          riskManager.recordTrade(tradeResult.pnl);
        }
        dashboardState.pushTrade(tradeResult);
        pushEvent('trade', tradeResult);
      }
    }

    logger.info(
      `${symbol}: decision=${result.decision} confidence=${(result.confidence * 100).toFixed(0)}% price=${currentPrice.toFixed(8)} external_signals=${result.externalSignals.length}`,
    );
    logger.info(`${symbol}: ${result.signals.map((signal) => signal.reason).join(' | ')}`);

    if (result.externalSignals.length > 0) {
      logger.info(
        `${symbol}: external ${result.externalSignals.map((signal) => `${signal.source}:${signal.signal}@${signal.confidence}`).join(' | ')}`,
      );
    }

    dashboardState.updatePrice(symbol, currentPrice);
    // Include block reason in the signal so the dashboard can show why a BUY/SELL didn't execute
    const blockReason = !tradeCheck.allowed && result.decision !== 'HOLD' ? tradeCheck.reason : null;
    dashboardState.pushSignal({
      symbol,
      decision: result.decision,
      confidence: result.confidence,
      timestamp: Date.now(),
      reasons: buildSignalReasons(result.signals, result.decision),
      blockReason,
      strategies: getStrategyNamesForSymbol(symbol),
      triggerHints: getStrategyTriggerHints(symbol),
    });
    dashboardState.updateStrategyResults(symbol, result.signals);

    const status = await trader.getStatus();
    const dailyStats = riskManager.getDailyStats();
    dashboardState.updateStatus(status, dailyStats);
    dashboardState.incrementCycle();
    pushEvent('cycle', dashboardState.getSummary());

    logger.info(
      `${symbol}: ${(paperMode ? 'paper' : testnetMode ? 'testnet' : 'live').toLowerCase()} balance=${status.balance.toFixed(2)} pnl=${status.totalPnL.toFixed(2)} open_positions=${status.positions.length} daily_pnl=${dailyStats.dailyPnL.toFixed(2)} blocked=${dailyStats.blocked}`,
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const message = `${symbol}: cycle failed - ${errorMessage}`;
    logger.error(message);
    dashboardState.pushError(message);
    pushEvent('error', { message, timestamp: Date.now() });
  }
}

async function runAllSymbols() {
  if (cycleInProgress) {
    logger.warn('Previous cycle still running, skipping this interval');
    return;
  }

  cycleInProgress = true;

  try {
    await Promise.all(config.symbols.map((symbol) => runCycle(symbol)));
  } finally {
    cycleInProgress = false;
  }
}

function logStartup() {
  logger.info('Starting playAIStocks Phase 4 bot');
  logger.info(
    `Mode=${paperMode ? 'PAPER' : testnetMode ? 'TESTNET' : 'LIVE'} symbols=${config.symbols.join(', ')} timeframe=${config.timeframe} interval=${config.pollIntervalMs}ms`,
  );
  for (const sym of config.symbols) {
    const symCfg = config.perSymbol?.[sym];
    const strats = symCfg?.strategies ?? config.strategies;
    const risk = getRiskForSymbol(sym);
    const tag = symCfg ? ' [custom]' : ' [default]';
    const conf = symCfg?.minConfidence ?? config.risk.minConfidence;
    logger.info(`  ${sym}${tag}: strategies=[${strats.join('+')}]  SL=${(risk.stopLossPct*100).toFixed(0)}%  TP=${(risk.takeProfitPct*100).toFixed(0)}%  conf=${conf}`);
  }
  logger.info(
    `Risk: balance=${config.risk.initialBalance.toFixed(2)} maxPositionPct=${config.risk.maxPositionPct} stopLossPct=${config.risk.stopLossPct} takeProfitPct=${config.risk.takeProfitPct} trailingStopPct=${config.risk.trailingStopPct ?? 'off'}`,
  );
  logger.info(
    `Risk limits: maxDailyLossPct=${config.risk.maxDailyLossPct} maxOpenPositions=${config.risk.maxOpenPositions} minConfidence=${config.risk.minConfidence}`,
  );
  logger.info(
    `Signals: webhook=${signalConfig.webhook?.enabled ? `on:${webhookPort}` : 'off'} telegram=${signalConfig.telegram?.enabled ? 'on' : 'off'} algoWeight=${signalConfig.algoWeight} minConfidence=${signalConfig.minConfidence}`,
  );

  if (config.dashboard?.enabled) {
    logger.info(`Dashboard: http://localhost:${dashboardPort}`);
  }
}

async function logShutdown() {
  if (webhookApp?.server) {
    webhookApp.server.close();
  }

  if (dashboardServer) {
    dashboardServer.close();
  }

  if (telegramBot) {
    void telegramBot.stopPolling();
  }

  twitterSentimentService?.stop?.();
  copyTradingService?.stop?.();

  const status = await trader.getStatus();
  const dailyStats = riskManager.getDailyStats();
  logger.info(
    `Final ${(paperMode ? 'paper' : testnetMode ? 'testnet' : 'live').toLowerCase()} status: balance=${status.balance.toFixed(2)} pnl=${status.totalPnL.toFixed(2)} open_positions=${status.positions.length} daily_pnl=${dailyStats.dailyPnL.toFixed(2)}`,
  );
}

/**
 * Loads ~1 year of historical candles for every symbol on startup.
 * Strategy:
 *   1. Load candles from local disk cache (instant)
 *   2. If cache is empty → full historical fetch from Binance (~3 pages)
 *   3. If cache exists → fetch only new candles since the last cached timestamp
 *   4. Merge, deduplicate, save back to disk, store in dashboardState
 */
async function initializeHistoricalData() {
  const total = config.historicalCandles ?? 2_250;
  const tf    = config.timeframe;
  logger.info(`Initializing ${tf} candle history for ${config.symbols.length} symbols…`);

  await Promise.all(config.symbols.map(async (symbol) => {
    try {
      let cached = await loadCachedCandles(symbol, tf);

      if (!cached.length) {
        // Cold start — full historical fetch
        logger.info(`${symbol}: no cache found, fetching ${total} candles from Binance…`);
        cached = await fetchHistoricalOHLCV(symbol, tf, total);
      } else {
        // Warm start — only fetch candles newer than the last cached one
        const lastTs  = cached.at(-1).timestamp;
        const tfMs    = { '1m':60_000,'5m':300_000,'15m':900_000,'1h':3_600_000,'4h':14_400_000,'12h':43_200_000,'1d':86_400_000 };
        const msPerTf = tfMs[tf] ?? 3_600_000;
        const sinceTs = lastTs + msPerTf;

        if (sinceTs < Date.now()) {
          logger.info(`${symbol}: cache has ${cached.length} candles, fetching new ones since last close…`);
          const fresh = await fetchHistoricalOHLCV(symbol, tf, Math.ceil((Date.now() - sinceTs) / msPerTf) + 5);
          if (fresh.length) {
            const seen = new Set(cached.map((c) => c.timestamp));
            const newCandles = fresh.filter((c) => !seen.has(c.timestamp));
            cached = [...cached, ...newCandles].slice(-2_500);
            logger.info(`${symbol}: appended ${newCandles.length} new candles`);
          }
        } else {
          logger.info(`${symbol}: cache is up-to-date (${cached.length} candles)`);
        }
      }

      await saveCachedCandles(symbol, tf, cached);
      dashboardState.updateCandles(symbol, cached);
      logger.info(`${symbol}: ${cached.length} ${tf} candles ready`);
    } catch (err) {
      logger.error(`${symbol}: history init failed — ${err.message}`);
    }
  }));
}

/**
 * Startup smoke test — buy a tiny amount of a random coin, hold 10 seconds, sell it.
 * Confirms the full buy→sell pipeline (exchange connection, order placement, position
 * tracking) is wired correctly before the main loop starts.
 *
 * Uses $1 in paper mode, $11 in live/testnet (Binance minimum notional is $10).
 */
async function runSmokeTest() {
  const modeName = paperMode ? 'PAPER' : testnetMode ? 'TESTNET' : 'LIVE';
  const testBudget = paperMode ? 1 : 11;           // $1 paper, $11 live (above $10 minimum)
  const holdSeconds = 10;

  // Pick a random symbol from the active list
  const symbol = config.symbols[Math.floor(Math.random() * config.symbols.length)];

  logger.info(`🔬 SMOKE TEST [${modeName}] — ${symbol} | budget=$${testBudget} | hold=${holdSeconds}s`);
  dashboardState.pushEvent?.('smoke_test', { phase: 'start', symbol, budget: testBudget });

  try {
    // ── 1. Fetch current price ───────────────────────────────────────────────
    let price;
    if (paperMode) {
      const candles = await fetchOHLCV(symbol, '1m', 2);
      price = Number(candles.at(-1)?.close ?? 0);
    } else {
      const ticker = await fetchTicker(symbol);
      price = Number(ticker?.last ?? ticker?.close ?? 0);
    }

    if (!price || price <= 0) {
      logger.warn(`🔬 SMOKE TEST — could not fetch price for ${symbol}, aborting`);
      return;
    }

    logger.info(`🔬 SMOKE TEST — ${symbol} price=$${price}`);

    // ── 2. Build a minimal risk config for this test trade ───────────────────
    const smokeRisk = {
      maxPositionPct: 0.99,
      stopLossPct:    0.50,
      takeProfitPct:  10.00,
      trailingStopPct: 0,
    };

    // ── 3. BUY via main trader so trades appear in the dashboard ────────────
    const buyResult = await trader.execute(symbol, 'BUY', price, smokeRisk);

    if (!buyResult) {
      logger.warn(`🔬 SMOKE TEST — BUY failed for ${symbol} (result=null)`);
      return;
    }

    logger.info(`🔬 SMOKE TEST — ✅ BUY OK  ${symbol}  qty=${buyResult.qty ?? '?'}  price=$${price}`);
    dashboardState.pushTrade({ ...buyResult, note: '🔬 smoke-test' });
    pushEvent('trade', { ...buyResult, note: '🔬 smoke-test' });

    // ── 4. Wait 10 seconds ───────────────────────────────────────────────────
    await new Promise(r => setTimeout(r, holdSeconds * 1000));

    // ── 5. SELL via same main trader ─────────────────────────────────────────
    let sellPrice = price;
    try {
      if (paperMode) {
        const c = await fetchOHLCV(symbol, '1m', 2);
        sellPrice = Number(c.at(-1)?.close ?? price);
      } else {
        const t = await fetchTicker(symbol);
        sellPrice = Number(t?.last ?? t?.close ?? price);
      }
    } catch { /* use entry price if fetch fails */ }

    const sellResult = await trader.execute(symbol, 'SELL', sellPrice, smokeRisk);

    if (!sellResult) {
      logger.warn(`🔬 SMOKE TEST — SELL failed for ${symbol} (result=null)`);
      return;
    }

    const pnl = typeof sellResult.pnl === 'number' ? sellResult.pnl.toFixed(4) : 'n/a';
    logger.info(`🔬 SMOKE TEST — ✅ SELL OK  ${symbol}  price=$${sellPrice}  pnl=$${pnl}`);
    logger.info(`🔬 SMOKE TEST — ✅ PASSED — buy/sell pipeline is working correctly`);
    dashboardState.pushTrade({ ...sellResult, note: '🔬 smoke-test' });
    pushEvent('trade', { ...sellResult, note: '🔬 smoke-test' });

  } catch (err) {
    logger.error(`🔬 SMOKE TEST — ❌ FAILED: ${err.message}`);
    dashboardState.pushEvent?.('smoke_test', { phase: 'error', symbol, error: err.message, passed: false });
  }
}

/**
 * Produce signals immediately from the cached historical candles — no exchange fetch needed.
 * This populates the dashboard signal feed the moment the bot starts, rather than waiting
 * for the first 12h live cycle.
 */
async function runInitialSignals() {
  let seeded = 0;
  for (const symbol of config.symbols) {
    try {
      const candles = dashboardState.getCandles(symbol);
      if (candles.length < 30) continue;

      const aggregator      = symbolAggregators[symbol];
      const symSignalConfig = getSignalConfigForSymbol(symbol);
      const result          = aggregator.aggregate(candles, symbol, symSignalConfig);
      const currentPrice    = Number(candles.at(-1).close);

      dashboardState.updatePrice(symbol, currentPrice);
      dashboardState.pushSignal({
        symbol,
        decision:     result.decision,
        confidence:   result.confidence,
        timestamp:    Date.now(),
        reasons:      buildSignalReasons(result.signals, result.decision),
        strategies:   getStrategyNamesForSymbol(symbol),
        triggerHints: getStrategyTriggerHints(symbol),
      });
      dashboardState.updateStrategyResults(symbol, result.signals);
      seeded++;
    } catch (err) {
      logger.warn(`${symbol}: initial signal from cache failed — ${err.message}`);
    }
  }
  if (seeded > 0) {
    pushEvent('cycle', dashboardState.getSummary());
    logger.info(`Initial signals seeded for ${seeded}/${config.symbols.length} symbols from cached candles`);
  }
}



if (config.dashboard?.enabled) {
  dashboardServer = startDashboardServer(dashboardPort);
}

logStartup();
await initializeHistoricalData();
await runInitialSignals();   // ← signals appear instantly from cache
await runSmokeTest();
await runAllSymbols();
const intervalId = setInterval(() => {
  void runAllSymbols();
}, config.pollIntervalMs);

process.on('SIGINT', () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearInterval(intervalId);
  logger.info('SIGINT received, shutting down gracefully');
  void logShutdown().finally(() => process.exit(0));
});

process.on('unhandledRejection', (error) => {
  const message = `Unhandled rejection: ${error instanceof Error ? error.message : String(error)}`;
  logger.error(message);
  dashboardState.pushError(message);
  pushEvent('error', { message, timestamp: Date.now() });
});

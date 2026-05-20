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
import { isMarketTrending } from './utils/indicators.js';
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

// ── Correlation filter state ───────────────────────────────────────────────────
// Rebuilt after candle init and after each cycle so it always reflects recent data.
let correlationMatrix = {};

function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const xs = x.slice(-n);
  const ys = y.slice(-n);
  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, denomX = 0, denomY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    num += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  const denom = Math.sqrt(denomX * denomY);
  return denom > 0 ? num / denom : 0;
}

function buildCorrelationMatrix() {
  if (!config.correlation?.enabled) return;
  const period = config.correlation?.period ?? 60;
  const symbols = config.symbols;
  const returnsBySym = {};

  for (const sym of symbols) {
    const candles = dashboardState.getCandles(sym);
    if (candles.length < period + 1) continue;
    const recent = candles.slice(-(period + 1));
    const rets = [];
    for (let i = 1; i < recent.length; i++) {
      const prev = Number(recent[i - 1].close);
      const curr = Number(recent[i].close);
      if (prev > 0) rets.push(Math.log(curr / prev));
    }
    returnsBySym[sym] = rets;
  }

  const matrix = {};
  for (const sym1 of symbols) {
    matrix[sym1] = {};
    for (const sym2 of symbols) {
      if (sym1 === sym2) { matrix[sym1][sym2] = 1; continue; }
      const r1 = returnsBySym[sym1];
      const r2 = returnsBySym[sym2];
      matrix[sym1][sym2] = r1 && r2 ? pearsonCorrelation(r1, r2) : 0;
    }
  }
  correlationMatrix = matrix;
}

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

    // ── Regime filter: block NEW buys in ranging markets ─────────────────────
    // ADX computed from the same past candles the aggregator just used — no lookahead.
    // Existing positions are unaffected; SL/TP management always runs.
    const regimeCfg = config.regime;
    let blockReason = null;
    if (
      result.decision === 'BUY' &&
      regimeCfg?.enabled &&
      !isMarketTrending(candles, regimeCfg.adxPeriod, regimeCfg.adxThreshold)
    ) {
      blockReason = `Ranging market (ADX < ${regimeCfg.adxThreshold})`;
      logger.info(`${symbol}: BUY suppressed — ${blockReason}`);
    }

    // ── Correlation filter: block BUY if already holding a correlated coin ───
    // Uses past log-returns only — no lookahead.
    if (!blockReason && result.decision === 'BUY' && config.correlation?.enabled) {
      const threshold = config.correlation.threshold ?? 0.8;
      const correlated = currentStatus.positions.find((p) => {
        const r = correlationMatrix[symbol]?.[p.symbol] ?? 0;
        return r > threshold;
      });
      if (correlated) {
        const r = (correlationMatrix[symbol]?.[correlated.symbol] ?? 0).toFixed(2);
        blockReason = `Correlated with open ${correlated.symbol.replace('/USDT', '')} (r=${r})`;
        logger.info(`${symbol}: BUY suppressed — ${blockReason}`);
      }
    }

    // Track filter-level blocks for the dashboard counter
    if (blockReason) dashboardState.pushBlockedSignal(blockReason);

    const tradeCheck = blockReason
      ? { allowed: false, reason: blockReason }
      : riskManager.canTrade(symbol, result.decision, result.confidence, currentStatus, symRisk.minConfidence);
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
    const signalBlockReason = !tradeCheck.allowed && result.decision !== 'HOLD' ? tradeCheck.reason : null;
    dashboardState.pushSignal({
      symbol,
      decision: result.decision,
      confidence: result.confidence,
      timestamp: Date.now(),
      reasons: buildSignalReasons(result.signals, result.decision),
      blockReason: signalBlockReason,
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
    // Refresh correlation matrix each cycle — new candles may have arrived
    buildCorrelationMatrix();
    await Promise.all(config.symbols.map((symbol) => runCycle(symbol)));
  } finally {
    cycleInProgress = false;
  }
}

/**
 * Returns the timestamp (ms) of the next candle-close boundary for the given timeframe.
 * Binance aligns all candle closes to UTC epoch multiples of the period, so e.g. 12h
 * candles always close at 00:00 and 12:00 UTC. We add a 3-second buffer so the candle
 * data is guaranteed to have settled by the time we fetch it.
 */
function nextCandleClose(timeframe) {
  const match = String(timeframe || '12h').toLowerCase().match(/^(\d+)(m|h|d|w)$/);
  if (!match) return Date.now() + 60_000;
  const num  = parseInt(match[1], 10);
  const unit = match[2];
  const mults = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const periodMs = num * mults[unit];
  return Math.ceil(Date.now() / periodMs) * periodMs + 3_000; // +3 s buffer
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
  const rc = config.regime;
  logger.info(
    `Regime filter: ${rc?.enabled ? `ON — ADX(${rc.adxPeriod}) < ${rc.adxThreshold} blocks BUY signals` : 'OFF'}`,
  );
  const cc = config.correlation;
  logger.info(
    `Correlation filter: ${cc?.enabled ? `ON — r > ${cc.threshold} (${cc.period ?? 60} candle window) blocks BUY signals` : 'OFF'}`,
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
 * Startup smoke test — buy the smallest possible USD amount, hold, sell.
 * Confirms the full buy→sell pipeline (exchange connection, order placement, position
 * tracking) is wired correctly before the main loop starts.
 *
 * Uses $1 in paper mode, $11 in live/testnet (Binance minimum notional is $10).
 */
async function runSmokeTest(holdSeconds = 10) {
  const modeName = paperMode ? 'PAPER' : testnetMode ? 'TESTNET' : 'LIVE';
  // Binance minimum notional is $10; use $11 for safety. Paper mode uses $1 (no real money).
  const testBudget = paperMode ? 1 : 11;

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
    // Use the testBudget as the actual cap so we don't tie up the main balance.
    // We need getStatus() to know the current balance.
    const { balance: currentBalance } = await trader.getStatus();
    const safePct = currentBalance > 0 ? Math.min(testBudget / currentBalance, 0.02) : 0.01;
    const smokeRisk = {
      maxPositionPct:  safePct,   // at most testBudget/$, never more than 2% of balance
      stopLossPct:     0.50,
      takeProfitPct:  10.00,
      trailingStopPct: 0,
    };

    // ── 3. BUY via main trader so the full execution pipeline is exercised ───
    const buyResult = await trader.execute(symbol, 'BUY', price, smokeRisk);

    if (!buyResult) {
      logger.warn(`🔬 SMOKE TEST — BUY failed for ${symbol} (result=null)`);
      return;
    }

    logger.info(`🔬 SMOKE TEST — ✅ BUY OK  ${symbol}  qty=${buyResult.qty ?? '?'}  price=$${price}`);
    dashboardState.pushTrade({ ...buyResult, note: '🔬 smoke-test' });

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
  dashboardServer = startDashboardServer(dashboardPort, { runSmokeTest });
}

logStartup();
// Expose filter config to the dashboard
dashboardState.setActiveFilters({
  regime:       { enabled: config.regime?.enabled ?? false,      adxPeriod: config.regime?.adxPeriod ?? 14,     adxThreshold: config.regime?.adxThreshold ?? 20 },
  correlation:  { enabled: config.correlation?.enabled ?? false, threshold: config.correlation?.threshold ?? 0.8, period: config.correlation?.period ?? 60 },
  breakEven:    { enabled: (config.risk?.breakEvenTriggerPct ?? 0) > 0, triggerPct: config.risk?.breakEvenTriggerPct ?? 0 },
  trailingStop: { enabled: (config.risk?.trailingStopPct ?? 0) > 0, pct: config.risk?.trailingStopPct ?? 0 },
});
await initializeHistoricalData();
// Seed daily P&L from persisted history so the loss limit survives restarts
riskManager.seedFromHistory(dashboardState.getSummary().trades);
buildCorrelationMatrix();         // ← built once from full history, then refreshed each cycle
await runInitialSignals();   // ← signals appear instantly from cache
await runSmokeTest();
await runAllSymbols();  // immediate run on startup (SL/TP check + fresh signals)

// ── Align all subsequent cycles to candle-close boundaries ───────────────────
// Binance closes 12h candles at exactly 00:00 and 12:00 UTC. Running on a raw
// setInterval from startup means signals are computed mid-candle. Instead we:
//   1. Wait until the next close boundary (+ 3 s settle buffer)
//   2. Run there, then repeat every pollIntervalMs (which equals the candle period)
let cycleIntervalId = null;
let alignTimeoutId  = null;
let pricePollId     = null;

// Refresh live prices every 3 s for all watched symbols.
// Open-position symbols get priority; then broadcast via SSE so the dashboard
// can update price/P&L cells without waiting for the next full cycle event.
const PRICE_POLL_MS = 5_000;
async function refreshOpenPositionPrices() {
  try {
    const status = await trader?.getStatus?.();
    const openSymbols = new Set((status?.positions ?? []).map((p) => p.symbol));
    // Always refresh open positions; also refresh all symbols so the price strip stays live
    const allSymbols = openSymbols.size ? [...openSymbols] : config.symbols.slice(0, 5);
    const updates = {};
    await Promise.allSettled(allSymbols.map(async (symbol) => {
      const ticker = await fetchTicker(symbol);
      const price  = Number(ticker?.last ?? ticker?.close ?? 0);
      if (price > 0) {
        dashboardState.updatePrice(symbol, price);
        updates[symbol] = price;
      }
    }));
    if (Object.keys(updates).length) pushEvent('prices', updates);
  } catch (err) {
    logger.debug(`Price poll error: ${err.message}`);
  }
}
pricePollId = setInterval(() => void refreshOpenPositionPrices(), PRICE_POLL_MS);

function scheduleNextCycle() {
  const nextClose = nextCandleClose(config.timeframe);
  const delay     = nextClose - Date.now();
  dashboardState.setNextRunAt(nextClose);
  logger.info(`Next cycle aligned to candle close in ${Math.round(delay / 60_000)} min (${new Date(nextClose).toUTCString()})`);

  alignTimeoutId = setTimeout(async () => {
    alignTimeoutId = null;
    await runAllSymbols();
    // After the first aligned run, repeat on the candle period
    cycleIntervalId = setInterval(() => {
      dashboardState.setNextRunAt(Date.now() + config.pollIntervalMs);
      void runAllSymbols();
    }, config.pollIntervalMs);
  }, delay);
}

scheduleNextCycle();

process.on('SIGINT', () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  clearTimeout(alignTimeoutId);
  clearInterval(cycleIntervalId);
  clearInterval(pricePollId);
  logger.info('SIGINT received, shutting down gracefully');
  void logShutdown().finally(() => process.exit(0));
});

process.on('unhandledRejection', (error) => {
  const message = `Unhandled rejection: ${error instanceof Error ? error.message : String(error)}`;
  logger.error(message);
  dashboardState.pushError(message);
  pushEvent('error', { message, timestamp: Date.now() });
});

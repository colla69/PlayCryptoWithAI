import 'dotenv/config';
// ccxt and telegram-bot-api each attach multiple process signal listeners —
// raise the limit to suppress the false-positive MaxListeners warning.
process.setMaxListeners(50);
import config from '../config/default.js';
import { fetchOHLCV, fetchHistoricalOHLCV, fetchTicker, paperMode, testnetMode } from './exchange/binanceClient.js';
import { loadCachedCandles, saveCachedCandles } from './exchange/candleCache.js';
import { mergeCandles } from './utils/mergeCandles.js';
import SignalAggregator from './engine/signalAggregator.js';
import PaperTrader from './executor/paperTrader.js';
import { LiveTrader } from './executor/liveTrader.js';
import RiskManager from './risk/index.js';
import { calcEquityFromStatus } from './risk/portfolioRisk.js';
import { checkCycleGap, updateWatchdogLatch } from './monitor/cycleWatchdog.js';
import { startCopyTrading, startTelegramListener, startTwitterSentiment, startWebhookServer } from './signals/index.js';
import { getRegistryMeta } from './strategies/index.js';
import logger, { appendTrade } from './utils/logger.js';
import { runtimeDir } from './utils/runtimePaths.js';
import { isMarketTrending } from './utils/indicators.js';
import { dashboardState, startDashboardServer, pushEvent } from './dashboard/index.js';
import { recordEquitySnapshot, loadEquityHistory } from './dashboard/equityHistory.js';
import { initNotifier, notifyTrade, notifyStartup, notifyAlert } from './notifications/index.js';
import { mtfAlignScore, mtf4hMomentumScore } from './utils/mtfAlignment.js';
import { loadFearGreedHistory } from './data/fearGreed.js';
import { refreshMarketContext, getBtcDominanceTrend, getEthBtcTrend } from './data/marketContext.js';
import { RegimeTracker, REGIME_LABELS } from './engine/regimeClassifier.js';
import { resolveStrategyList, DEFAULT_REGIME_BUNDLES } from './engine/regimeRouter.js';
import { baseSymbol, impliedVolAsOf } from './engine/tsmCore.js';
import { rsiOfLastClosedBar } from './engine/satellites.js';
import { loadNasdaqHistory } from './data/nasdaqTrend.js';
import { loadDvolHistory, DVOL_COINS } from './data/dvolFeed.js';
import { loadExchangeEvents } from './data/exchangeEventsFeed.js';
import { recordSnapshots } from './data/gaugeRecorder.js';
import { loadSleeveState, saveSleeveState } from './data/sleeveStateStore.js';
import {
  buildStrategiesForSymbol,
  getStrategyNamesForSymbol,
  getStrategyTriggerHints,
  getRiskForSymbol,
  getSignalConfigForSymbol,
  buildSignalReasons,
  scaleMinConfidence,
} from './utils/strategyBuilder.js';
import { buildCorrelationMatrix } from './utils/correlation.js';
import { checkCandleFreshness } from './utils/candleFreshness.js';
import { withFormingBar } from './utils/formingBar.js';
import { createAlignedScheduler } from './core/cycleScheduler.js';
import { createTradingEngine } from './core/engine.js';

const signalConfig = config.signals;

// Build per-symbol aggregators (each coin gets its own strategy set)
const symbolAggregators = Object.fromEntries(
  config.symbols.map((sym) => [sym, new SignalAggregator(buildStrategiesForSymbol(sym), getSignalConfigForSymbol(sym, signalConfig))])
);

// Default aggregator (for dashboard display — uses default strategy set)
const defaultStrategies = buildStrategiesForSymbol(config.symbols[0]);

// Derive quote currency from config symbols (e.g. 'BTC/USDC' → 'USDC')
const quoteCurrency = (config.symbols[0] ?? 'BTC/USDC').split('/')[1] ?? 'USDC';

const trader = paperMode
  ? new PaperTrader(config.risk)
  : new LiveTrader({ ...config.risk, quoteCurrency });
const riskManager = new RiskManager(config.risk);

// ── BTC Regime classifier (Phase 4) ──────────────────────────────────────────
// One stateful tracker shared across all symbols. Updated at the start of each
// cycle from BTC candles. Current regime is exposed on dashboardState for the
// UI and used by routing/filters/sizing decisions.
const regimeTracker = new RegimeTracker(config.regimeClassifier ?? {});

// The sleeve's implied-vol feed (section E1). Only BTC and ETH have a DVOL index;
// any other symbol, or a close older than maxAgeHours, sizes on realized vol.
const impliedVolCfg = config.tsmCore?.impliedVol ?? {};
const loadImpliedVol = impliedVolCfg.enabled
  ? async (symbol) => {
    const coin = symbol.split('/')[0];
    if (!DVOL_COINS.includes(coin)) return null;
    const dvol = await loadDvolHistory();
    const vol = impliedVolAsOf(dvol?.[coin], Date.now(), { maxAgeMs: Number(impliedVolCfg.maxAgeHours ?? 24) * 3_600_000 });
    if (vol == null) logger.warn(`[TSM-CORE] ${symbol}: no DVOL close within ${impliedVolCfg.maxAgeHours ?? 24}h — sizing on realized vol`);
    return vol;
  }
  : null;

// Binance's notices (monitoring tags, USDC-pair removals, delistings) as of now; the
// engine vetoes entries and sells a position whose pair is going away. The feed is
// re-read once per 4h period; on an outage the cache stays and nothing new is blocked.
const loadVenueEvents = config.exchangeEvents?.enabled
  ? async () => {
    const nowMs = Date.now();
    return (await loadExchangeEvents({ now: nowMs }))?.events.filter((e) => e.announcedAt <= nowMs) ?? null;
  }
  : null;

// ── The trading engine ────────────────────────────────────────────────────────
// One bar-close cycle (src/core/engine.js). It owns the cycle state — correlation
// matrix, median ATR, BTC macro, regime, bear policy, the 15m/4h caches, Fear &
// Greed — and reaches the exchange, the stores and the clock only through these
// deps, so tests and the replay run the same code.
const engine = createTradingEngine({
  config, dashboardState, trader, riskManager, regimeTracker, symbolAggregators, signalConfig,
  fetchOHLCV,
  marketContext: { getBtcDominanceTrend, getEthBtcTrend },
  notifyTrade, notifyAlert, pushEvent, recordEquitySnapshot,
  loadEquityHistory, loadNasdaqHistory, loadImpliedVol, loadExchangeEvents: loadVenueEvents,
  sleeveStore: { load: loadSleeveState, save: saveSleeveState },
  modeLabel: (paperMode ? 'paper' : testnetMode ? 'testnet' : 'live').toLowerCase(),
  initialState: { currentRegime: REGIME_LABELS.BULL_RANGE },
});

// Register active strategies and full strategy catalog in the dashboard once at startup
dashboardState.setStrategiesConfig(defaultStrategies);
dashboardState.setStrategyRegistry(getRegistryMeta());
dashboardState.setRuntimeConfig({
  timeframe: config.timeframe,
  pollIntervalMs: config.pollIntervalMs,
  symbols: config.symbols,
  maxOpenPositions: config.risk?.maxOpenPositions ?? 5,
});
const webhookPort = Number(process.env.WEBHOOK_PORT ?? signalConfig.webhook.port);
const dashboardPort = Number(process.env.DASHBOARD_PORT ?? config.dashboard?.port ?? 3001);
const telegramChannelIds = (process.env.TELEGRAM_CHANNEL_IDS?.split(',') ?? signalConfig.telegram.channelIds)
  .map((channelId) => String(channelId).trim())
  .filter(Boolean);

const watchdogLatch = { alerted: false };
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
    // Log the RAW config value and the EFFECTIVE gate side by side — the two
    // diverging silently is what starved the bot through the 2026-07 soak.
    const rawConf = symCfg?.minConfidence ?? config.risk.minConfidence;
    logger.info(`  ${sym}${tag}: strategies=[${strats.join('+')}]  SL=${(risk.stopLossPct*100).toFixed(0)}%  TP=${(risk.takeProfitPct*100).toFixed(0)}%  conf=${rawConf}→${risk.minConfidence.toFixed(3)} (scaled)`);
  }
  logger.info(
    `Risk: balance=${config.risk.initialBalance.toFixed(2)} maxPositionPct=${config.risk.maxPositionPct} stopLossPct=${config.risk.stopLossPct} takeProfitPct=${config.risk.takeProfitPct} trailingStopPct=${config.risk.trailingStopPct ?? 'off'}`,
  );
  logger.info(
    `Risk limits: maxDailyLossPct=${config.risk.maxDailyLossPct} maxOpenPositions=${config.risk.maxOpenPositions} minConfidence=${config.risk.minConfidence} (×${config.risk.confidenceThresholdScale ?? 1} scale → entry gate ${scaleMinConfidence(config.risk.minConfidence).toFixed(3)})`,
  );
  const tsm = config.tsmCore;
  // The active rung is resolved per-cycle from HWM equity (needs trader status),
  // so startup shows the ladder itself; the first cycle logs the selected rung.
  const ladderDesc = Array.isArray(tsm?.equityLadder) && tsm.equityLadder.length
    ? `ladder ${tsm.equityLadder.map((r) => `$${r.minHwmEquity}+→${r.symbols.length}@${r.deploymentPct}`).join(' · ')} (HWM ratchet)`
    : `symbols=${(tsm?.symbols ?? []).join(',')} deploy=${((tsm?.deploymentPct ?? 0.5) * 100).toFixed(0)}% (static)`;
  logger.info(
    `TSM core sleeve: ${tsm?.enabled
      ? `ON (${paperMode ? 'paper' : 'LIVE — real orders'}) ${ladderDesc} lookbacks=${(tsm.lookbackBars ?? []).join('/')} bars`
      : 'OFF'}`,
  );
  logger.info(
    `Signals: webhook=${signalConfig.webhook?.enabled ? `on:${webhookPort}` : 'off'} telegram=${signalConfig.telegram?.enabled ? 'on' : 'off'} algoWeight=${signalConfig.algoWeight} minConfidence=${signalConfig.minConfidence}`,
  );
  const rc = config.regime;
  logger.info(
    `Regime filter: ${rc?.enabled ? `ON — ADX(${rc.adxPeriod}) < ${rc.adxThreshold} blocks BUY signals` : 'OFF'}`,
  );
  const atrCfg = config.atr;
  logger.info(
    `ATR sizing: ${atrCfg?.enabled ? `ON — period=${atrCfg.period}, inverse-vol scaling [0.5×–2×]` : 'OFF'}`,
  );
  const mf = config.macroFilter;
  logger.info(
    `Macro filter: ${mf?.enabled ? `ON — BTC EMA${mf.emaPeriod ?? 200} bear → ${((mf.sizeReduceFactor ?? 0.5) * 100).toFixed(0)}% position size` : 'OFF'}`,
  );
  const cc = config.correlation;
  logger.info(
    `Correlation filter: ${cc?.enabled ? `ON — r > ${cc.threshold} (${cc.period ?? 60} candle window) blocks BUY signals` : 'OFF'}`,
  );
  const mtf = config.mtfFilter;
  logger.info(
    `MTF filter: ${mtf?.enabled ? `ON — 15m×${mtf.alignBars ?? 16} bars, min ${((mtf.minAlignScore ?? 0.5) * 100).toFixed(0)}% green to allow BUY${(mtf.reduceFactor ?? 0) > 0 ? ` (misaligned → ${(mtf.reduceFactor * 100).toFixed(0)}% size)` : ' (misaligned → skip)'}` : 'OFF'}`,
  );
  const mtf4h = config.mtf4hFilter;
  logger.info(
    `4h MTF filter: ${mtf4h?.enabled ? `ON — EMA(8/21)+RSI(14), min score ${((mtf4h.minScore ?? 0.45) * 100).toFixed(0)}%, lookback=${mtf4h.lookback ?? 21}` : 'OFF'}`,
  );
  const rs = config.regimeSizing;
  logger.info(
    `Regime sizing: ${rs?.enabled ? `ON — ADX≥${rs.boostThresh}→${rs.boostFactor}× ADX<${rs.penaltyThresh}→${rs.penaltyFactor}×` : 'OFF'}`,
  );

  if (config.dashboard?.enabled) {
    logger.info(`Dashboard: http://localhost:${dashboardPort}`);
  }

  // Warn clearly when running in PAPER mode (missing Binance keys or explicit PAPER_MODE)
  if (paperMode) {
    logger.warn('Running in PAPER mode: BINANCE_API_KEY and/or BINANCE_API_SECRET not set or PAPER_MODE=true.\n' +
      '  • Dashboard balance uses config.risk.initialBalance (simulated).\n' +
      "  • To enable live/testnet trading, provide keys via environment variables and restart the container.\n" +
      "    Example: docker run --env BINANCE_API_KEY=... --env BINANCE_API_SECRET=... --network host playcryptowithais:latest");
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
            // Payload-wins. The fetch deliberately overlaps the tail of the cache
            // (+5 bars) and the newest cached bar is routinely one a previous boot
            // persisted while it was still forming. The old `!seen.has(ts)` filter
            // dropped the exchange's corrected copy, so that partial bar survived
            // every restart — and got re-saved below, freezing it permanently.
            const before = cached.length;
            cached = mergeCandles(cached, fresh);
            logger.info(`${symbol}: merged ${fresh.length} fetched candles `
              + `(+${cached.length - before} new, payload-wins on overlap)`);
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
  // Use $11 for both paper and live — the paper trader mirrors the Binance $10 minimum
  // notional check, so anything below $10 is silently rejected. $11 clears the floor
  // regardless of mode.
  const testBudget = 11;

  // Pick a symbol that doesn't have an existing open position in trade history.
  // This prevents the smoke-test SELL from polluting history-derived positions
  // on the dashboard (histPosns fallback when the bot is offline).
  const histTrades = dashboardState.getSummary().trades.filter(
    (t) => !String(t.note ?? '').includes('smoke-test'),
  );
  const histSold = new Set(histTrades.filter((t) => t.side === 'SELL').map((t) => t.symbol));
  const histOpen = new Set(histTrades.filter((t) => t.side === 'BUY' && !histSold.has(t.symbol)).map((t) => t.symbol));
  const candidateSymbols = config.symbols.filter((s) => !histOpen.has(s));
  const symbolPool = candidateSymbols.length > 0 ? candidateSymbols : config.symbols;
  const symbol = symbolPool[Math.floor(Math.random() * symbolPool.length)];

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
    // Compute safePct so the notional is exactly testBudget, no percentage cap —
    // the cap (Math.min with 0.02) could produce <$10 on low-balance accounts.
    // Use real config SL/TP — the hold loop never calls checkRisk(), so there's
    // no risk of premature exit during the 10-second hold window.
    const { balance: currentBalance } = await trader.getStatus();
    const safePct = currentBalance > 0 ? testBudget / currentBalance : 0.02;
    const symRiskForSmoke = getRiskForSymbol(symbol);
    const smokeRisk = {
      maxPositionPct:  safePct,
      stopLossPct:     symRiskForSmoke.stopLossPct,
      takeProfitPct:   symRiskForSmoke.takeProfitPct,
      trailingStopPct: 0,
    };

    // ── 3. BUY via main trader so the full execution pipeline is exercised ───
    const buyResult = await trader.execute(symbol, 'BUY', price, smokeRisk);

    if (!buyResult) {
      logger.warn(`🔬 SMOKE TEST — BUY failed for ${symbol} (result=null)`);
      return;
    }

    logger.info(`🔬 SMOKE TEST — ✅ BUY OK  ${symbol}  qty=${buyResult.qty ?? '?'}  price=$${price}`);
    const buyTrade = { ...buyResult, note: '🔬 smoke-test' };
    dashboardState.pushTrade(buyTrade);
    // Push the open position to the dashboard immediately so the positions panel
    // shows the live trade during the hold period.
    dashboardState.updatePrice(symbol, price);
    const statusAfterBuy = await trader.getStatus();
    dashboardState.updateStatus(statusAfterBuy, riskManager.getDailyStats());
    pushEvent('trade', buyTrade);
    pushEvent('cycle', dashboardState.getSummary());

    // ── 4. Hold — refresh price every 3 s so the dashboard PnL updates live ──
    const PRICE_REFRESH_MS = 3000;
    let elapsed = 0;
    let livePrice = price;
    while (elapsed < holdSeconds * 1000) {
      const step = Math.min(PRICE_REFRESH_MS, holdSeconds * 1000 - elapsed);
      await new Promise(r => setTimeout(r, step));
      elapsed += step;
      try {
        const latest = paperMode
          ? Number((await fetchOHLCV(symbol, '1m', 2)).at(-1)?.close ?? livePrice)
          : Number((await fetchTicker(symbol))?.last ?? (await fetchTicker(symbol))?.close ?? livePrice);
        if (latest > 0) {
          livePrice = latest;
          dashboardState.updatePrice(symbol, livePrice);
          pushEvent('prices', { [symbol]: livePrice });
        }
      } catch { /* ignore transient price fetch errors */ }
    }

    // ── 5. SELL via same main trader ─────────────────────────────────────────
    let sellPrice = livePrice;
    try {
      if (paperMode) {
        const c = await fetchOHLCV(symbol, '1m', 2);
        sellPrice = Number(c.at(-1)?.close ?? livePrice);
      } else {
        const t = await fetchTicker(symbol);
        sellPrice = Number(t?.last ?? t?.close ?? livePrice);
      }
    } catch { /* use last known price if fetch fails */ }

    const sellResult = await trader.execute(symbol, 'SELL', sellPrice, smokeRisk);

    if (!sellResult) {
      logger.warn(`🔬 SMOKE TEST — SELL failed for ${symbol} (result=null)`);
      return;
    }

    const pnl = typeof sellResult.pnl === 'number' ? sellResult.pnl.toFixed(4) : 'n/a';
    logger.info(`🔬 SMOKE TEST — ✅ SELL OK  ${symbol}  price=$${sellPrice}  pnl=$${pnl}`);
    logger.info(`🔬 SMOKE TEST — ✅ PASSED — buy/sell pipeline is working correctly`);
    const sellTrade = { ...sellResult, note: '🔬 smoke-test' };
    dashboardState.pushTrade(sellTrade);
    // Clear the position from the dashboard after the SELL.
    const statusAfterSell = await trader.getStatus();
    dashboardState.updateStatus(statusAfterSell, riskManager.getDailyStats());
    pushEvent('trade', sellTrade);
    pushEvent('cycle', dashboardState.getSummary());

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
      // Same frozen-series guard as runCycle — otherwise startup seeds the
      // dashboard with a signal derived from weeks-old bars.
      if (checkCandleFreshness(candles, config.timeframe, config.maxCandleStalenessPeriods).stale) {
        continue;
      }

      const aggregator      = symbolAggregators[symbol];
      const symSignalConfig = getSignalConfigForSymbol(symbol, signalConfig);
      const result          = aggregator.aggregate(withFormingBar(candles, config.timeframe), symbol, symSignalConfig);
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
  // Manual position close: fetch current price then execute a SELL
  const closePosition = async (symbol) => {
    const ticker = await fetchTicker(symbol);
    const price = Number(ticker?.last ?? ticker?.close ?? 0);
    if (!price) throw new Error(`Could not fetch price for ${symbol}`);
    const result = await trader.execute(symbol, 'SELL', price, undefined);
    if (result) {
      const status = await trader.getStatus();
      dashboardState.updateStatus(status, riskManager.getDailyStats());
      dashboardState.pushTrade({ ...result, note: '🖱️ manual close' });
      notifyTrade({ ...result, note: '🖱️ manual close' });
      pushEvent('status', { balance: status.balance });
    }
    return result;
  };
  const resetHistory = async () => {
    dashboardState.clearHistory();
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    writeFileSync(join(runtimeDir('logs'), 'trades.csv'), 'timestamp,symbol,side,price,qty,pnl,balance\n', 'utf8');
    logger.info('[dashboard] Trade history reset');
  };
  dashboardServer = startDashboardServer(dashboardPort, { runSmokeTest, fetchCandles: fetchOHLCV, closePosition, resetHistory, refreshBalance });
}

logStartup();

// Initialize Telegram notifications (send-only — separate from the signal listener)
const notifyChatIds = (process.env.TELEGRAM_CHANNEL_IDS?.split(',') ?? []).map(id => id.trim()).filter(Boolean);
initNotifier(process.env.TELEGRAM_TOKEN, notifyChatIds);
notifyStartup(paperMode ? 'PAPER' : testnetMode ? 'TESTNET' : 'LIVE', config.symbols, {
  timeframe: config.timeframe,
  maxOpenPositions: config.risk?.maxOpenPositions,
  minConfidence: config.risk?.minConfidence,
  mtf: config.mtfFilter?.enabled,
  mtf4h: config.mtf4hFilter?.enabled,
  atr: config.atr?.enabled,
  macro: config.macroFilter?.enabled,
  regimeSizing: config.regimeSizing?.enabled,
  confSizing: config.confSizing?.enabled,
});

// Expose filter config to the dashboard
dashboardState.setActiveFilters({
  regime:       { enabled: config.regime?.enabled ?? false,      adxPeriod: config.regime?.adxPeriod ?? 14,     adxThreshold: config.regime?.adxThreshold ?? 20 },
  correlation:  { enabled: config.correlation?.enabled ?? false, threshold: config.correlation?.threshold ?? 0.8, period: config.correlation?.period ?? 60 },
  breakEven:    { enabled: (config.risk?.breakEvenTriggerPct ?? 0) > 0, triggerPct: config.risk?.breakEvenTriggerPct ?? 0 },
  trailingStop: { enabled: (config.risk?.trailingStopPct ?? 0) > 0, pct: config.risk?.trailingStopPct ?? 0 },
  mtf4hFilter:  { enabled: config.mtf4hFilter?.enabled ?? false, minScore: config.mtf4hFilter?.minScore ?? 0.45 },
  regimeSizing: { enabled: config.regimeSizing?.enabled ?? false, boostThresh: config.regimeSizing?.boostThresh ?? 25, penaltyThresh: config.regimeSizing?.penaltyThresh ?? 15 },
});
await initializeHistoricalData();
// Seed daily P&L from persisted history so the loss limit survives restarts
riskManager.seedFromHistory(dashboardState.getSummary().trades);

// ── Restore in-memory live positions from Binance exchange ───────────────────
// onSyntheticTrade: called when a position is found on Binance but has no
// matching BUY in the trade log (e.g. manual buy, history cleared, first run).
// Writes a synthetic BUY to both the CSV log and the dashboard trade feed.
function recordSyntheticTrade(trade) {
  if (dashboardState.isSyntheticSuppressed(trade.symbol)) {
    logger.info(`[LIVE] ${trade.symbol}: synthetic BUY suppressed (previously deleted)`);
    return;
  }
  appendTrade(trade);
  dashboardState.pushTrade(trade);
  logger.info(`[LIVE] ${trade.symbol}: synthetic BUY added to history (entry=${trade.price} qty=${trade.qty})`);
}

if (!paperMode) {
  const tradeHistory = dashboardState.getSummary().trades;
  const restored = await trader.restorePositionsFromExchange(
    config.symbols, fetchTicker, getRiskForSymbol, tradeHistory, recordSyntheticTrade
  );
  if (restored > 0) {
    const status = await trader.getStatus();
    dashboardState.updateStatus(status, riskManager.getDailyStats());
  }
}

// ── Restore in-memory paper positions from persisted trade history ────────────
// paperTrader.positions is volatile (in-memory Map). On restart it resets to
// empty, causing the dashboard to show no open positions and allowing the risk
// manager to open duplicate BUYs. Rebuild from the trade log: any BUY without
// a matching SELL (excluding smoke-test probes) is an open position.
if (paperMode) {
  const allTrades = dashboardState.getSummary().trades.filter(
    (t) => !String(t.note ?? '').includes('smoke-test'),
  );
  // Set balance from the most-recent trade's recorded balance (already reflects all costs)
  if (allTrades.length > 0 && typeof allTrades[0].balance === 'number' && allTrades[0].balance > 0) {
    trader.balance = allTrades[0].balance;
  }
  // Walk chronologically to find open positions (order-aware: last BUY wins)
  const openTrades = {};
  for (const t of [...allTrades].reverse()) {
    if (t.side === 'BUY')  openTrades[t.symbol] = t;
    if (t.side === 'SELL') {
      // Core resize trims are PARTIAL sells — the position stays open and the
      // record carries its post-resize state (positionQty/positionEntryPrice).
      if (t.reason === 'tsm_core_resize') openTrades[t.symbol] = t;
      else delete openTrades[t.symbol];
    }
  }
  for (const t of Object.values(openTrades)) trader.restorePosition(t);
}
engine.state.correlationMatrix = buildCorrelationMatrix(config.symbols, (sym) => dashboardState.getCandles(sym), config.correlation); // ← built once from full history, then refreshed each cycle
await runInitialSignals();   // ← signals appear instantly from cache
if (process.env.SMOKE_TEST !== 'false') await runSmokeTest();
await engine.runAllSymbols();  // immediate run on startup (SL/TP check + fresh signals)

// ── Align all subsequent cycles to candle-close boundaries ───────────────────
// Binance closes 12h candles at exactly 00:00 and 12:00 UTC. Running on a raw
// setInterval from startup means signals are computed mid-candle. Instead we:
//   1. Wait until the next close boundary (+ 3 s settle buffer)
//   2. Run there, then reschedule off the clock again (see cycleScheduler.js)
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
      // Core keys ('BTC/USDC#core') aren't exchange markets — quote the base.
      const ticker = await fetchTicker(baseSymbol(symbol));
      const price  = Number(ticker?.last ?? ticker?.close ?? 0);
      if (price > 0) {
        dashboardState.updatePrice(symbol, price);
        // Mark the trader's own copy too. dashboardState.getSummary() overlays
        // this price for the dashboard, which is exactly why a stale
        // position.currentPrice stayed invisible for six days — everything
        // reading the RAW getStatus() (equity_history, the sleeve HWM ladder,
        // the %-of-equity brakes) saw the entry price instead. Marking here
        // covers positions with no stops, and paper as well as live.
        trader.markPrice?.(symbol, price);
        updates[symbol] = price;
      }
    }));
    if (Object.keys(updates).length) pushEvent('prices', updates);
  } catch (err) {
    logger.debug(`Price poll error: ${err.message}`);
  }
}
pricePollId = setInterval(() => void refreshOpenPositionPrices(), PRICE_POLL_MS);

// ── Fast risk-check loop ────────────────────────────────────────────────────
// Evaluates stop-loss / trailing / break-even every 2 minutes using ticker prices.
// The main signal cycle only runs every 12h — this catches stop events in between.
// Runs in every mode: paper skipped it, so a paper run met its stops once per cycle
// and could not shadow live (both traders answer checkRisk(symbol, price)).
const RISK_CHECK_MS = 2 * 60_000;
let riskCheckId = null;
{
  async function runRiskChecks() {
    try {
      const status = await trader.getStatus();
      const openPositions = status?.positions ?? [];
      // Resting satellite limit orders need the price too, even with nothing open.
      const pendingSatellites = trader.pendingSatelliteKeys?.() ?? [];
      if (!openPositions.length && !pendingSatellites.length) return;

      logger.debug(`[RISK-LOOP] checking ${openPositions.length} open position(s), ${pendingSatellites.length} resting satellite order(s)`);
      for (const pos of openPositions) {
        if (pos.isSatellite) continue; // below, with the resting orders
        // Core sleeve positions have no stops, so there is no SL/TP to manage —
        // but checkRisk is still the ONLY writer of position.currentPrice, and
        // skipping it froze the raw getStatus() valuation at the open/restore
        // price for the whole life of the position. dashboardState.getSummary()
        // hid that by overriding currentPrice from its own price map, so the
        // dashboard looked right while equity_history.json, the sleeve's HWM
        // ladder and every %-of-equity risk gate read a six-day-stale number.
        // Mark the price first, then retry a vote-flip exit that failed earlier.
        if (pos.isCore) {
          try {
            const ticker = await fetchTicker(baseSymbol(pos.symbol));
            const price = Number(ticker?.last ?? ticker?.close ?? 0);
            if (price > 0) {
              dashboardState.updatePrice(pos.symbol, price);
              await trader.checkRisk(pos.symbol, price);

              if (engine.state.tsmCoreFailedCloses.has(pos.symbol)) {
                const retried = await trader.closeCorePosition(pos.symbol, price);
                if (retried) {
                  engine.state.tsmCoreFailedCloses.delete(pos.symbol);
                  engine.noteCoreExit(pos.symbol);
                  logger.info(`[RISK-LOOP] ${pos.symbol}: core close retry succeeded`);
                  dashboardState.pushTrade(retried);
                  notifyTrade(retried);
                  pushEvent('trade', retried);
                }
              }
            }
          } catch (err) {
            logger.debug(`[RISK-LOOP] ${pos.symbol}: core check failed — ${err.message}`);
          }
          continue;
        }
        try {
          const ticker = await fetchTicker(pos.symbol);
          const price = Number(ticker?.last ?? ticker?.close ?? 0);
          if (price <= 0) continue;

          await engine.onPriceTick(pos.symbol, price);
        } catch (err) {
          logger.debug(`[RISK-LOOP] ${pos.symbol}: check failed — ${err.message}`);
        }
      }

      // Satellites (config.satellites): a resting limit fills or expires, a position runs
      // its exit plan (src/engine/satellites.js). At the first tick after an hour closes,
      // the tier rule reads that hour's RSI.
      const satelliteKeys = new Set([...pendingSatellites, ...openPositions.filter((p) => p.isSatellite).map((p) => p.symbol)]);
      for (const key of satelliteKeys) {
        try {
          const market = baseSymbol(key);
          const ticker = await fetchTicker(market);
          const price = Number(ticker?.last ?? 0);
          if (price <= 0) continue;
          const held = openPositions.some((p) => p.symbol === key);
          await engine.onSatelliteTick(key, price, held ? await satelliteHourContext(key, market) : {});
        } catch (err) {
          logger.debug(`[RISK-LOOP] ${key}: satellite check failed — ${err.message}`);
        }
      }
    } catch (err) {
      logger.debug(`[RISK-LOOP] error: ${err.message}`);
    }
  }
  // The hour each satellite position last had its tier rule read, so it reads once per hour.
  const satelliteLastHour = new Map();
  async function satelliteHourContext(key, market) {
    const hourClose = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    if (satelliteLastHour.get(key) === hourClose) return {};
    satelliteLastHour.set(key, hourClose);
    const bars = await fetchOHLCV(market, '1h', 300);
    return { rsi: rsiOfLastClosedBar(withFormingBar(bars, '1h', Date.now()).slice(0, -1)), hourClosed: true };
  }

  riskCheckId = setInterval(() => void runRiskChecks(), RISK_CHECK_MS);
  logger.info(`Risk-check loop active: every ${RISK_CHECK_MS / 1000}s for open positions`);
}

// ── MTF candle cache refresh ────────────────────────────────────────────────
// Pre-fetch 15m and 4h candles for all symbols on timers matching their period.
// This eliminates per-BUY API calls and keeps filter data fresh.


// Initial warm-up + periodic refresh
if (config.mtfFilter?.enabled) {
  // Warm-up only; every cycle refreshes it right after the close (follow-ups item 9).
  void engine.refreshMtfCache('15m', engine.mtf15mCache, 24);
  logger.info('MTF 15m cache: refreshed at each cycle');
}
if (config.mtf4hFilter?.enabled) {
  void engine.refreshMtfCache('4h', engine.mtf4hCache, 30);
  logger.info('MTF 4h cache: refreshed at each cycle');
}

// ── Market context cache (Phase 3) — BTC.D + ETHBTC ────────────────────────
// Load Fear & Greed history once (its own TTL handles staleness). Refresh
// market context (BTC.D, ETHBTC) on the configured interval so the BTC.D
// gate + sizing modulators have fresh values without bothering on every cycle.
let marketContextRefreshId = null;
void loadFearGreedHistory().then((data) => {
  engine.state.fearGreedData = data;
  if (data) logger.info(`Fear & Greed history loaded: ${data.length} daily samples`);
}).catch((err) => logger.error(`Fear & Greed history load failed: ${err?.message ?? err}`));
if (config.btcDominance?.enabled) {
  const ms = Number(config.btcDominance.refreshIntervalMs ?? 6 * 60 * 60 * 1000);
  void refreshMarketContext()
    .then(() => {
      marketContextRefreshId = setInterval(
        () => void refreshMarketContext().catch((err) => logger.error(`Market context refresh failed: ${err?.message ?? err}`)),
        ms,
      );
    })
    .catch((err) => logger.error(`Market context refresh failed: ${err?.message ?? err}`));
  logger.info(`Market context cache: refresh every ${(ms / 3_600_000).toFixed(1)}h`);
}

// Research recorder (plan doc § H): feeds no decision, so it runs on its own timer
// and a failure only logs.
let gaugeRecorderId = null;
if (config.gaugeRecorder?.enabled) {
  const recordGauges = async () => {
    for (const r of await recordSnapshots({ minGapMs: config.gaugeRecorder.minGapMs })) {
      if (r.status === 'recorded') logger.info(`[GAUGES] ${r.asset} exchange-flow snapshot recorded (${r.rows.length} rows)`);
      else if (r.status === 'failed') logger.warn(`[GAUGES] ${r.asset} snapshot not recorded: ${r.error}`);
    }
  };
  void recordGauges();
  gaugeRecorderId = setInterval(() => void recordGauges(), config.gaugeRecorder.checkEveryMs);
  gaugeRecorderId.unref?.();
}

// Refresh the balance from the exchange every 5 minutes so that deposits or
// withdrawals are reflected on the dashboard without waiting for the next trade.
// Paper mode skips this — its balance is already tracked in memory.
const BALANCE_POLL_MS = 5 * 60_000;
let balancePollId = null;
async function refreshBalance() {
  if (paperMode) return;
  try {
    await trader.restorePositionsFromExchange(
      config.symbols, fetchTicker, getRiskForSymbol, dashboardState.getSummary().trades, recordSyntheticTrade
    );
    const status = await trader.getStatus();
    dashboardState.updateStatus(status, riskManager.getDailyStats());
    // Daily valuation point for time-weighted return — without it a deposit
    // can't be separated from performance. No-ops after the first write each day.
    recordEquitySnapshot(calcEquityFromStatus(status));
    pushEvent('status', { balance: status.balance });
  } catch (err) {
    logger.debug(`Balance poll error: ${err.message}`);
  }
}
if (!paperMode) {
  balancePollId = setInterval(() => void refreshBalance(), BALANCE_POLL_MS);
}

// Self-rescheduling and candle-aligned — see src/core/cycleScheduler.js for why
// the previous setInterval handoff drifted 6h09m off close for 48 cycles.
const cycleScheduler = createAlignedScheduler({
  timeframe: config.timeframe,
  run: () => engine.runAllSymbols(),
  isStopped: () => shuttingDown,
  onSchedule: (at) => {
    dashboardState.setNextRunAt(at);
    logger.info(`Next cycle aligned to candle close in ${Math.round((at - Date.now()) / 60_000)} min (${new Date(at).toUTCString()})`);
  },
  onError: (err) => {
    const message = `Cycle run failed — ${err.message}`;
    logger.error(message);
    dashboardState.pushError(message);
  },
});

cycleScheduler.start();

// ── Satellite breakout cycle (config.satellites) — every 4h close ─────────────────
// One minute after the close; at 00:00 and 12:00 it waits for the 12h cycle, so the
// scalper and the sleeve have first call on the cash, as in the replay.
let satelliteScheduler = null;
if (config.satellites?.enabled && config.satellites.breakout?.enabled) {
  satelliteScheduler = createAlignedScheduler({
    timeframe: config.satellites.breakout.timeframe ?? '4h',
    bufferMs: 60_000,
    run: async () => {
      for (let waited = 0; engine.state.cycleInProgress && waited < 15 * 60_000; waited += 5_000) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
      await engine.runSatelliteCycle('breakout');
    },
    isStopped: () => shuttingDown,
    onSchedule: (at) => logger.info(`[SATELLITE] next breakout cycle in ${Math.round((at - Date.now()) / 60_000)} min (${new Date(at).toUTCString()})`),
    onError: (err) => logger.error(`[SATELLITE] breakout cycle failed — ${err.message}`),
  });
  satelliteScheduler.start();
}

// ── Cycle watchdog (deadman alert) ──────────────────────────────────────────
// Alerts on the ABSENCE of completed cycles: the July 2026 host suspend stalled
// the loop 18h and skewed it for 24 days with zero alerts, because a dead
// process emits no error. Checks every 30 min; fires once per incident via
// Telegram and re-arms when cycles resume.
const CYCLE_WATCHDOG_MS = 30 * 60_000;
const cycleWatchdogId = setInterval(() => {
  const { stale, gapMs, thresholdMs } = checkCycleGap({
    lastCycleAt: engine.state.lastCycleAt, now: Date.now(), periodMs: config.pollIntervalMs,
  });
  const { fire, recovered } = updateWatchdogLatch(watchdogLatch, stale);
  if (fire) {
    const hours = (gapMs / 3_600_000).toFixed(1);
    const message = `⏰ WATCHDOG: no completed trading cycle in ${hours}h `
      + `(threshold ${(thresholdMs / 3_600_000).toFixed(1)}h). Host suspended or loop hung — `
      + `the bot is NOT making decisions. Last cycle: ${new Date(engine.state.lastCycleAt).toUTCString()}.`;
    logger.error(message);
    void notifyAlert(message);
  } else if (recovered) {
    logger.info('[WATCHDOG] cycles resumed — re-armed');
    void notifyAlert('✅ WATCHDOG: trading cycles resumed.');
  }
}, CYCLE_WATCHDOG_MS);
cycleWatchdogId.unref?.();

process.on('SIGINT', () => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  cycleScheduler.stop();
  satelliteScheduler?.stop();
  clearInterval(pricePollId);
  clearInterval(balancePollId);
  clearInterval(riskCheckId);
  clearInterval(marketContextRefreshId);
  clearInterval(gaugeRecorderId);
  logger.info('SIGINT received, shutting down gracefully');
  void logShutdown().finally(() => process.exit(0));
});

process.on('unhandledRejection', (error) => {
  const message = `Unhandled rejection: ${error instanceof Error ? error.message : String(error)}`;
  logger.error(message);
  dashboardState.pushError(message);
  pushEvent('error', { message, timestamp: Date.now() });
});

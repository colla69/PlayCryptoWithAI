import 'dotenv/config';
// ccxt and telegram-bot-api each attach multiple process signal listeners —
// raise the limit to suppress the false-positive MaxListeners warning.
process.setMaxListeners(50);
import config from '../config/default.js';
import { fetchOHLCV, fetchHistoricalOHLCV, fetchTicker, paperMode, testnetMode } from './exchange/binanceClient.js';
import { loadCachedCandles, saveCachedCandles } from './exchange/candleCache.js';
import SignalAggregator from './engine/signalAggregator.js';
import PaperTrader from './executor/paperTrader.js';
import { LiveTrader } from './executor/liveTrader.js';
import RiskManager from './risk/index.js';
import { calcPositionAgingExit, calcWeeklyDDBreaker, calcEquityFromStatus } from './risk/portfolioRisk.js';
import { computeLiveStats, evaluateDrift } from './monitor/driftMonitor.js';
import { checkCycleGap, updateWatchdogLatch } from './monitor/cycleWatchdog.js';
import { startCopyTrading, startTelegramListener, startTwitterSentiment, startWebhookServer } from './signals/index.js';
import { getRegistryMeta } from './strategies/index.js';
import logger, { appendTrade } from './utils/logger.js';
import { isMarketTrending, computeATRPct, isBullTrend } from './utils/indicators.js';
import { dashboardState, startDashboardServer, pushEvent } from './dashboard/index.js';
import { recordEquitySnapshot, loadEquityHistory } from './dashboard/equityHistory.js';
import { initNotifier, notifyTrade, notifyStartup, notifyAlert } from './notifications/index.js';
import { mtfAlignScore, mtf4hMomentumScore } from './utils/mtfAlignment.js';
import { runEntryFilters } from './core/filters.js';
import { calcFearGreedAdjustedThreshold } from './core/filters.js';
import { loadFearGreedHistory, getFearGreedValue } from './data/fearGreed.js';
import { refreshMarketContext, getBtcDominanceTrend, getEthBtcTrend } from './data/marketContext.js';
import { RegimeTracker, REGIME_LABELS } from './engine/regimeClassifier.js';
import { computeBearPolicy, resolveStrategyList, DEFAULT_REGIME_BUNDLES } from './engine/regimeRouter.js';
import { computePositionSize } from './core/positionSizing.js';
import { computeTsmVote, planCoreActions, planCoreResize, computeRealizedVolAnnual, computeTargetFraction, coreKey, baseSymbol, selectSleeveRung, sleeveFeasibility } from './engine/tsmCore.js';
import { loadNasdaqHistory, computeEquityRiskOff } from './data/nasdaqTrend.js';
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
import { checkCandleFreshness, formatAge } from './utils/candleFreshness.js';
import { createAlignedScheduler } from './core/cycleScheduler.js';

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

// ── Correlation filter state ───────────────────────────────────────────────────
// Rebuilt after candle init and after each cycle so it always reflects recent data.
let correlationMatrix = {};

// ── MTF candle cache (15m + 4h) ───────────────────────────────────────────────
// Stores last-fetched candles keyed by symbol. Refreshed every 15m / 4h respectively.
// Filters read from these caches instead of hitting the exchange API each cycle.
const mtf15mCache = new Map(); // symbol → Candle[]
const mtf4hCache  = new Map(); // symbol → Candle[]

// ── ATR position sizing state ─────────────────────────────────────────────────
// Median ATR% across all symbols, updated once per cycle in runAllSymbols().
// Used in runCycle to scale individual position sizes inversely to volatility.
let medianATRPct = null;

// ── BTC macro filter state ────────────────────────────────────────────────────
// True when BTC price is above its EMA(200) — normal sizing applies.
// False in bear phase — new positions are opened at sizeReduceFactor × base size.
let btcMacroBull = true;

// ── Fear & Greed history (Phase 3) ───────────────────────────────────────────
// Loaded once at startup; refreshed daily by loadFearGreedHistory's own TTL.
let fearGreedData = null;

// ── BTC Regime classifier (Phase 4) ──────────────────────────────────────────
// One stateful tracker shared across all symbols. Updated at the start of each
// cycle from BTC candles. Current regime is exposed on dashboardState for the
// UI and used by routing/filters/sizing decisions.
const regimeTracker = new RegimeTracker(config.regimeClassifier ?? {});
let currentRegime = REGIME_LABELS.BULL_RANGE;
// Latest bear-policy decision, computed once per cycle in runAllSymbols
// and consumed by runCycle to block new entries.
let bearPolicy = { shouldBlockEntries: false, shouldCashExitOpen: false };

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

let cycleInProgress = false;
// Watchdog heartbeat: ms timestamp of the last COMPLETED cycle (null until the
// first one). Declared here because runAllSymbols writes it and executes before
// the watchdog block at the bottom of this file is reached.
let lastCycleAt = null;
const watchdogLatch = { alerted: false };
const driftAlertLatch = { alerted: false };
let shuttingDown = false;
let webhookApp = null;
let telegramBot = null;
let twitterSentimentService = null;
let copyTradingService = null;
let dashboardServer = null;

function medianOfArray(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

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

    // ── Stale-series guard ───────────────────────────────────────────────────
    // A thin or delisted market still returns klines, they just stop advancing.
    // The `!freshCandles.length` check above misses that entirely: during the
    // 2026-07 soak LSK/TON/GMX fed frozen bars to the aggregator for weeks,
    // each emitting an identical confidence every cycle. They stayed HOLD so
    // nothing was lost, but a frozen series can just as easily emit a BUY and
    // the bot would enter an illiquid market at a stale price.
    const freshness = checkCandleFreshness(
      candles, config.timeframe, config.maxCandleStalenessPeriods,
    );
    if (freshness.stale) {
      const message = `${symbol}: candle series stale (newest bar ${formatAge(freshness.ageMs)} old) — skipping cycle`;
      logger.warn(message);
      dashboardState.pushError(message);
      return;
    }

    logger.debug(`[CYCLE] ${symbol}: starting cycle, candles=${candles.length} lastClose=${Number(candles.at(-1).close).toFixed(8)} lastTs=${new Date(candles.at(-1).timestamp).toISOString()}`);

    const aggregator = symbolAggregators[symbol];
    const symSignalConfig = getSignalConfigForSymbol(symbol, signalConfig);
    const result = aggregator.aggregate(candles, symbol, symSignalConfig);
    const currentPrice = Number(candles.at(-1).close);
    const currentStatus = await trader.getStatus();
    const symRisk = getRiskForSymbol(symbol);
    const hasPosition = currentStatus.positions.some((p) => p.symbol === symbol);

    // ── Position aging exit (Phase 7) ────────────────────────────────────────
    // Close positions open more than maxAgeBars without hitting TP/SL.
    // Runs BEFORE the BUY/SELL decision so an aging exit frees the slot for
    // a new entry candidate this same cycle.
    const agingCfg = config.risk?.positionAgingExit;
    if (agingCfg?.enabled && hasPosition) {
      const myPos = currentStatus.positions.find((p) => p.symbol === symbol);
      if (myPos && myPos.openedAt) {
        const aging = calcPositionAgingExit({
          entryTs: new Date(myPos.openedAt).getTime(),
          nowTs: Date.now(),
          candleIntervalMs: Number(config.pollIntervalMs ?? 12 * 60 * 60 * 1000),
          maxAgeBars: Number(agingCfg.maxAgeBars ?? 14),
        });
        if (aging.shouldExit) {
          logger.info(`${symbol}: ${aging.reason}`);
          const agingExit = await trader.execute(symbol, 'SELL', currentPrice, symRisk);
          if (agingExit) {
            dashboardState.pushTrade(agingExit);
            if (typeof agingExit.pnl === 'number') riskManager.recordTrade(agingExit.pnl);
            notifyTrade(agingExit);
            pushEvent('trade', agingExit);
            return; // skip the rest of the cycle for this symbol
          }
        }
      }
    }

    // ── Easier SELL for open positions: lower confidence threshold ────────────
    // If we already hold this symbol and the aggregator says SELL but confidence
    // fell below minConfidence (decision forced to HOLD), re-check at a lower bar.
    // Exiting a position requires less conviction than entering one.
    if (hasPosition && result.decision === 'HOLD') {
      const sellVotes = result.signals.filter((s) => s.signal === 'SELL').length;
      const totalStrategies = result.signals.length;
      const sellMajority = totalStrategies > 0 && sellVotes > totalStrategies / 2;
      const sellThreshold = (symSignalConfig.minConfidence ?? 0.7) * 0.7; // 30% lower bar for exits
      if (sellMajority && result.confidence >= sellThreshold) {
        result.decision = 'SELL';
        logger.info(`${symbol}: SELL threshold lowered for exit (conf=${result.confidence.toFixed(2)} ≥ ${sellThreshold.toFixed(2)})`);
      }
    }

    // ── Entry filters: regime, correlation, MTF ──────────────────────────────
    let blockReason = null;
    let mtfSizeFactor = 1.0;
    if (result.decision === 'BUY') {
      // Phase 6a: hard bear-policy block runs BEFORE the regular filter stack
      // so we don't waste cycles on filters for a guaranteed-blocked entry.
      if (bearPolicy.shouldBlockEntries) {
        blockReason = bearPolicy.reason ?? 'bear regime — entries disabled';
        logger.info(`${symbol}: BUY suppressed — ${blockReason}`);
      } else {
        // Use cached MTF candles — falls back to live fetch and warms cache
        const cachedFetchOHLCV = async (sym, tf, limit) => {
          if (tf === '15m' && mtf15mCache.has(sym)) return mtf15mCache.get(sym).slice(-(limit ?? 20));
          if (tf === '4h' && mtf4hCache.has(sym)) return mtf4hCache.get(sym).slice(-(limit ?? 30));
          const fresh = await fetchOHLCV(sym, tf, limit);
          if (fresh.length) {
            const cache = tf === '15m' ? mtf15mCache : mtf4hCache;
            cache.set(sym, fresh);
          }
          return fresh;
        };
        // Core sleeve positions are excluded so the beta sleeve doesn't trip
        // the scalper's correlation cap or distort its risk gates.
        const filterResult = await runEntryFilters({
          symbol, candles, openPositions: currentStatus.positions.filter((p) => !p.isCore),
          correlationMatrix, fetchOHLCV: cachedFetchOHLCV, config,
          recentTrades: dashboardState.getTrades?.() ?? [],
          // Live equity so the weekly DD breaker scales with the account;
          // configured initialBalance only until the first good reading
          referenceEquity: calcEquityFromStatus(currentStatus) || (config.risk?.initialBalance ?? 0),
        });
        blockReason = filterResult.blockReason;
        mtfSizeFactor = filterResult.mtfSizeFactor;
      }
    }

    // Track filter-level blocks for the dashboard counter
    if (blockReason) dashboardState.pushBlockedSignal(blockReason);

    // ── Fear & Greed entry threshold modulator (Phase 3) ────────────────────
    // Adjusts minConfidence based on current sentiment. Greed > 80 demands
    // more conviction (tighten); Fear < 20 allows easier contrarian entry.
    const fgValue = fearGreedData
      ? getFearGreedValue(fearGreedData, Date.now())
      : 50;
    const fgAdjusted = calcFearGreedAdjustedThreshold(
      symRisk.minConfidence,
      fgValue,
      config.fearGreed,
    );
    if (fgAdjusted.regime !== 'neutral') {
      logger.debug(`${symbol}: F&G ${fgValue} ${fgAdjusted.regime} → minConf ${symRisk.minConfidence.toFixed(2)} → ${fgAdjusted.minConfidence.toFixed(2)}`);
    }

    const tradeCheck = blockReason
      ? { allowed: false, reason: blockReason }
      : riskManager.canTrade(symbol, result.decision, result.confidence, currentStatus, fgAdjusted.minConfidence);
    let tradeResult = null;

    // ── Position sizing chain (extracted to src/core/positionSizing.js) ──────
    const positionPct = computePositionSize({
      basePct: symRisk.maxPositionPct,
      candles, medianATRPct, btcMacroBull,
      confidence: result.confidence,
      mtfSizeFactor, config,
    });

    logger.debug(`[CYCLE] ${symbol}: sizing positionPct=${positionPct.toFixed(4)} (base=${symRisk.maxPositionPct} atr=${config.atr?.enabled ? (medianATRPct ?? 'n/a') : 'off'} regime=${config.regimeSizing?.enabled ? 'on' : 'off'} conf=${config.confSizing?.enabled ? (result.confidence ?? 0).toFixed(2) : 'off'} macro=${config.macroFilter?.enabled ? (btcMacroBull ? 'bull' : 'bear') : 'off'} mtf=${mtfSizeFactor < 1.0 ? mtfSizeFactor.toFixed(2) : '1.0'})`);

    // Compute the symbol's current ATR% so the trader's ATR-stops path can use it.
    // No-op when risk.atrStops.enabled is false.
    const symbolATRPct = computeATRPct(candles, config.atr?.period ?? 14);
    const effectiveRisk = {
      ...symRisk,
      maxPositionPct: positionPct,
      atrPct: Number.isFinite(symbolATRPct) ? symbolATRPct : undefined,
    };

    if (!tradeCheck.allowed) {
      logger.info(`${symbol}: trade blocked - ${tradeCheck.reason}`);
    } else {
      tradeResult = await trader.execute(symbol, result.decision, currentPrice, effectiveRisk);

      if (tradeResult) {
        logger.info(`[CYCLE] ${symbol}: TRADE EXECUTED → ${tradeResult.side} qty=${tradeResult.qty ?? 'n/a'} price=${tradeResult.entryPrice ?? tradeResult.exitPrice ?? 'n/a'}`);
        if (typeof tradeResult.pnl === 'number' && tradeResult.side === 'SELL') {
          riskManager.recordTrade(tradeResult.pnl);
        }
        dashboardState.pushTrade(tradeResult);
        notifyTrade(tradeResult);
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
    correlationMatrix = buildCorrelationMatrix(config.symbols, (sym) => dashboardState.getCandles(sym), config.correlation);

    // Log correlation pairs above threshold
    if (config.correlation?.enabled) {
      const threshold = config.correlation.threshold ?? 0.8;
      const pairs = [];
      const syms = config.symbols;
      for (let i = 0; i < syms.length; i++) {
        for (let j = i + 1; j < syms.length; j++) {
          const r = correlationMatrix[syms[i]]?.[syms[j]] ?? 0;
          if (r > threshold) pairs.push(`${syms[i].split('/')[0]}/${syms[j].split('/')[0]}=${r.toFixed(2)}`);
        }
      }
      if (pairs.length) logger.debug(`[CYCLE] Correlated pairs (r>${threshold}): ${pairs.join(', ')}`);
    }

    // ATR sizing: compute portfolio median ATR% so each symbol can be scaled relative to it
    if (config.atr?.enabled) {
      const atrPcts = config.symbols
        .map((sym) => computeATRPct(dashboardState.getCandles(sym), config.atr.period))
        .filter((v) => v != null && v > 0);
      medianATRPct = atrPcts.length ? medianOfArray(atrPcts) : null;
      logger.debug(`[CYCLE] ATR sizing: medianATRPct=${medianATRPct != null ? (medianATRPct * 100).toFixed(2) + '%' : 'n/a'} (${atrPcts.length} symbols)`);
    }

    // Macro filter: check BTC vs EMA(200) to determine portfolio-level bear phase
    if (config.macroFilter?.enabled) {
      const prevBull = btcMacroBull;
      btcMacroBull = isBullTrend(dashboardState.getCandles('BTC/USDC'), config.macroFilter.emaPeriod ?? 200);
      logger.debug(`[CYCLE] BTC macro: bull=${btcMacroBull} EMA${config.macroFilter.emaPeriod ?? 200}`);
      if (btcMacroBull !== prevBull) {
        const factor = (config.macroFilter.sizeReduceFactor ?? 0.5) * 100;
        logger.warn(
          `Macro filter: BTC ${btcMacroBull ? 'ABOVE' : 'BELOW'} EMA${config.macroFilter.emaPeriod ?? 200} — ` +
          `new positions ${btcMacroBull ? 'normal size' : `reduced to ${factor.toFixed(0)}%`}`,
        );
      }
    }

    // ── Regime classifier (Phase 4) ────────────────────────────────────────
    // Update once per cycle from BTC candles (closed bars only — slice off the
    // forming one). Reports current regime; future routing/sizing changes
    // will branch off `currentRegime`.
    let regimeChanged = false;
    {
      const btc = dashboardState.getCandles('BTC/USDC');
      if (btc.length > 0) {
        const closed = btc.slice(0, -1);
        const snap = regimeTracker.update(closed, Date.now());
        const prev = currentRegime;
        currentRegime = snap.regime;
        regimeChanged = snap.regimeChanged;
        if (regimeChanged) {
          logger.warn(`[REGIME] BTC regime change: ${prev} → ${currentRegime}  (ADX ${snap.raw.adx} BTC ${snap.raw.btcClose.toFixed(0)} vs EMA200 ${snap.raw.ema200.toFixed(0)})`);
        } else {
          logger.debug(`[REGIME] ${currentRegime}  candidate=${snap.candidate ?? '-'} streak=${snap.streak}  (ADX ${snap.raw?.adx ?? 'n/a'})`);
        }
        // Surface regime to the dashboard (Phase 9 — append-only observability)
        dashboardState.setRegime({
          label: currentRegime,
          previous: prev,
          candidate: snap.candidate ?? null,
          streak: snap.streak ?? 0,
          adx: snap.raw?.adx ?? null,
          btcClose: snap.raw?.btcClose ?? null,
          ema200: snap.raw?.ema200 ?? null,
          changedAt: regimeTracker.changedAt,
          history: regimeTracker.history.slice(-10),
        });
      }
    }

    // ── Phase 6a: cash-exit on bear regime ──────────────────────────────────
    // When BTC regime transitions INTO BEAR_TREND or BEAR_CHOP, close ALL
    // open positions this cycle. Subsequent bars in the same bear regime
    // continue to block new entries via runEntryFilters (see bear-policy
    // check) but do NOT repeatedly force-close — open positions are managed
    // normally by SL/TP/break-even.
    bearPolicy = computeBearPolicy({
      regime: currentRegime,
      regimeChanged,
      policy: config.bearPolicy,
    });

    // Surface cross-asset context + circuit-breaker status (Phase 9 — append-only)
    {
      const fgValue = fearGreedData ? getFearGreedValue(fearGreedData, Date.now()) : null;
      dashboardState.setMarketContext({
        btcDominance: getBtcDominanceTrend(),
        ethBtc: getEthBtcTrend(),
        fearGreed: Number.isFinite(fgValue) ? fgValue : null,
      });
      const ddCfg = config.risk?.weeklyDDBreaker ?? {};
      let ddEquity = 0;
      try {
        ddEquity = calcEquityFromStatus(await trader.getStatus());
      } catch {
        // fall back to configured balance below
      }
      const ddBreaker = calcWeeklyDDBreaker({
        recentTrades: dashboardState.getTrades(),
        referenceEquity: ddEquity > 0 ? ddEquity : (config.risk?.initialBalance ?? 1000),
        lossThreshold: ddCfg.lossThreshold ?? 0.10,
        cooldownHours: ddCfg.cooldownHours ?? 72,
      });
      dashboardState.setCircuitBreaker({
        bearEntriesBlocked: !!bearPolicy.shouldBlockEntries,
        bearReason: bearPolicy.reason ?? null,
        weeklyDDActive: (ddCfg.enabled !== false) && !!ddBreaker.blocked,
        weeklyPnLPct: ddBreaker.weeklyPnLPct ?? 0,
        cooldownEndsAt: ddBreaker.cooldownEndsAt ?? null,
      });
    }

    // ── Live drift monitor (Phase 8) ────────────────────────────────────────
    // Compare rolling per-trade live performance vs the backtest reference;
    // warn + notify when it drifts beyond the statistical band. Log-only until
    // monitor.driftRefSharpe is configured.
    const monCfg = config.monitor ?? {};
    if (monCfg.enabled !== false) {
      const live = computeLiveStats(dashboardState.getTrades(), { windowDays: monCfg.windowDays ?? 30 });
      const drift = evaluateDrift({
        liveSharpe: live.sharpe,
        refSharpe: monCfg.driftRefSharpe ?? null,
        nLive: live.n,
        zThreshold: monCfg.zThreshold ?? 2,
        minTrades: monCfg.minTrades ?? 10,
      });
      if (drift.alert) {
        const msg = `[DRIFT] ${drift.reason} — live ${(live.winRate*100).toFixed(0)}% WR, mean ${(live.meanReturn*100).toFixed(2)}%/trade`;
        logger.warn(msg);
        // Telegram once per incident — a log line alone went unread for 24 days
        // in the July soak. Re-arms when drift clears.
        if (!driftAlertLatch.alerted) {
          driftAlertLatch.alerted = true;
          void notifyAlert(`📉 ${msg}`);
        }
      } else {
        driftAlertLatch.alerted = false;
        logger.debug(`[DRIFT] ${drift.reason} (n=${live.n}, WR ${(live.winRate*100).toFixed(0)}%)`);
      }
    }

    if (bearPolicy.shouldCashExitOpen) {
      const status = await trader.getStatus();
      // TSM core positions respond to regime via their own momentum flip —
      // the bear cash-exit only manages scalper positions.
      const open = (status.positions ?? []).filter((p) => !p.isCore);
      if (open.length > 0) {
        logger.warn(`[PHASE6A] BEAR regime entered — closing ${open.length} open position(s): ${open.map((p) => p.symbol).join(', ')}`);
        for (const pos of open) {
          try {
            const exitResult = await trader.execute(pos.symbol, 'SELL', pos.currentPrice ?? pos.entryPrice, getRiskForSymbol(pos.symbol));
            if (exitResult) {
              dashboardState.pushTrade(exitResult);
              if (typeof exitResult.pnl === 'number') riskManager.recordTrade(exitResult.pnl);
              notifyTrade(exitResult);
              pushEvent('trade', exitResult);
            }
          } catch (err) {
            logger.error(`[PHASE6A] failed to close ${pos.symbol}: ${err?.message ?? err}`);
          }
        }
      }
    }

    await Promise.all(config.symbols.map((symbol) => runCycle(symbol)));

    // TSM core sleeve reconciles AFTER the scalper cycle so it reads the
    // candles that runCycle just refreshed in dashboardState.
    await runTsmCoreCycle();

    // Daily valuation point for time-weighted return. Recorded here rather than
    // in refreshBalance (live-only) or runRiskChecks (early-returns with no open
    // positions) so a paper soak builds the same series a live account does.
    try {
      recordEquitySnapshot(calcEquityFromStatus(await trader.getStatus()));
    } catch (err) {
      logger.debug(`Equity snapshot skipped: ${err.message}`);
    }

    // Watchdog heartbeat — only a COMPLETED cycle counts as alive.
    lastCycleAt = Date.now();
  } finally {
    cycleInProgress = false;
  }
}

// ── TSM majors core sleeve ────────────────────────────────────────────────────
// Once per cycle: recompute the momentum majority vote per core symbol and
// reconcile positions (open on flip-on, close on flip-off — no other exits).
// The sleeve is independent of the scalper: core positions skip stop
// management, entry filters, and bear cash-exit, and their PnL intentionally
// does NOT feed riskManager's daily-loss accounting. Execution follows the
// session's trader instance: PaperTrader simulates, LiveTrader places REAL
// market orders — TSM_CORE=true is the deliberate opt-in in either mode.
// Vote-flip exits that fail on the exchange are alerted immediately and
// retried by the fast risk loop (live) instead of waiting 12h.
const tsmCoreFailedCloses = new Set();
// Rung bookkeeping: alert on transitions, and only once per boot on infeasibility.
let tsmLastRungKey = null;
let tsmFeasibilityAlerted = false;
async function runTsmCoreCycle() {
  const coreCfg = config.tsmCore ?? {};
  if (!coreCfg.enabled) return;
  // Fresh cycle re-decides everything — stale retry flags would otherwise
  // outlive a vote that flipped back on.
  tsmCoreFailedCloses.clear();
  try {
    const status = await trader.getStatus();

    // ── Equity-ladder rung selection (HWM ratchet) ──────────────────────────
    // Sizing keys off the account's all-time-high equity, never current equity:
    // wins and deposits both step risk DOWN a rung; a drawdown never steps it
    // back up. See config.tsmCore.equityLadder for the rung rationale.
    const currentEquity = calcEquityFromStatus(status);
    const hwmEquity = Math.max(
      currentEquity,
      ...loadEquityHistory().map((p) => Number(p.equity) || 0),
    );
    const rung = selectSleeveRung(hwmEquity, coreCfg.equityLadder);
    const active = rung
      ? { ...coreCfg, symbols: rung.symbols, deploymentPct: rung.deploymentPct }
      : coreCfg;
    const nextRung = rung
      ? (coreCfg.equityLadder ?? [])
        .filter((r) => Number(r.minHwmEquity) > Number(rung.minHwmEquity))
        .sort((a, b) => Number(a.minHwmEquity) - Number(b.minHwmEquity))[0] ?? null
      : null;
    const rungKey = `${(active.symbols ?? []).length}@${active.deploymentPct}`;
    logger.info(
      `[TSM-CORE] rung ${rungKey} (HWM $${hwmEquity.toFixed(2)})`
      + `${nextRung ? ` · next de-risk at $${nextRung.minHwmEquity} HWM` : ' · top rung'}`,
    );
    if (tsmLastRungKey !== null && tsmLastRungKey !== rungKey) {
      void notifyAlert(
        `🧲 TSM sleeve de-risked: ${tsmLastRungKey} → ${rungKey} (HWM $${hwmEquity.toFixed(2)}). `
        + 'Held slots will drift-rebalance to the new size.',
      );
    }
    tsmLastRungKey = rungKey;

    // Advisory only (order-time enforcement lives in the trader): can this rung
    // actually place an order at CURRENT equity under adverse multipliers?
    const feas = sleeveFeasibility({
      equity: currentEquity,
      nSymbols: (active.symbols ?? []).length,
      deploymentPct: active.deploymentPct,
      riskOffFactor: Number(coreCfg.macroOverlay?.riskOffFactor ?? 0.5),
    });
    if (!feas.feasible && !tsmFeasibilityAlerted) {
      tsmFeasibilityAlerted = true;
      const message = `[TSM-CORE] rung ${rungKey} cannot clear the exchange min-notional floor at current `
        + `equity $${currentEquity.toFixed(2)} (adverse slot ≈ $${feas.adverseSlotUsd}) — sleeve will idle in cash. `
        + `Viable from ~$${feas.viableFromEquity} equity.`;
      logger.warn(message);
      void notifyAlert(message);
    }

    // ── Macro overlay (M1): half size while NASDAQ < its 100d EMA ───────────
    // FRED feed is keyless with a 12h disk cache; any failure → neutral (1).
    let macroFactor = 1;
    let macroState = 'off';
    const mo = coreCfg.macroOverlay ?? {};
    if (mo.enabled !== false) {
      const nasdaq = await loadNasdaqHistory();
      const ro = computeEquityRiskOff(nasdaq?.rows, { emaDays: mo.emaDays ?? 100 });
      if (ro.available) {
        macroFactor = ro.above ? 1 : Number(mo.riskOffFactor ?? 0.5);
        macroState = ro.above ? 'risk-on' : `RISK-OFF ×${macroFactor}`;
      } else {
        macroState = 'unavailable → neutral';
        logger.warn('[TSM-CORE] NASDAQ feed unavailable — macro overlay neutral this cycle');
      }
    }

    const signals = new Map();
    const prices = new Map();
    const fractions = new Map();
    const vols = new Map();
    for (const symbol of active.symbols ?? []) {
      const candles = dashboardState.getCandles(symbol);
      if (!candles || candles.length < 2) {
        logger.warn(`[TSM-CORE] ${symbol}: no candles cached — skipping`);
        continue;
      }
      // The sleeve places REAL market orders in live mode, so a frozen series
      // is far more dangerous here than on the scalper path: a stale vote could
      // open or close a whole slot at a price that no longer exists. Skipping
      // leaves any held position untouched — planCoreActions only acts on
      // symbols present in `signals`.
      const coreFreshness = checkCandleFreshness(
        candles, config.timeframe, config.maxCandleStalenessPeriods,
      );
      if (coreFreshness.stale) {
        const message = `[TSM-CORE] ${symbol}: candle series stale (newest bar ${formatAge(coreFreshness.ageMs)} old) — skipping, position left as-is`;
        logger.warn(message);
        dashboardState.pushError(message);
        continue;
      }
      // Closed bars only — the forming candle is sliced off (no lookahead).
      const closed = candles.slice(0, -1);
      const vote = computeTsmVote(closed, coreCfg.lookbackBars ?? [60, 90, 120]);
      const realizedVol = computeRealizedVolAnnual(closed, { windowBars: coreCfg.volWindowBars ?? 60 });
      const fraction = computeTargetFraction({
        volTarget: coreCfg.volTarget ?? null,
        realizedVol,
        minFraction: coreCfg.minFraction ?? 0.2,
        macroFactor,
      });
      signals.set(symbol, vote);
      prices.set(symbol, Number(candles.at(-1).close));
      fractions.set(symbol, fraction);
      vols.set(symbol, realizedVol);
      logger.info(
        `[TSM-CORE] ${symbol}: votes ${vote.positive}/${vote.total} (enter ≥${coreCfg.enterVotes ?? vote.needed}, stay ≥${coreCfg.stayVotes ?? vote.needed})` +
        ` · vol ${realizedVol ? (realizedVol * 100).toFixed(0) + '%' : 'n/a'} → ×${fraction.toFixed(2)} · macro ${macroState}` +
        `${vote.insufficientHistory ? ' [insufficient history → forced CASH votes]' : ''}`,
      );
    }

    // Equal split of deploymentPct × total equity across core symbols; each
    // slot then scales by its vol/macro fraction. Opens are additionally
    // capped at available cash inside openCorePosition.
    const perSlot = (currentEquity * Number(active.deploymentPct ?? 0.5)) / Math.max((active.symbols ?? []).length, 1);

    const emit = (result) => {
      dashboardState.pushTrade(result);
      notifyTrade(result);
      pushEvent('trade', result);
    };

    const actions = planCoreActions({
      symbols: [...signals.keys()],
      signals,
      positions: status.positions,
      enterVotes: coreCfg.enterVotes ?? null,
      stayVotes: coreCfg.stayVotes ?? null,
    });
    let traded = 0;
    for (const action of actions) {
      const price = prices.get(action.symbol);
      if (!Number.isFinite(price) || price <= 0) continue;
      const result = action.type === 'open'
        ? await trader.openCorePosition(action.key, price, perSlot * (fractions.get(action.symbol) ?? 1))
        : await trader.closeCorePosition(action.key, price);
      if (!result) {
        if (action.type === 'close') {
          // A stuck exit is unbounded exposure with no stop — alert the
          // operator now and let the fast risk loop retry within minutes.
          tsmCoreFailedCloses.add(action.key);
          logger.error(`[TSM-CORE] ${action.key}: vote-flip CLOSE FAILED — retrying via fast risk loop`);
          void notifyAlert(`TSM core: closing <b>${action.key}</b> failed — position stays open until the retry succeeds (checked every 2 min).`);
        }
        continue;
      }
      emit(result); traded++;
    }

    // ── Resize pass: drift held positions toward their vol/macro target ─────
    // Uses the pre-action snapshot, so freshly opened/closed slots are skipped.
    const acted = new Set(actions.map((a) => a.key));
    const held = new Map((status.positions ?? []).filter((p) => p.isCore).map((p) => [p.symbol, p]));
    for (const symbol of signals.keys()) {
      const key = coreKey(symbol);
      const pos = held.get(key);
      if (!pos || acted.has(key)) continue;
      const price = prices.get(symbol);
      if (!Number.isFinite(price) || price <= 0) continue;
      const deltaUsd = planCoreResize({
        desiredUsd: perSlot * (fractions.get(symbol) ?? 1),
        currentUsd: pos.qty * price,
        perSlotUsd: perSlot,
        thresholdPct: coreCfg.resizeThresholdPct ?? 0.15,
      });
      if (deltaUsd === null) continue;
      const result = await trader.resizeCorePosition(key, price, deltaUsd);
      if (!result) continue;
      emit(result); traded++;
    }

    // Surface sleeve state to the dashboard (append-only `tsmCore` key)
    const finalStatus = traded > 0 ? await trader.getStatus() : status;
    dashboardState.setTsmCore({
      enabled: true,
      updatedAt: new Date().toISOString(),
      deploymentPct: Number(active.deploymentPct ?? 0.5),
      enterVotes: coreCfg.enterVotes ?? null,
      stayVotes: coreCfg.stayVotes ?? null,
      volTarget: coreCfg.volTarget ?? null,
      macro: { state: macroState, factor: macroFactor },
      symbols: [...signals.entries()].map(([symbol, vote]) => {
        const pos = (finalStatus.positions ?? []).find((p) => p.symbol === coreKey(symbol));
        const price = prices.get(symbol);
        return {
          symbol,
          positive: vote.positive,
          total: vote.total,
          insufficientHistory: vote.insufficientHistory,
          held: Boolean(pos),
          realizedVol: vols.get(symbol) ?? null,
          fraction: Number((fractions.get(symbol) ?? 1).toFixed(2)),
          targetUsd: Math.round(perSlot * (fractions.get(symbol) ?? 1)),
          currentUsd: pos && Number.isFinite(price) ? Math.round(pos.qty * price) : 0,
        };
      }),
    });
    if (traded > 0) {
      dashboardState.updateStatus(finalStatus, riskManager.getDailyStats());
    }
  } catch (err) {
    logger.error(`[TSM-CORE] cycle failed: ${err?.message ?? err}`);
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
    writeFileSync(join(process.cwd(), 'logs', 'trades.csv'), 'timestamp,symbol,side,price,qty,pnl,balance\n', 'utf8');
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
correlationMatrix = buildCorrelationMatrix(config.symbols, (sym) => dashboardState.getCandles(sym), config.correlation); // ← built once from full history, then refreshed each cycle
await runInitialSignals();   // ← signals appear instantly from cache
if (process.env.SMOKE_TEST !== 'false') await runSmokeTest();
await runAllSymbols();  // immediate run on startup (SL/TP check + fresh signals)

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
const RISK_CHECK_MS = 2 * 60_000;
let riskCheckId = null;
if (!paperMode) {
  async function runRiskChecks() {
    try {
      const status = await trader.getStatus();
      const openPositions = status?.positions ?? [];
      if (!openPositions.length) return;

      logger.debug(`[RISK-LOOP] checking ${openPositions.length} open position(s)`);
      for (const pos of openPositions) {
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

              if (tsmCoreFailedCloses.has(pos.symbol)) {
                const retried = await trader.closeCorePosition(pos.symbol, price);
                if (retried) {
                  tsmCoreFailedCloses.delete(pos.symbol);
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

          dashboardState.updatePrice(pos.symbol, price);
          const result = await trader.checkRisk(pos.symbol, price);
          if (result) {
            // Position was closed — update dashboard
            logger.info(`[RISK-LOOP] ${pos.symbol}: position closed by risk check`);
            dashboardState.pushTrade(result);
            notifyTrade(result);
            const freshStatus = await trader.getStatus();
            dashboardState.updateStatus(freshStatus, riskManager.getDailyStats());
            pushEvent('trade', result);
            pushEvent('status', freshStatus);
          }
        } catch (err) {
          logger.debug(`[RISK-LOOP] ${pos.symbol}: check failed — ${err.message}`);
        }
      }
    } catch (err) {
      logger.debug(`[RISK-LOOP] error: ${err.message}`);
    }
  }
  riskCheckId = setInterval(() => void runRiskChecks(), RISK_CHECK_MS);
  logger.info(`Risk-check loop active: every ${RISK_CHECK_MS / 1000}s for open positions`);
}

// ── MTF candle cache refresh ────────────────────────────────────────────────
// Pre-fetch 15m and 4h candles for all symbols on timers matching their period.
// This eliminates per-BUY API calls and keeps filter data fresh.
const MTF_15M_REFRESH_MS = 15 * 60_000;
const MTF_4H_REFRESH_MS  = 4 * 3_600_000;
let mtf15mRefreshId = null;
let mtf4hRefreshId  = null;

async function refreshMtfCache(timeframe, cache, bars) {
  const label = timeframe;
  let refreshed = 0;
  for (const symbol of config.symbols) {
    try {
      const candles = await fetchOHLCV(symbol, timeframe, bars);
      if (candles.length) {
        cache.set(symbol, candles);
        refreshed++;
      }
    } catch (err) {
      logger.debug(`[MTF-CACHE] ${symbol} ${label}: fetch failed — ${err.message}`);
    }
  }
  logger.info(`[MTF-CACHE] ${label} refresh complete: ${refreshed}/${config.symbols.length} symbols`);
}

// Initial warm-up + periodic refresh
if (config.mtfFilter?.enabled) {
  void refreshMtfCache('15m', mtf15mCache, 24).then(() => {
    mtf15mRefreshId = setInterval(() => void refreshMtfCache('15m', mtf15mCache, 24), MTF_15M_REFRESH_MS);
  });
  logger.info(`MTF 15m cache: refresh every ${MTF_15M_REFRESH_MS / 60_000} min`);
}
if (config.mtf4hFilter?.enabled) {
  void refreshMtfCache('4h', mtf4hCache, 30).then(() => {
    mtf4hRefreshId = setInterval(() => void refreshMtfCache('4h', mtf4hCache, 30), MTF_4H_REFRESH_MS);
  });
  logger.info(`MTF 4h cache: refresh every ${MTF_4H_REFRESH_MS / 3_600_000}h`);
}

// ── Market context cache (Phase 3) — BTC.D + ETHBTC ────────────────────────
// Load Fear & Greed history once (its own TTL handles staleness). Refresh
// market context (BTC.D, ETHBTC) on the configured interval so the BTC.D
// gate + sizing modulators have fresh values without bothering on every cycle.
let marketContextRefreshId = null;
void loadFearGreedHistory().then((data) => {
  fearGreedData = data;
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
  run: runAllSymbols,
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

// ── Cycle watchdog (deadman alert) ──────────────────────────────────────────
// Alerts on the ABSENCE of completed cycles: the July 2026 host suspend stalled
// the loop 18h and skewed it for 24 days with zero alerts, because a dead
// process emits no error. Checks every 30 min; fires once per incident via
// Telegram and re-arms when cycles resume.
const CYCLE_WATCHDOG_MS = 30 * 60_000;
const cycleWatchdogId = setInterval(() => {
  const { stale, gapMs, thresholdMs } = checkCycleGap({
    lastCycleAt, now: Date.now(), periodMs: config.pollIntervalMs,
  });
  const { fire, recovered } = updateWatchdogLatch(watchdogLatch, stale);
  if (fire) {
    const hours = (gapMs / 3_600_000).toFixed(1);
    const message = `⏰ WATCHDOG: no completed trading cycle in ${hours}h `
      + `(threshold ${(thresholdMs / 3_600_000).toFixed(1)}h). Host suspended or loop hung — `
      + `the bot is NOT making decisions. Last cycle: ${new Date(lastCycleAt).toUTCString()}.`;
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
  clearInterval(pricePollId);
  clearInterval(balancePollId);
  clearInterval(riskCheckId);
  clearInterval(mtf15mRefreshId);
  clearInterval(mtf4hRefreshId);
  clearInterval(marketContextRefreshId);
  logger.info('SIGINT received, shutting down gracefully');
  void logShutdown().finally(() => process.exit(0));
});

process.on('unhandledRejection', (error) => {
  const message = `Unhandled rejection: ${error instanceof Error ? error.message : String(error)}`;
  logger.error(message);
  dashboardState.pushError(message);
  pushEvent('error', { message, timestamp: Date.now() });
});

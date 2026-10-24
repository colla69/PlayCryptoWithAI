/**
 * The trading engine — one bar-close cycle, the code live runs (plan 2026-10
 * single-engine rebuild, step 4, slice 3).
 *
 * `main.js` used to hold this as module-level functions and state, reachable only
 * by booting the bot. Here it is a factory: every exchange call, store, clock and
 * notification comes in through `deps`, so the same cycle can run live (main.js),
 * against fakes in tests, and over history in a replay. The code moved verbatim;
 * module state became `state.*` and `Date.now()` became `now()`.
 */

import logger from '../utils/logger.js';
import { calcPositionAgingExit, calcWeeklyDDBreaker, calcEquityFromStatus } from '../risk/portfolioRisk.js';
import { computeLiveStats, evaluateDrift } from '../monitor/driftMonitor.js';
import { computeATRPct, isBullTrend } from '../utils/indicators.js';
import { runEntryFilters, calcFearGreedAdjustedThreshold } from './filters.js';
import { resolveDecision, byEntryPriority } from './decisionCore.js';
import { getFearGreedValue } from '../data/fearGreed.js';
import { computeBearPolicy } from '../engine/regimeRouter.js';
import { computePositionSize } from './positionSizing.js';
import {
  getStrategyNamesForSymbol, getStrategyTriggerHints, getRiskForSymbol, getSignalConfigForSymbol, buildSignalReasons,
} from '../utils/strategyBuilder.js';
import { buildCorrelationMatrix } from '../utils/correlation.js';
import { checkCandleFreshness, formatAge, timeframeMs } from '../utils/candleFreshness.js';
import { withFormingBar } from '../utils/formingBar.js';

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.dashboardState — candles store + dashboard sink
 * @param {object} deps.trader — the order handler (LiveTrader, PaperTrader, or a replay adapter)
 * @param {object} deps.riskManager
 * @param {object} deps.regimeTracker
 * @param {Record<string, object>} deps.symbolAggregators
 * @param {object} deps.signalConfig
 * @param {Function} deps.fetchOHLCV — (symbol, timeframe, limit) → candles
 * @param {{getBtcDominanceTrend: Function, getEthBtcTrend: Function}} deps.marketContext
 * @param {Function} deps.notifyTrade
 * @param {Function} deps.notifyAlert
 * @param {Function} deps.pushEvent
 * @param {Function} deps.recordEquitySnapshot
 * @param {Function} deps.runTsmCoreCycle — the core sleeve, run after the scalper
 * @param {string} deps.modeLabel — 'paper' | 'testnet' | 'live', for the logs
 * @param {Function} [deps.now] — the clock; a replay passes its own
 * @param {object} [deps.initialState] — e.g. the starting regime label
 */
export function createTradingEngine(deps) {
  const {
    config, dashboardState, trader, riskManager, regimeTracker, symbolAggregators, signalConfig,
    fetchOHLCV, notifyTrade, notifyAlert, pushEvent, recordEquitySnapshot, runTsmCoreCycle, modeLabel,
  } = deps;
  const { getBtcDominanceTrend, getEthBtcTrend } = deps.marketContext;
  const now = deps.now ?? (() => Date.now());

  // Cycle state: what the previous cycle left for the next one.
  const state = {
    correlationMatrix: {},
    medianATRPct: null,
    btcMacroBull: true,
    fearGreedData: null,
    currentRegime: null,
    bearPolicy: { shouldBlockEntries: false, shouldCashExitOpen: false },
    cycleInProgress: false,
    lastCycleAt: null,
    driftAlertLatch: { alerted: false },
    ...(deps.initialState ?? {}),
  };
  // 15m / 4h bars for the entry filters, refreshed at every cycle.
  const mtf15mCache = new Map();
  const mtf4hCache = new Map();

  function medianOfArray(arr) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  /**
   * Fetches a symbol's newest candles and merges them into the historical cache, so
   * indicators use the full history, not just the last 200 bars from the exchange.
   * One retry after a short pause: a 500 or -1001 right after the close, when the
   * exchange is busiest, lost the symbol's whole 12h cycle six times in 30 days
   * (follow-ups item 6). Returns false when there is nothing new to decide on.
   */
  async function refreshSymbolCandles(symbol) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const freshCandles = await fetchOHLCV(symbol, config.timeframe, config.candleLimit);
        if (!freshCandles.length) {
          logger.warn(`${symbol}: no candles returned`);
          return false;
        }
        dashboardState.updateCandles(symbol, freshCandles);
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (attempt === 2) {
          const message = `${symbol}: cycle failed - ${errorMessage}`;
          logger.error(message);
          dashboardState.pushError(message);
          pushEvent('error', { message, timestamp: now() });
          return false;
        }
        logger.warn(`${symbol}: candle fetch failed (${errorMessage}) — retrying once`);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    return false;
  }

  /** Bars closed by now: the decision series without its forming bar. */
  function closedCandles(symbol) {
    return withFormingBar(dashboardState.getCandles(symbol), config.timeframe, now()).slice(0, -1);
  }

  async function runCycle(symbol) {
    try {
      const candles = dashboardState.getCandles(symbol);

      // ── Stale-series guard ───────────────────────────────────────────────────
      // A thin or delisted market still returns klines, they just stop advancing.
      // The `!freshCandles.length` check above misses that entirely: during the
      // 2026-07 soak LSK/TON/GMX fed frozen bars to the aggregator for weeks,
      // each emitting an identical confidence every cycle. They stayed HOLD so
      // nothing was lost, but a frozen series can just as easily emit a BUY and
      // the bot would enter an illiquid market at a stale price.
      const freshness = checkCandleFreshness(
        candles, config.timeframe, config.maxCandleStalenessPeriods, now(),
      );
      if (freshness.stale) {
        const message = `${symbol}: candle series stale (newest bar ${formatAge(freshness.ageMs)} old) — skipping cycle`;
        logger.warn(message);
        dashboardState.pushError(message);
        return;
      }

      logger.debug(`[CYCLE] ${symbol}: starting cycle, candles=${candles.length} lastClose=${Number(candles.at(-1).close).toFixed(8)} lastTs=${new Date(candles.at(-1).timestamp).toISOString()}`);

      // The strategies drop the last bar as the forming one. If a thin pair has not
      // printed the new bar yet, add a placeholder, or they drop the bar that just
      // closed and decide one bar late (follow-ups plan, item 5).
      const decisionCandles = withFormingBar(candles, config.timeframe, now());
      const aggregator = symbolAggregators[symbol];
      const symSignalConfig = getSignalConfigForSymbol(symbol, signalConfig);
      const result = aggregator.aggregate(decisionCandles, symbol, symSignalConfig);
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
          // Age from the start of the bar the position opened in, as the backtester
          // counts. From the fill time (~15 s after the cycle) the 14-bar exit came one
          // cycle late (follow-ups item 10).
          const periodMs = Number(config.pollIntervalMs ?? 12 * 60 * 60 * 1000);
          const openedMs = new Date(myPos.openedAt).getTime();
          const aging = calcPositionAgingExit({
            entryTs: Math.floor(openedMs / periodMs) * periodMs,
            nowTs: now(),
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
      // Shared with the backtester (decisionCore.resolveDecision); the core decides
      // from the SELL majority (sellMajority) and the 0.7× threshold.
      const resolved = resolveDecision({
        decision: result.decision,
        confidence: result.confidence,
        sellVotes: result.signals.filter((s) => s.signal === 'SELL').length,
        totalVotes: result.signals.length,
        held: hasPosition,
        minConfidence: symSignalConfig.minConfidence,
      });
      if (resolved.asymmetricExit) {
        result.decision = 'SELL';
        logger.info(`${symbol}: SELL threshold lowered for exit (conf=${result.confidence.toFixed(2)} ≥ ${resolved.sellThreshold.toFixed(2)})`);
      }

      const ctx = { symbol, result, decisionCandles, currentPrice, currentStatus, symRisk };
      // An entry waits: runAllSymbols fills the free slots one at a time, highest
      // confidence first, each from fresh status — as the backtester does.
      if (result.decision === 'BUY' && !hasPosition) return ctx;
      await completeCycle(ctx);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = `${symbol}: cycle failed - ${errorMessage}`;
      logger.error(message);
      dashboardState.pushError(message);
      pushEvent('error', { message, timestamp: now() });
    }
    return null;
  }

  /**
   * The rest of a symbol's cycle: entry gates, the risk manager, sizing, the order,
   * the dashboard. Called at once for exits and holds, and for each entry candidate
   * in turn (runAllSymbols), so a slot one entry takes is visible to the next.
   */
  async function completeCycle({ symbol, result, decisionCandles, currentPrice, currentStatus, symRisk }) {
    try {
      // ── Entry filters: regime, correlation, MTF ──────────────────────────────
      let blockReason = null;
      let mtfSizeFactor = 1.0;
      if (result.decision === 'BUY') {
        // Phase 6a: hard bear-policy block runs BEFORE the regular filter stack
        // so we don't waste cycles on filters for a guaranteed-blocked entry.
        if (state.bearPolicy.shouldBlockEntries) {
          blockReason = state.bearPolicy.reason ?? 'bear regime — entries disabled';
          logger.info(`${symbol}: BUY suppressed — ${blockReason}`);
        } else {
          // Use cached MTF candles — falls back to live fetch and warms cache
          // Only bars closed by now, as the backtester reads them (follow-ups item 9):
          // the newest bar in a fresh fetch is seconds old and still forming.
          const closedNow = (bars, tf) => {
            const ms = timeframeMs(tf) ?? 0;
            const now = now();
            return bars.filter((c) => Number(c.timestamp) + ms <= now);
          };
          const cachedFetchOHLCV = async (sym, tf, limit) => {
            if (tf === '15m' && mtf15mCache.has(sym)) return closedNow(mtf15mCache.get(sym), tf).slice(-(limit ?? 20));
            if (tf === '4h' && mtf4hCache.has(sym)) return closedNow(mtf4hCache.get(sym), tf).slice(-(limit ?? 30));
            const fresh = await fetchOHLCV(sym, tf, (limit ?? 20) + 1);
            if (fresh.length) {
              const cache = tf === '15m' ? mtf15mCache : mtf4hCache;
              cache.set(sym, fresh);
            }
            return closedNow(fresh, tf).slice(-(limit ?? 20));
          };
          // Core sleeve positions are excluded so the beta sleeve doesn't trip
          // the scalper's correlation cap or distort its risk gates.
          const filterResult = await runEntryFilters({
            nowMs: now(),
            btcDominance: config.btcDominance?.enabled ? getBtcDominanceTrend() : null,
            symbol, candles: decisionCandles, openPositions: currentStatus.positions.filter((p) => !p.isCore),
            correlationMatrix: state.correlationMatrix, fetchOHLCV: cachedFetchOHLCV, config,
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
      const fgValue = state.fearGreedData
        ? getFearGreedValue(state.fearGreedData, now())
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
        candles: decisionCandles, medianATRPct: state.medianATRPct, btcMacroBull: state.btcMacroBull,
        confidence: result.confidence,
        mtfSizeFactor, config,
      });

      logger.debug(`[CYCLE] ${symbol}: sizing positionPct=${positionPct.toFixed(4)} (base=${symRisk.maxPositionPct} atr=${config.atr?.enabled ? (state.medianATRPct ?? 'n/a') : 'off'} regime=${config.regimeSizing?.enabled ? 'on' : 'off'} conf=${config.confSizing?.enabled ? (result.confidence ?? 0).toFixed(2) : 'off'} macro=${config.macroFilter?.enabled ? (state.btcMacroBull ? 'bull' : 'bear') : 'off'} mtf=${mtfSizeFactor < 1.0 ? mtfSizeFactor.toFixed(2) : '1.0'})`);

      // Compute the symbol's current ATR% so the trader's ATR-stops path can use it.
      // No-op when risk.atrStops.enabled is false.
      const symbolATRPct = computeATRPct(decisionCandles, config.atr?.period ?? 14);
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
        timestamp: now(),
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
        `${symbol}: ${modeLabel} balance=${status.balance.toFixed(2)} pnl=${status.totalPnL.toFixed(2)} open_positions=${status.positions.length} daily_pnl=${dailyStats.dailyPnL.toFixed(2)} blocked=${dailyStats.blocked}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const message = `${symbol}: cycle failed - ${errorMessage}`;
      logger.error(message);
      dashboardState.pushError(message);
      pushEvent('error', { message, timestamp: now() });
    }
  }

  async function runAllSymbols() {
    if (state.cycleInProgress) {
      logger.warn('Previous cycle still running, skipping this interval');
      return;
    }

    state.cycleInProgress = true;

    try {
      // Fetch first (follow-ups item 12). The correlation matrix, the median ATR, the
      // macro filter and the regime below all read these candles; they used to run
      // before the fetch, on the previous cycle's series — one bar behind.
      const fetched = new Map(await Promise.all(
        config.symbols.map(async (symbol) => [symbol, await refreshSymbolCandles(symbol)]),
      ));
      // The 15m / 4h filter caches refresh right after the close too (item 9). On a
      // timer counted from boot, the 4h cache's newest bar was fetched up to 4 h
      // before the cycle, part-formed, and what the filter saw depended on boot time.
      await Promise.all([
        config.mtfFilter?.enabled ? refreshMtfCache('15m', mtf15mCache, 24) : null,
        config.mtf4hFilter?.enabled ? refreshMtfCache('4h', mtf4hCache, 30) : null,
      ]);

      // Refresh correlation matrix each cycle, from bars closed by the cycle time
      state.correlationMatrix = buildCorrelationMatrix(config.symbols, (sym) => closedCandles(sym), config.correlation);

      // Log correlation pairs above threshold
      if (config.correlation?.enabled) {
        const threshold = config.correlation.threshold ?? 0.8;
        const pairs = [];
        const syms = config.symbols;
        for (let i = 0; i < syms.length; i++) {
          for (let j = i + 1; j < syms.length; j++) {
            const r = state.correlationMatrix[syms[i]]?.[syms[j]] ?? 0;
            if (r > threshold) pairs.push(`${syms[i].split('/')[0]}/${syms[j].split('/')[0]}=${r.toFixed(2)}`);
          }
        }
        if (pairs.length) logger.debug(`[CYCLE] Correlated pairs (r>${threshold}): ${pairs.join(', ')}`);
      }

      // ATR sizing: compute portfolio median ATR% so each symbol can be scaled relative to it
      if (config.atr?.enabled) {
        // The same series each symbol is sized on (runCycle's decision series), and
        // only symbols that trade this cycle: a frozen pair's old bars are not the market.
        const atrPcts = config.symbols
          .filter((sym) => fetched.get(sym) && !checkCandleFreshness(
            dashboardState.getCandles(sym), config.timeframe, config.maxCandleStalenessPeriods, now(),
          ).stale)
          .map((sym) => computeATRPct(withFormingBar(dashboardState.getCandles(sym), config.timeframe, now()), config.atr.period))
          .filter((v) => v != null && v > 0);
        state.medianATRPct = atrPcts.length ? medianOfArray(atrPcts) : null;
        logger.debug(`[CYCLE] ATR sizing: medianATRPct=${state.medianATRPct != null ? (state.medianATRPct * 100).toFixed(2) + '%' : 'n/a'} (${atrPcts.length} symbols)`);
      }

      // Macro filter: check BTC vs EMA(200) to determine portfolio-level bear phase
      // Without this cycle's BTC bars the newest one is the previous cycle's partial
      // bar; macro and regime keep their last state rather than read it as closed.
      const btcFresh = fetched.get('BTC/USDC') === true;
      if (config.macroFilter?.enabled && btcFresh) {
        const prevBull = state.btcMacroBull;
        state.btcMacroBull = isBullTrend(closedCandles('BTC/USDC'), config.macroFilter.emaPeriod ?? 200);
        logger.debug(`[CYCLE] BTC macro: bull=${state.btcMacroBull} EMA${config.macroFilter.emaPeriod ?? 200}`);
        if (state.btcMacroBull !== prevBull) {
          const factor = (config.macroFilter.sizeReduceFactor ?? 0.5) * 100;
          logger.warn(
            `Macro filter: BTC ${state.btcMacroBull ? 'ABOVE' : 'BELOW'} EMA${config.macroFilter.emaPeriod ?? 200} — ` +
            `new positions ${state.btcMacroBull ? 'normal size' : `reduced to ${factor.toFixed(0)}%`}`,
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
        if (btc.length > 0 && btcFresh) {
          const closed = closedCandles('BTC/USDC');
          const snap = regimeTracker.update(closed, now());
          const prev = state.currentRegime;
          state.currentRegime = snap.regime;
          regimeChanged = snap.regimeChanged;
          if (regimeChanged) {
            logger.warn(`[REGIME] BTC regime change: ${prev} → ${state.currentRegime}  (ADX ${snap.raw.adx} BTC ${snap.raw.btcClose.toFixed(0)} vs EMA200 ${snap.raw.ema200.toFixed(0)})`);
          } else {
            logger.debug(`[REGIME] ${state.currentRegime}  candidate=${snap.candidate ?? '-'} streak=${snap.streak}  (ADX ${snap.raw?.adx ?? 'n/a'})`);
          }
          // Surface regime to the dashboard (Phase 9 — append-only observability)
          dashboardState.setRegime({
            label: state.currentRegime,
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
      state.bearPolicy = computeBearPolicy({
        regime: state.currentRegime,
        regimeChanged,
        policy: config.bearPolicy,
      });

      // Surface cross-asset context + circuit-breaker status (Phase 9 — append-only)
      {
        const fgValue = state.fearGreedData ? getFearGreedValue(state.fearGreedData, now()) : null;
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
          bearEntriesBlocked: !!state.bearPolicy.shouldBlockEntries,
          bearReason: state.bearPolicy.reason ?? null,
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
          if (!state.driftAlertLatch.alerted) {
            state.driftAlertLatch.alerted = true;
            void notifyAlert(`📉 ${msg}`);
          }
        } else {
          state.driftAlertLatch.alerted = false;
          logger.debug(`[DRIFT] ${drift.reason} (n=${live.n}, WR ${(live.winRate*100).toFixed(0)}%)`);
        }
      }

      if (state.bearPolicy.shouldCashExitOpen) {
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

      // Phase A in parallel: decisions, exits, holds. Phase B one at a time: entries
      // by confidence, each from fresh status. All at once, every cycle checked the
      // position limit against a status read before the others' orders — two BUYs
      // with three slots taken both passed (follow-ups, step-4 slot race).
      const candidates = (await Promise.all(
        config.symbols.filter((symbol) => fetched.get(symbol)).map((symbol) => runCycle(symbol)),
      )).filter(Boolean);
      const order = new Map(config.symbols.map((symbol, k) => [symbol, k]));
      candidates.sort((a, b) => byEntryPriority(
        { confidence: a.result.confidence, order: order.get(a.symbol) },
        { confidence: b.result.confidence, order: order.get(b.symbol) },
      ));
      for (const candidate of candidates) {
        await completeCycle({ ...candidate, currentStatus: await trader.getStatus() });
      }

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
      state.lastCycleAt = now();
    } finally {
      state.cycleInProgress = false;
    }
  }

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

  /**
   * One price tick for an open scalper position — live's 2-minute risk loop, and a
   * replay's 15m bars. A stop, target or trailing exit is recorded with the risk
   * manager like any other exit: the risk loop used to skip that, so the daily-loss
   * brake never saw the losses it most often exists for.
   * @returns {Promise<object|null>} the closing trade, if one fired
   */
  async function onPriceTick(symbol, price) {
    dashboardState.updatePrice(symbol, price);
    const result = await trader.checkRisk(symbol, price);
    if (result) {
      logger.info(`[RISK-LOOP] ${symbol}: position closed by risk check`);
      dashboardState.pushTrade(result);
      if (typeof result.pnl === 'number') riskManager.recordTrade(result.pnl);
      notifyTrade(result);
      const freshStatus = await trader.getStatus();
      dashboardState.updateStatus(freshStatus, riskManager.getDailyStats());
      pushEvent('trade', result);
      pushEvent('status', freshStatus);
    }
    return result;
  }

  return { runAllSymbols, onPriceTick, refreshMtfCache, closedCandles, mtf15mCache, mtf4hCache, state };
}

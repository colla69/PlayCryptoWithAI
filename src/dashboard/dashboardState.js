import { loadPersistedState, scheduleSave, loadSignalHistory, scheduleHistorySave, loadTradesFromCsv, MAX_SIGNAL_HISTORY } from './persistence.js';

const MAX_TRADES = 100;
const MAX_SIGNALS = 50;
const MAX_ERRORS = 20;

function pushWithLimit(collection, item, maxSize) {
  collection.unshift(item);

  if (collection.length > maxSize) {
    collection.length = maxSize;
  }
}

function roundMoney(value) {
  return Number(Number(value ?? 0).toFixed(2));
}

// Exported for tests — production code uses the `dashboardState` singleton below,
// which stays the sole writer of persisted state.
export class DashboardState {
  constructor() {
    this.startTime = new Date();
    this.lastUpdatedAt = new Date();
    this.trades = [];
    this.signalFeed = [];
    this.priceMap = new Map();
    this.priceChangeMap = new Map();
    this.candleMap = new Map();

    // Restore trades + signals that survived the last shutdown.
    // Always merge with CSV history so charts have full trade data.
    const saved = loadPersistedState();
    const csvTrades = loadTradesFromCsv(MAX_TRADES);
    if (saved?.trades?.length) {
      // Merge: use persisted as primary (has richer data), fill in older from CSV
      const existingTimestamps = new Set(saved.trades.map(t => t.timestamp));
      const extra = csvTrades.filter(t => !existingTimestamps.has(t.timestamp));
      this.trades = [...saved.trades, ...extra].slice(0, MAX_TRADES);
    } else {
      this.trades = csvTrades;
    }
    if (saved?.signalFeed?.length)
      this.signalFeed = saved.signalFeed.slice(0, MAX_SIGNALS);
    this.signalHistory = loadSignalHistory();
    this.cycleCount = 0;
    this.errors = [];
    this.latestStatus = null;
    this.latestDailyStats = null;
    this.strategiesConfig = [];
    this.strategyRegistry = [];
    this.latestStrategyResults = {};
    this.runtimeConfig = {
      timeframe: null,
      pollIntervalMs: null,
      symbols: [],
    };
    // Symbols whose synthetic BUY was deleted — never re-create on restore
    this.suppressedSynthetics = new Set(saved?.suppressedSynthetics ?? []);
    // Active filter configuration (set at startup from config)
    this.activeFilters = {};
    // Running tally of blocked BUY signals this session
    this.blockedStats = { regime: 0, correlation: 0, risk: 0, daily: 0, total: 0 };
    // Timestamp (ms) of the next scheduled cycle — set by main.js after alignment
    this.nextRunAt = null;
    // Phase 9 observability (append-only; null until first cycle populates them)
    this.regime = null;          // { label, previous, candidate, streak, adx, btcClose, ema200, changedAt, history }
    this.marketContext = null;   // { btcDominance, ethBtc, fearGreed }
    this.circuitBreaker = null;  // { bearEntriesBlocked, bearReason, weeklyDDActive, weeklyPnLPct, cooldownEndsAt }
  }

  #touch() {
    this.lastUpdatedAt = new Date();
  }

  pushTrade(trade) {
    if (!trade) {
      return;
    }

    // A real BUY clears any suppression so future restores work normally
    if (trade.side === 'BUY' && trade.symbol && this.suppressedSynthetics.has(trade.symbol)) {
      this.suppressedSynthetics.delete(trade.symbol);
    }

    pushWithLimit(
      this.trades,
      {
        ...trade,
        timestamp: trade.timestamp ?? new Date().toISOString(),
        pnl: roundMoney(trade.pnl),
        balance: roundMoney(trade.balance),
      },
      MAX_TRADES,
    );
    this.#touch();
    scheduleSave(this.trades, this.signalFeed, [...this.suppressedSynthetics]);
  }

  deleteTrade(timestamp) {
    const idx = this.trades.findIndex(t => t.timestamp === timestamp);
    if (idx === -1) return false;
    const removed = this.trades[idx];
    this.trades.splice(idx, 1);
    // Suppress synthetic recreation for deleted BUY entries
    if (removed.side === 'BUY' && removed.symbol) {
      this.suppressedSynthetics.add(removed.symbol);
    }
    this.#touch();
    scheduleSave(this.trades, this.signalFeed, [...this.suppressedSynthetics]);
    return true;
  }

  isSyntheticSuppressed(symbol) {
    return this.suppressedSynthetics.has(symbol);
  }

  clearSuppression(symbol) {
    this.suppressedSynthetics.delete(symbol);
    scheduleSave(this.trades, this.signalFeed, [...this.suppressedSynthetics]);
  }

  pushSignal(signal) {
    if (!signal) {
      return;
    }

    const entry = {
      ...signal,
      confidence: Number(signal.confidence ?? 0),
      timestamp:  signal.timestamp ?? Date.now(),
    };

    // Upsert by symbol — replace the existing entry so stale signals are gone
    const idx = this.signalFeed.findIndex((s) => s.symbol === entry.symbol);
    if (idx !== -1) {
      this.signalFeed[idx] = entry;
    } else {
      pushWithLimit(this.signalFeed, entry, MAX_SIGNALS);
    }

    this.#touch();
    this.#pushSignalHistory(entry);
    scheduleSave(this.trades, this.signalFeed, [...this.suppressedSynthetics]);
  }

  #pushSignalHistory(signal) {
    this.signalHistory.unshift(signal);
    if (this.signalHistory.length > MAX_SIGNAL_HISTORY) {
      this.signalHistory.length = MAX_SIGNAL_HISTORY;
    }
    scheduleHistorySave(this.signalHistory);
  }

  getSignalHistory(limit = MAX_SIGNAL_HISTORY, symbolFilter = null, decisionFilter = null) {
    let history = this.signalHistory;
    if (symbolFilter) history = history.filter(s => s.symbol === symbolFilter);
    if (decisionFilter) history = history.filter(s => s.decision === decisionFilter.toUpperCase());
    return history.slice(0, limit);
  }

  pushError(msg) {
    if (!msg) {
      return;
    }

    pushWithLimit(
      this.errors,
      {
        message: String(msg),
        timestamp: Date.now(),
      },
      MAX_ERRORS,
    );
    this.#touch();
  }

  updatePrice(symbol, price) {
    if (!symbol || !Number.isFinite(Number(price))) {
      return;
    }

    const prev = this.priceMap.get(symbol);
    if (prev && prev > 0) {
      this.priceChangeMap.set(symbol, ((Number(price) - prev) / prev) * 100);
    }
    this.priceMap.set(symbol, Number(price));
    this.#touch();
  }

  updateStatus(status, dailyStats) {
    this.latestStatus = status ? { ...status } : null;
    this.latestDailyStats = dailyStats ? { ...dailyStats } : null;
    this.#touch();
  }

  updateCandles(symbol, candles) {
    if (!symbol || !Array.isArray(candles)) return;

    const existing = this.candleMap.get(symbol) ?? [];

    if (candles.length >= existing.length) {
      // Full replacement (initial load or larger batch)
      this.candleMap.set(symbol, candles.slice(-2_500).map((c) => ({ ...c })));
    } else {
      // Live cycle: merge the fresh window into history, keeping the latest 2500.
      //
      // The exchange payload MUST win on a timestamp collision. Each cycle fetches
      // a window that includes the still-forming candle; the previous cycle's
      // snapshot of that same bar is incomplete. The old merge was first-wins with
      // `existing` placed first, so that partial bar was frozen into history for
      // good and its corrected, closed version was discarded 12h later — silently
      // corrupting every indicator computed from it afterwards. (This is why live
      // and the backtester disagreed on TIA in the 2026-07 soak: the on-disk cache
      // is payload-wins and stayed correct, while the in-memory series that
      // actually feeds the strategies drifted.)
      const byTimestamp = new Map();
      for (const candle of existing) byTimestamp.set(candle.timestamp, candle);
      for (const candle of candles) byTimestamp.set(candle.timestamp, candle);
      const unique = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
      this.candleMap.set(symbol, unique.slice(-2_500).map((c) => ({ ...c })));
    }
    this.#touch();
  }

  getCandles(symbol) {
    return (this.candleMap.get(symbol) ?? []).map((candle) => ({ ...candle }));
  }

  /**
   * Get a defensive copy of the trade history (Phase 7 — used by weekly
   * DD breaker and other filters that need timestamped P&L history).
   */
  getTrades() {
    return this.trades.map((trade) => ({ ...trade }));
  }

  incrementCycle() {
    this.cycleCount += 1;
    this.#touch();
  }

  setStrategiesConfig(strategies) {
    // Called once at startup with strategy instances to capture their config
    this.strategiesConfig = strategies.map((s) => ({
      name: s.constructor.name.replace('Strategy', ''),
      config: s.config ?? {},
    }));
  }

  setStrategyRegistry(registry) {
    // Full catalog of all available strategies (from registry.js)
    this.strategyRegistry = registry;
  }

  updateStrategyResults(symbol, signals) {
    // signals = result.signals from aggregator (one entry per strategy)
    this.latestStrategyResults[symbol] = (signals ?? []).map((s) => ({
      name: s.name ?? '',
      signal: s.signal,
      reason: s.reason ?? '',
      // RSI
      value: s.value ?? null,
      // EMA
      fastEMA: s.fastEMA ?? null,
      slowEMA: s.slowEMA ?? null,
      // MACD
      macd: s.macd ?? null,
      signalLine: s.signalLine ?? null,
      histogram: s.histogram ?? null,
      // Bollinger Bands
      upper: s.upper ?? null,
      middle: s.middle ?? null,
      lower: s.lower ?? null,
      bandwidth: s.bandwidth ?? null,
      bbPrice: s.price ?? null,
      // Stochastic
      k: s.k ?? null,
      d: s.d ?? null,
    }));
    this.#touch();
  }

  setRuntimeConfig(config = {}) {
    this.runtimeConfig = {
      timeframe: config.timeframe ?? this.runtimeConfig.timeframe,
      pollIntervalMs: Number(config.pollIntervalMs ?? this.runtimeConfig.pollIntervalMs ?? 0),
      symbols: Array.isArray(config.symbols) ? [...config.symbols] : this.runtimeConfig.symbols,
      maxOpenPositions: Number(config.maxOpenPositions ?? this.runtimeConfig.maxOpenPositions ?? 0),
    };
  }

  setActiveFilters(filters = {}) {
    this.activeFilters = { ...filters };
  }

  setNextRunAt(ts) {
    this.nextRunAt = ts ?? null;
    this.#touch();
  }

  // ── Phase 9 observability setters (append-only) ───────────────────────────
  setRegime(regime) {
    this.regime = regime ? { ...regime } : null;
    this.#touch();
  }

  setMarketContext(ctx) {
    this.marketContext = ctx ? { ...ctx } : null;
    this.#touch();
  }

  setCircuitBreaker(state) {
    this.circuitBreaker = state ? { ...state } : null;
    this.#touch();
  }

  // TSM core sleeve status (append-only) — votes, sizing fractions, macro
  // overlay state per core symbol; set once per cycle by runTsmCoreCycle.
  setTsmCore(state) {
    this.tsmCore = state
      ? { ...state, symbols: Array.isArray(state.symbols) ? state.symbols.map((s) => ({ ...s })) : [] }
      : null;
    this.#touch();
  }

  clearHistory() {
    this.trades = [];
    this.signalFeed = [];
    this.suppressedSynthetics.clear();
    scheduleSave(this.trades, this.signalFeed, []);
    this.#touch();
  }

  pushBlockedSignal(reason = '') {
    this.blockedStats.total++;
    const lower = String(reason).toLowerCase();
    if (lower.includes('ranging') || lower.includes('adx')) {
      this.blockedStats.regime++;
    } else if (lower.includes('correl')) {
      this.blockedStats.correlation++;
    } else if (lower.includes('daily') || lower.includes('loss limit')) {
      this.blockedStats.daily++;
    } else {
      this.blockedStats.risk++;
    }
    this.#touch();
  }

  getSummary() {
    const latestStatus = this.latestStatus
      ? {
          ...this.latestStatus,
          positions: Array.isArray(this.latestStatus.positions)
            ? this.latestStatus.positions.map((position) => {
                const currentPrice = Number(this.priceMap.get(position.symbol) ?? position.entryPrice ?? 0);
                const qty = Number(position.qty ?? 0);
                const entryPrice = Number(position.entryPrice ?? 0);
                return {
                  ...position,
                  currentPrice,
                  unrealizedPnl: roundMoney((currentPrice - entryPrice) * qty),
                };
              })
            : [],
        }
      : null;

    const trades = this.trades.map((trade) => ({ ...trade }));
    const sells  = trades.filter((t) => t.side === 'SELL');
    const wins   = sells.filter((t) => Number(t.pnl ?? 0) > 0).length;
    const losses = sells.filter((t) => Number(t.pnl ?? 0) < 0).length;
    const closedTrades = wins + losses;
    // Compute totalPnL from trade history (survives restarts) rather than trader state
    const historyPnL = sells.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0);
    const totalPnL   = historyPnL !== 0 ? historyPnL : roundMoney(latestStatus?.totalPnL ?? 0);

    return {
      startTime: this.startTime.toISOString(),
      lastUpdatedAt: this.lastUpdatedAt.toISOString(),
      uptimeMs: Date.now() - this.startTime.getTime(),
      cycleCount: this.cycleCount,
      trades,
      signalFeed: this.signalFeed.map((signal) => ({ ...signal })),
      prices: Object.fromEntries(this.priceMap.entries()),
      priceChanges: Object.fromEntries(this.priceChangeMap.entries()),
      errors: this.errors.map((error) => ({ ...error })),
      latestStatus,
      latestDailyStats: this.latestDailyStats ? { ...this.latestDailyStats } : null,
      metrics: {
        balance: roundMoney(latestStatus?.balance),
        totalPnL,
        dailyPnL: roundMoney(this.latestDailyStats?.dailyPnL),
        winRate: closedTrades > 0 ? Number(((wins / closedTrades) * 100).toFixed(2)) : 0,
        wins,
        losses,
      },
      mode: process.env.PAPER_MODE === 'true' || !process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET
        ? 'PAPER'
        : process.env.BINANCE_TESTNET === 'true'
          ? 'TESTNET'
          : 'LIVE',
      strategiesConfig: this.strategiesConfig,
      strategyRegistry: this.strategyRegistry,
      latestStrategyResults: { ...this.latestStrategyResults },
      activeSignalSources: {
        telegram: !!process.env.TELEGRAM_TOKEN,
        twitter: !!process.env.TWITTER_BEARER_TOKEN,
        webhook: true,
        copyTrade: !!(process.env.LEADER_API_KEY && process.env.LEADER_API_SECRET),
      },
      runtimeConfig: {
        timeframe: this.runtimeConfig.timeframe,
        pollIntervalMs: this.runtimeConfig.pollIntervalMs,
        symbols: [...this.runtimeConfig.symbols],
        maxOpenPositions: this.runtimeConfig.maxOpenPositions,
      },
      activeFilters: { ...this.activeFilters },
      blockedStats: { ...this.blockedStats },
      nextRunAt: this.nextRunAt,
      // Phase 9 observability (append-only — null until first cycle)
      regime: this.regime ? { ...this.regime } : null,
      marketContext: this.marketContext ? { ...this.marketContext } : null,
      circuitBreaker: this.circuitBreaker ? { ...this.circuitBreaker } : null,
      // TSM core sleeve (append-only — null unless the sleeve is enabled)
      tsmCore: this.tsmCore
        ? { ...this.tsmCore, symbols: this.tsmCore.symbols.map((s) => ({ ...s })) }
        : null,
    };
  }
}

export const dashboardState = new DashboardState();
export default dashboardState;

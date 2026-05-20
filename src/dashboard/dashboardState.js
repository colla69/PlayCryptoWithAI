import { loadPersistedState, scheduleSave } from './persistence.js';

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

class DashboardState {
  constructor() {
    this.startTime = new Date();
    this.lastUpdatedAt = new Date();
    this.trades = [];
    this.signalFeed = [];
    this.priceMap = new Map();
    this.priceChangeMap = new Map();
    this.candleMap = new Map();

    // Restore trades + signals that survived the last shutdown.
    const saved = loadPersistedState();
    if (saved?.trades?.length)
      this.trades = saved.trades.slice(0, MAX_TRADES);
    if (saved?.signalFeed?.length)
      this.signalFeed = saved.signalFeed.slice(0, MAX_SIGNALS);
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
    // Active filter configuration (set at startup from config)
    this.activeFilters = {};
    // Running tally of blocked BUY signals this session
    this.blockedStats = { regime: 0, correlation: 0, risk: 0, daily: 0, total: 0 };
    // Timestamp (ms) of the next scheduled cycle — set by main.js after alignment
    this.nextRunAt = null;
  }

  #touch() {
    this.lastUpdatedAt = new Date();
  }

  pushTrade(trade) {
    if (!trade) {
      return;
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
    scheduleSave(this.trades, this.signalFeed);
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
    scheduleSave(this.trades, this.signalFeed);
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
      // Live cycle: merge new candles, deduplicate, keep latest 2500
      const merged = [...existing, ...candles];
      const seen = new Set();
      const unique = merged.filter((c) => {
        if (seen.has(c.timestamp)) return false;
        seen.add(c.timestamp);
        return true;
      });
      unique.sort((a, b) => a.timestamp - b.timestamp);
      this.candleMap.set(symbol, unique.slice(-2_500).map((c) => ({ ...c })));
    }
    this.#touch();
  }

  getCandles(symbol) {
    return (this.candleMap.get(symbol) ?? []).map((candle) => ({ ...candle }));
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
    };
  }

  setActiveFilters(filters = {}) {
    this.activeFilters = { ...filters };
  }

  setNextRunAt(ts) {
    this.nextRunAt = ts ?? null;
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
      },
      activeFilters: { ...this.activeFilters },
      blockedStats: { ...this.blockedStats },
      nextRunAt: this.nextRunAt,
    };
  }
}

export const dashboardState = new DashboardState();
export default dashboardState;

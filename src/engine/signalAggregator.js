import signalBus from '../signals/signalBus.js';
import logger from '../utils/logger.js';

const EXTERNAL_SIGNAL_TTL_MS = 5 * 60 * 1000;
const MAX_EXTERNAL_SIGNALS = 5;
const DEFAULT_CONFIG = {
  webhook: {
    enabled: true,
    port: 3000,
    weight: 0.8,
  },
  telegram: {
    enabled: false,
    channelIds: [],
    weight: 0.6,
  },
  algoWeight: 1,
  minConfidence: 0.5,
};

function mergeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    webhook: {
      ...DEFAULT_CONFIG.webhook,
      ...(config.webhook ?? {}),
    },
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(config.telegram ?? {}),
    },
  };
}

function normalizeConfidence(value, fallback = 0.7) {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeTimestamp(timestamp) {
  const parsed = Date.parse(timestamp ?? new Date().toISOString());
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export class SignalAggregator {
  constructor(strategies = [], config = {}) {
    this.strategies = strategies;
    this.externalSignals = new Map();
    this.config = mergeConfig(config);
    this.minimumConfidence = this.config.minConfidence;
    this.handleExternalSignal = (signal) => this.ingestExternal(signal);
    signalBus.on('signal', this.handleExternalSignal);
  }

  updateConfig(config = {}) {
    this.config = mergeConfig(config);
    this.minimumConfidence = this.config.minConfidence;
    return this.config;
  }

  pruneExternalSignals(symbol) {
    const cutoff = Date.now() - EXTERNAL_SIGNAL_TTL_MS;

    if (symbol) {
      const recentSignals = (this.externalSignals.get(symbol) ?? []).filter(
        (signal) => normalizeTimestamp(signal.timestamp) >= cutoff,
      );

      if (recentSignals.length === 0) {
        this.externalSignals.delete(symbol);
        return [];
      }

      const trimmedSignals = recentSignals.slice(-MAX_EXTERNAL_SIGNALS);
      this.externalSignals.set(symbol, trimmedSignals);
      return trimmedSignals;
    }

    for (const currentSymbol of this.externalSignals.keys()) {
      this.pruneExternalSignals(currentSymbol);
    }

    return [];
  }

  ingestExternal(signal) {
    try {
      if (!signal?.symbol || !signal?.signal) {
        return;
      }

      const normalizedSignal = {
        ...signal,
        symbol: String(signal.symbol).toUpperCase(),
        signal: String(signal.signal).toUpperCase(),
        confidence: normalizeConfidence(signal.confidence),
        timestamp: signal.timestamp ?? new Date().toISOString(),
      };

      const recentSignals = this.pruneExternalSignals(normalizedSignal.symbol);
      this.externalSignals.set(normalizedSignal.symbol, [...recentSignals, normalizedSignal].slice(-MAX_EXTERNAL_SIGNALS));
    } catch (error) {
      logger.error(`Failed to ingest external signal: ${error.message}`);
    }
  }

  getRecentExternalSignals(symbol) {
    if (!symbol) {
      return [];
    }

    return this.pruneExternalSignals(String(symbol).toUpperCase());
  }

  getSourceWeight(source, config = this.config) {
    const normalizedSource = String(source ?? '').toLowerCase();

    if (normalizedSource.includes('telegram')) {
      return Number(config.telegram?.weight ?? DEFAULT_CONFIG.telegram.weight);
    }

    if (normalizedSource.includes('tradingview') || normalizedSource.includes('webhook')) {
      return Number(config.webhook?.weight ?? DEFAULT_CONFIG.webhook.weight);
    }

    return 1;
  }

  aggregate(candles, symbol, config = this.config) {
    const activeConfig = this.updateConfig(config);
    const signals = this.strategies.map((strategy) => strategy.analyze(candles));
    const externalSignals = this.getRecentExternalSignals(symbol);
    const votes = { BUY: 0, SELL: 0, HOLD: 0 };
    const algoWeight = Math.max(0, Number(activeConfig.algoWeight ?? 1));
    let totalWeight = 0;

    for (const result of signals) {
      votes[result.signal] = (votes[result.signal] ?? 0) + algoWeight;
      totalWeight += algoWeight;
    }

    for (const externalSignal of externalSignals) {
      const sourceWeight = Math.max(0, this.getSourceWeight(externalSignal.source, activeConfig));
      const weightedVote = Number((sourceWeight * normalizeConfidence(externalSignal.confidence)).toFixed(4));
      votes[externalSignal.signal] = (votes[externalSignal.signal] ?? 0) + weightedVote;
      totalWeight += weightedVote;
    }

    const rankedSignals = Object.entries(votes).sort((a, b) => b[1] - a[1]);
    const [winningSignal = 'HOLD', winningVotes = 0] = rankedSignals[0] ?? [];
    const tie = rankedSignals.filter(([, count]) => Math.abs(count - winningVotes) < 1e-9).length > 1;
    const confidence = Number((winningVotes / (totalWeight || 1)).toFixed(2));

    if (tie || winningSignal === 'HOLD' || confidence < this.minimumConfidence) {
      return {
        decision: 'HOLD',
        confidence,
        signals,
        externalSignals,
      };
    }

    return {
      decision: winningSignal,
      confidence,
      signals,
      externalSignals,
    };
  }
}

export default SignalAggregator;

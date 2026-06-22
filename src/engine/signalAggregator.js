import '../types.js'; // JSDoc type definitions
import signalBus from '../signals/signalBus.js';
import logger from '../utils/logger.js';
import { aggregateVotes, clampConfidence } from './aggregatorVoting.js';

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

  return clampConfidence(numeric);
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

  destroy() {
    signalBus.off('signal', this.handleExternalSignal);
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

  /**
   * @param {Candle[]} candles
   * @param {string} symbol
   * @param {object} [config]
   * @returns {AggregatorResult}
   */
  aggregate(candles, symbol, config = this.config) {
    const activeConfig = this.updateConfig(config);
    const signals = this.strategies.map((strategy) => strategy.analyze(candles));
    const externalSignals = this.getRecentExternalSignals(symbol);
    const algoWeight = Math.max(0, Number(activeConfig.algoWeight ?? 1));

    for (let i = 0; i < signals.length; i++) {
      const result = signals[i];
      logger.debug(`[AGG] ${symbol}: strategy[${i}]=${this.strategies[i]?.name ?? 'unknown'} → ${result.signal} conf=${(result.confidence ?? 0).toFixed(2)} "${result.reason ?? ''}"`);
    }

    const voteResult = aggregateVotes({
      strategySignals: signals,
      externalSignals,
      algoWeight,
      getSourceWeight: (source) => this.getSourceWeight(source, activeConfig),
    });
    const { winner, confidence, tie, votes } = voteResult;

    logger.debug(`[AGG] ${symbol}: votes BUY=${votes.BUY.toFixed(2)} SELL=${votes.SELL.toFixed(2)} HOLD=${votes.HOLD.toFixed(2)} total_voters=${voteResult.totalVoters} external=${externalSignals.length}`);

    if (tie || winner === 'HOLD' || confidence < this.minimumConfidence) {
      logger.debug(`[AGG] ${symbol}: decision=HOLD confidence=${confidence.toFixed(2)} tie=${tie} belowMin=${confidence < this.minimumConfidence} (minConf=${this.minimumConfidence})`);
      return {
        decision: 'HOLD',
        confidence,
        signals,
        externalSignals,
      };
    }

    logger.debug(`[AGG] ${symbol}: decision=${winner} confidence=${confidence.toFixed(2)} tie=${tie}`);
    return {
      decision: winner,
      confidence,
      signals,
      externalSignals,
    };
  }
}

export default SignalAggregator;

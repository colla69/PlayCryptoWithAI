/**
 * Decision core — the per-cycle decisions live and the backtester share.
 *
 * Live (`main.js`, `core/filters.js`) and `PortfolioBacktester` each used to carry
 * their own copy of the entry gates (in a different order) and of the asymmetric
 * exit. Every parity break this project has had was a rule that existed, or read
 * its input differently, on one side only (plan 2026-10 single-engine rebuild,
 * step 3). These functions are pure: each side gathers its data its own way —
 * live from the exchange and its caches, the backtester from its arrays — and
 * both hand it here, so the order, thresholds, messages and maths cannot drift.
 * Sizing is shared the same way through `computePositionSize` (positionSizing.js).
 */

import { isMarketTrending } from '../utils/indicators.js';
import { mtfAlignScore, mtf4hMomentumScore } from '../utils/mtfAlignment.js';
import { trailingReturn } from '../utils/momentum.js';
import { calcCorrelationCap, calcWeeklyDDBreaker } from '../risk/portfolioRisk.js';

/**
 * The aggregator's decision after the asymmetric exit: a held symbol whose
 * strategies vote SELL by majority exits at 0.7× its entry threshold, even when
 * the aggregate confidence missed the full threshold. Exiting needs less
 * conviction than entering.
 *
 * @param {object} p
 * @param {'BUY'|'SELL'|'HOLD'} p.decision — the aggregator's decision
 * @param {number} p.confidence
 * @param {number} p.sellVotes — strategies voting SELL
 * @param {number} p.totalVotes — strategies voting
 * @param {boolean} p.held — a scalper position is open in this symbol
 * @param {number} p.minConfidence — the symbol's (scaled) entry threshold
 * @returns {{decision: string, asymmetricExit: boolean, sellThreshold?: number}}
 */
export function resolveDecision({ decision, confidence, sellVotes, totalVotes, held, minConfidence }) {
  if (!held || decision !== 'HOLD') return { decision, asymmetricExit: false };
  const sellMajority = totalVotes > 0 && sellVotes > totalVotes / 2;
  const sellThreshold = (minConfidence ?? 0.7) * 0.7;
  if (sellMajority && confidence >= sellThreshold) {
    return { decision: 'SELL', asymmetricExit: true, sellThreshold };
  }
  return { decision, asymmetricExit: false };
}

/**
 * The entry gates on a BUY, in live's order. Returns the first block, or none.
 *
 * Inputs are the data each gate reads, already gathered by the caller:
 *  - weeklyDD:      { recentTrades (live trade-log shape), referenceEquity, nowMs }
 *  - btcDominance:  { value, sma7d, deltaPct } as of the cycle, or null
 *  - candles:       the decision series (closed bars + the forming bar)
 *  - correlation:   { openPositions, matrix }
 *  - bars15m/bars4h: bars closed by the cycle time, oldest first
 *
 * @returns {{blockReason: string|null, gate: string|null, mtfSizeFactor: number}}
 */
export function evaluateEntryGates({
  symbol, config, weeklyDD = null, btcDominance = null, candles = [],
  correlation = null, bars15m = null, bars4h = null,
}) {
  const block = (gate, blockReason) => ({ blockReason, gate, mtfSizeFactor: 1.0 });
  let mtfSizeFactor = 1.0;

  // Weekly DD circuit breaker — first, cheap and global.
  const ddCfg = config.risk?.weeklyDDBreaker;
  if (ddCfg?.enabled && weeklyDD) {
    const breaker = calcWeeklyDDBreaker({
      recentTrades: weeklyDD.recentTrades ?? [],
      referenceEquity: weeklyDD.referenceEquity,
      lossThreshold: ddCfg.lossThreshold ?? 0.10,
      cooldownHours: ddCfg.cooldownHours ?? 72,
      ...(weeklyDD.nowMs != null && { nowMs: weeklyDD.nowMs }),
    });
    if (breaker.blocked) return block('weeklyDDBreaker', breaker.reason);
  }

  // BTC dominance gate — alts only, while BTC.D is clearly above its 7-day SMA.
  const btcdCfg = config.btcDominance;
  if (btcdCfg?.enabled && typeof symbol === 'string' && !symbol.startsWith('BTC/')
      && btcDominance && btcDominance.sma7d != null) {
    const threshold = Number(btcdCfg.blockThresholdPp ?? 1.0);
    if (btcDominance.deltaPct >= threshold) {
      return block('btcDominance', `BTC.D rising +${btcDominance.deltaPct.toFixed(2)}pp vs 7d SMA `
        + `(${btcDominance.value.toFixed(2)}% vs ${btcDominance.sma7d.toFixed(2)}%) ≥ ${threshold}pp — alt entry blocked`);
    }
  }

  // Regime filter — no entries in a ranging (low-ADX) market.
  const regimeCfg = config.regime;
  if (regimeCfg?.enabled && !isMarketTrending(candles, regimeCfg.adxPeriod, regimeCfg.adxThreshold)) {
    return block('regime', `Ranging market (ADX < ${regimeCfg.adxThreshold})`);
  }

  // Correlation cap — not while a correlated position is open.
  const corrCfg = config.correlation;
  if (corrCfg?.enabled && correlation) {
    const cap = calcCorrelationCap({
      candidateSymbol: symbol,
      openPositions: correlation.openPositions ?? [],
      correlationMatrix: correlation.matrix,
      threshold: corrCfg.threshold ?? 0.85,
    });
    if (cap.blocked) {
      const short = cap.conflictSymbol.replace('/USDC', '').replace('/USDT', '');
      return block('correlation', `Correlated with open ${short} (r=${cap.correlation.toFixed(2)})`);
    }
  }

  // MTF 15m alignment — block (or shrink) when the short-term trend is bearish.
  const mtfCfg = config.mtfFilter;
  const alignBars = mtfCfg?.alignBars ?? 16;
  if (mtfCfg?.enabled && Array.isArray(bars15m) && bars15m.length >= alignBars) {
    const score = mtfAlignScore(bars15m, bars15m.length - 1, alignBars);
    const threshold = mtfCfg.minAlignScore ?? 0.5;
    if (score < threshold) {
      const reduce = mtfCfg.reduceFactor ?? 0;
      if (reduce > 0) {
        mtfSizeFactor = reduce;
      } else {
        return block('mtf', `MTF misaligned (15m: ${(score * 100).toFixed(0)}% green < ${(threshold * 100).toFixed(0)}% required)`);
      }
    }
  }

  // 4h momentum — EMA(8)/EMA(21) + RSI direction.
  const cfg4h = config.mtf4hFilter;
  const lookback4h = cfg4h?.lookback ?? 21;
  if (cfg4h?.enabled && Array.isArray(bars4h) && bars4h.length >= lookback4h) {
    const score = mtf4hMomentumScore(bars4h, bars4h.length - 1, lookback4h);
    const minScore = cfg4h.minScore ?? 0.45;
    if (score < minScore) {
      return { ...block('mtf4h', `4h momentum bearish (score=${(score * 100).toFixed(0)}% < ${(minScore * 100).toFixed(0)}% required)`), mtfSizeFactor };
    }
  }

  // Momentum leader — no falling knives (trailing return on the decision series).
  const momCfg = config.momentumFilter;
  if (momCfg?.enabled) {
    const minPct = Number(momCfg.minPct ?? 0);
    const lookback = Number(momCfg.lookback ?? 20);
    const ret = trailingReturn(candles, lookback);
    if (ret < minPct) {
      return { ...block('momentum', `Momentum laggard (${lookback}-bar return ${(ret * 100).toFixed(1)}% < ${(minPct * 100).toFixed(0)}% required)`), mtfSizeFactor };
    }
  }

  return { blockReason: null, gate: null, mtfSizeFactor };
}

/**
 * The order entry candidates get the free slots in: highest confidence first, ties
 * by the symbol's place in config.symbols. Live and the backtester both sort with
 * it, so a contested slot goes to the same symbol on both sides.
 * @param {{confidence: number, order: number}} a
 * @param {{confidence: number, order: number}} b
 */
export function byEntryPriority(a, b) {
  return (b.confidence - a.confidence) || (a.order - b.order);
}

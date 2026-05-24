/**
 * Support & Resistance Strategy
 *
 * Detects key horizontal price zones by finding swing highs (resistance) and
 * swing lows (support) over the full available candle history, clusters nearby
 * levels into zones, and signals when price is approaching a well-tested level.
 *
 * BUY  — price is near (within nearZonePct) a support zone with ≥ minTouches
 * SELL — price is near (within nearZonePct) a resistance zone with ≥ minTouches
 * HOLD — no significant zone nearby, or price is between conflicting zones
 *
 * Uses the full candle history (up to `lookback` candles) — the longer the
 * history, the more meaningful the levels.
 */

export class SupportResistanceStrategy {
  constructor(config = {}) {
    this.config = {
      lookback:      2000,   // use up to 2000 candles of history (~3+ years on 12h)
      swingWindow:   5,      // bars on each side to confirm a swing pivot
      zoneTolerance: 0.005,  // 0.5% band for clustering nearby pivots into one zone
      minTouches:    2,      // minimum pivot touches to consider a zone valid
      nearZonePct:   0.015,  // price within 1.5% of a zone = "near it"
      ...config,
    };
  }

  analyze(candles) {
    const {
      lookback,
      swingWindow,
      zoneTolerance,
      minTouches,
      nearZonePct,
    } = this.config;

    // Never use the forming candle
    const closed = candles.slice(0, -1);
    if (closed.length < swingWindow * 2 + 2) {
      return { name: 'SupportResistance', signal: 'HOLD', confidence: 0, reason: 'Insufficient data' };
    }

    const data         = closed.slice(-Math.min(lookback, closed.length));
    const currentPrice = data.at(-1).close;

    // ── 1. Identify swing pivots ─────────────────────────────────────────────
    const swingHighs = [];
    const swingLows  = [];

    for (let i = swingWindow; i < data.length - swingWindow; i++) {
      const c      = data[i];
      let isHigh   = true;
      let isLow    = true;

      for (let j = i - swingWindow; j <= i + swingWindow; j++) {
        if (j === i) continue;
        if (data[j].high >= c.high) isHigh = false;
        if (data[j].low  <= c.low)  isLow  = false;
        if (!isHigh && !isLow) break;
      }

      if (isHigh) swingHighs.push(c.high);
      if (isLow)  swingLows.push(c.low);
    }

    // ── 2. Cluster levels into zones ─────────────────────────────────────────
    const cluster = (levels) => {
      if (!levels.length) return [];
      const sorted = [...levels].sort((a, b) => a - b);
      const zones  = [];
      let group    = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        if ((sorted[i] - sorted[i - 1]) / sorted[i - 1] <= zoneTolerance) {
          group.push(sorted[i]);
        } else {
          zones.push({
            level:   group.reduce((s, v) => s + v, 0) / group.length,
            touches: group.length,
          });
          group = [sorted[i]];
        }
      }
      zones.push({
        level:   group.reduce((s, v) => s + v, 0) / group.length,
        touches: group.length,
      });
      return zones.filter((z) => z.touches >= minTouches);
    };

    const supports    = cluster(swingLows).sort((a, b) => b.level - a.level);  // desc
    const resistances = cluster(swingHighs).sort((a, b) => a.level - b.level); // asc

    // ── 3. Find nearest relevant zone ────────────────────────────────────────
    // Support below current price (or barely above — price may have just pierced it)
    const nearSupport = supports.find((z) => {
      const dist = (currentPrice - z.level) / z.level;
      return dist >= -0.005 && dist <= nearZonePct;
    });

    // Resistance above current price
    const nearResistance = resistances.find((z) => {
      const dist = (z.level - currentPrice) / currentPrice;
      return dist >= 0 && dist <= nearZonePct;
    });

    // ── 4. Signal logic ──────────────────────────────────────────────────────
    if (nearSupport && !nearResistance) {
      const strength   = Math.min(1, nearSupport.touches / 5);
      const proximity  = 1 - Math.abs(currentPrice - nearSupport.level) / (nearSupport.level * nearZonePct);
      const confidence = Math.min(0.82, 0.38 + strength * 0.28 + proximity * 0.16);
      return {
        name:       'SupportResistance',
        signal:     'BUY',
        confidence: Number(confidence.toFixed(4)),
        reason:     `Support ${nearSupport.level.toFixed(4)} (${nearSupport.touches}×)`,
      };
    }

    if (nearResistance && !nearSupport) {
      const strength   = Math.min(1, nearResistance.touches / 5);
      const proximity  = 1 - (nearResistance.level - currentPrice) / (currentPrice * nearZonePct);
      const confidence = Math.min(0.82, 0.38 + strength * 0.28 + proximity * 0.16);
      return {
        name:       'SupportResistance',
        signal:     'SELL',
        confidence: Number(confidence.toFixed(4)),
        reason:     `Resistance ${nearResistance.level.toFixed(4)} (${nearResistance.touches}×)`,
      };
    }

    // Price is between conflicting zones or no zone nearby — HOLD
    return {
      name:       'SupportResistance',
      signal:     'HOLD',
      confidence: 0.1,
      reason:     'No significant S/R zone nearby',
    };
  }
}

/**
 * Functional entry point (SKILL.md contract).
 * Delegates to SupportResistanceStrategy for convenience.
 *
 * @param {Array<{timestamp,open,high,low,close,volume}>} candles
 * @param {object} params
 * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
 */
export function computeSignal(candles, params = {}) {
  return new SupportResistanceStrategy(params).analyze(candles);
}

export default SupportResistanceStrategy;

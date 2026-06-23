/**
 * Ichimoku Cloud Strategy
 *
 * Multi-component indicator combining four lines that, together, describe
 * momentum, equilibrium, and support/resistance in a single read:
 *
 *   • Tenkan-sen  (9)  — (highest-9 + lowest-9) / 2:  short-term momentum
 *   • Kijun-sen   (26) — (highest-26 + lowest-26) / 2: medium equilibrium
 *   • Senkou A         — (Tenkan + Kijun) / 2:        nearer cloud edge
 *   • Senkou B   (52)  — (highest-52 + lowest-52) / 2: farther cloud edge
 *
 * The "cloud" is the band between Senkou A and Senkou B.  Classical Ichimoku
 * projects the cloud forward 26 bars on the chart for visual signalling;
 * for trade decisioning we compare the **current** Senkou values to the
 * current price (the spec) — the projection is a charting convenience, not
 * a different calculation.
 *
 * Why this is orthogonal to the existing pool:
 *   • Combines a momentum cross (TK) with a structural break (cloud) in one
 *     vote, so it fires only when both timeframes agree.
 *   • The 9/26/52 horizons span shorter and longer windows than any of our
 *     other indicators — captures regime more than wiggle.
 *
 * BUY  — price > cloud top AND Tenkan > Kijun (TK aligned bullish)
 * SELL — price < cloud bottom AND Tenkan < Kijun (TK aligned bearish)
 * HOLD — price inside the cloud OR TK direction conflicts with cloud
 *
 * Confidence:  base 0.60
 *   + 0.10 if TK direction flipped this bar (fresh cross, not stale alignment)
 *   + 0.10 if the cloud is "thick" (|SpanA − SpanB| > 1% of price), since a
 *          thick cloud means a sturdier S/R wall behind the breakout
 *   capped at 0.90 (max under spec = 0.80; cap left at 0.90 for safety).
 */

export class IchimokuStrategy {
  constructor(config = {}) {
    this.config = {
      tenkanPeriod:  9,
      kijunPeriod:   26,
      spanBPeriod:   52,
      thickCloudPct: 0.01, // |SpanA − SpanB| / price > this → "thick"
      ...config,
    };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1); // exclude forming candle
    const { tenkanPeriod, kijunPeriod, spanBPeriod, thickCloudPct } = this.config;
    const needed = spanBPeriod + 2; // +2 to compute prev-bar TK for cross detection

    if (closed.length < needed) {
      return {
        name: 'Ichimoku', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for Ichimoku — need ${needed}`,
      };
    }

    const midpoint = (window) => {
      let hi = -Infinity, lo = Infinity;
      for (const c of window) {
        if (c.high > hi) hi = c.high;
        if (c.low  < lo) lo = c.low;
      }
      return (hi + lo) / 2;
    };

    // Current-bar lines
    const tenkan = midpoint(closed.slice(-tenkanPeriod));
    const kijun  = midpoint(closed.slice(-kijunPeriod));
    const spanA  = (tenkan + kijun) / 2;
    const spanB  = midpoint(closed.slice(-spanBPeriod));

    // Previous-bar lines (for fresh-cross detection)
    const prevTenkan = midpoint(closed.slice(-tenkanPeriod - 1, -1));
    const prevKijun  = midpoint(closed.slice(-kijunPeriod  - 1, -1));

    const price       = closed.at(-1).close;
    const cloudTop    = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);

    const tkBullish     = tenkan > kijun;
    const tkBearish     = tenkan < kijun;
    const prevTkBullish = prevTenkan > prevKijun;
    const freshTkCross  =
      (tkBullish && !prevTkBullish) || (tkBearish && prevTkBullish);

    const cloudThick = price > 0 && (Math.abs(spanA - spanB) / price) > thickCloudPct;

    const aboveCloud = price > cloudTop;
    const belowCloud = price < cloudBottom;

    if (aboveCloud && tkBullish) {
      const confidence = Number(Math.min(
        0.90,
        0.60 + (freshTkCross ? 0.10 : 0) + (cloudThick ? 0.10 : 0),
      ).toFixed(4));
      return {
        name: 'Ichimoku', signal: 'BUY', confidence,
        reason: `Above cloud (top ${cloudTop.toFixed(4)}), TK bullish${freshTkCross ? ' (fresh cross)' : ''}${cloudThick ? ', thick cloud' : ''}`,
      };
    }

    if (belowCloud && tkBearish) {
      const confidence = Number(Math.min(
        0.90,
        0.60 + (freshTkCross ? 0.10 : 0) + (cloudThick ? 0.10 : 0),
      ).toFixed(4));
      return {
        name: 'Ichimoku', signal: 'SELL', confidence,
        reason: `Below cloud (bot ${cloudBottom.toFixed(4)}), TK bearish${freshTkCross ? ' (fresh cross)' : ''}${cloudThick ? ', thick cloud' : ''}`,
      };
    }

    const where = aboveCloud ? 'above cloud' : belowCloud ? 'below cloud' : 'inside cloud';
    const why   = (aboveCloud || belowCloud) ? 'TK direction conflicts' : 'awaiting break';
    return {
      name: 'Ichimoku', signal: 'HOLD', confidence: 0.15,
      reason: `${where} — ${why}`,
    };
  }
}

export default IchimokuStrategy;

import { calculateBollingerBands } from '../utils/indicators.js';

// BB signals during a squeeze are unreliable — bands are too compressed to mean anything.
// Minimum bandwidth (relative to middle) required before emitting a signal.
const MIN_BANDWIDTH = 0.04;  // 4% of midline

export class BollingerBandsStrategy {
  constructor(config = {}) {
    this.config = { period: 20, stdDev: 2, ...config };
  }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    const closes = closed.map((c) => c.close);

    if (closes.length < this.config.period) {
      return { name: 'BollingerBands', signal: 'HOLD', confidence: 0,
        reason: `Not enough candles for BB(${this.config.period},${this.config.stdDev})` };
    }

    const bands = calculateBollingerBands(closes, this.config.period, this.config.stdDev);
    if (!bands.length) {
      return { name: 'BollingerBands', signal: 'HOLD', confidence: 0, reason: 'BB: insufficient data' };
    }

    const { upper, middle, lower } = bands.at(-1);
    const price     = closes.at(-1);
    const bandwidth = (upper - lower) / middle;

    // Squeeze filter: compressed bands = no reliable mean-reversion signal
    if (bandwidth < MIN_BANDWIDTH) {
      return {
        name: 'BollingerBands',
        signal: 'HOLD',
        price, upper, middle, lower,
        bandwidth: Number(bandwidth.toFixed(6)),
        confidence: 0.1,
        reason: `BB squeeze (bw ${(bandwidth * 100).toFixed(1)}%) — awaiting expansion`,
      };
    }

    const bandRange = upper - lower;

    if (price <= lower) {
      // Confidence scales with penetration: touching lower band = 0.5, deeper = up to 1.0
      const penetration = bandRange > 0 ? Math.min((lower - price) / (bandRange * 0.5), 1) : 0;
      const confidence  = Number((0.5 + penetration * 0.5).toFixed(2));
      return {
        name: 'BollingerBands',
        signal: 'BUY',
        price, upper, middle, lower,
        bandwidth: Number(bandwidth.toFixed(6)),
        confidence,
        reason: `Price ${price.toFixed(4)} ≤ lower BB ${lower.toFixed(4)} (bw ${(bandwidth * 100).toFixed(1)}%)`,
      };
    }

    if (price >= upper) {
      const penetration = bandRange > 0 ? Math.min((price - upper) / (bandRange * 0.5), 1) : 0;
      const confidence  = Number((0.5 + penetration * 0.5).toFixed(2));
      return {
        name: 'BollingerBands',
        signal: 'SELL',
        price, upper, middle, lower,
        bandwidth: Number(bandwidth.toFixed(6)),
        confidence,
        reason: `Price ${price.toFixed(4)} ≥ upper BB ${upper.toFixed(4)} (bw ${(bandwidth * 100).toFixed(1)}%)`,
      };
    }

    return {
      name: 'BollingerBands',
      signal: 'HOLD',
      price, upper, middle, lower,
      bandwidth: Number(bandwidth.toFixed(6)),
      confidence: 0.2,
      reason: `Price ${price.toFixed(4)} inside BB [${lower.toFixed(4)}–${upper.toFixed(4)}]`,
    };
  }
}

export default BollingerBandsStrategy;

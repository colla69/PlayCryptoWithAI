const MIDNIGHT_CHECK_INTERVAL_MS = 60_000;

function getDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export class RiskManager {
  constructor(config = {}) {
    this.config = {
      initialBalance: Number(config.initialBalance ?? 0),
      maxDailyLossPct: Number(config.maxDailyLossPct ?? 0),
      maxOpenPositions: Number(config.maxOpenPositions ?? Number.POSITIVE_INFINITY),
      minConfidence: Number(config.minConfidence ?? 0),
    };

    this.dailyPnL = 0;
    this.tradesCount = 0;
    this.blocked = false;
    this.currentDayKey = getDayKey();
    this.midnightCheckId = setInterval(() => this.#checkDayRollover(), MIDNIGHT_CHECK_INTERVAL_MS);
    this.midnightCheckId.unref?.();
  }

  canTrade(symbol, decision, confidence, currentStatus = {}, minConfidenceOverride) {
    this.#checkDayRollover();

    if (decision === 'HOLD') {
      return { allowed: true, reason: 'No trade requested' };
    }

    const positions = Array.isArray(currentStatus.positions) ? currentStatus.positions : [];
    const hasOpenPosition = positions.some((position) => position.symbol === symbol);

    if (hasOpenPosition) {
      return { allowed: true, reason: 'Managing existing position' };
    }

    // Use per-symbol override when provided, else fall back to global minimum
    const minConf = Number.isFinite(Number(minConfidenceOverride))
      ? Number(minConfidenceOverride)
      : this.config.minConfidence;
    const normalizedConfidence = Number(confidence ?? 0);
    if (normalizedConfidence < minConf) {
      return {
        allowed: false,
        reason: `Confidence ${normalizedConfidence.toFixed(2)} below minimum ${minConf.toFixed(2)}`,
      };
    }

    if (positions.length >= this.config.maxOpenPositions) {
      return {
        allowed: false,
        reason: `Open positions ${positions.length}/${this.config.maxOpenPositions} limit reached`,
      };
    }

    if (this.#dailyLossLimitExceeded()) {
      this.blocked = true;
      return {
        allowed: false,
        reason: `Daily loss limit reached (${this.dailyPnL.toFixed(2)})`,
      };
    }

    return { allowed: true, reason: 'Trade allowed' };
  }

  recordTrade(pnl) {
    this.#checkDayRollover();
    const numericPnL = Number(pnl ?? 0);

    if (!Number.isFinite(numericPnL)) {
      return this.getDailyStats();
    }

    this.dailyPnL = Number((this.dailyPnL + numericPnL).toFixed(2));
    this.tradesCount += 1;
    this.blocked = this.#dailyLossLimitExceeded();
    return this.getDailyStats();
  }

  resetDailyStats() {
    this.dailyPnL = 0;
    this.tradesCount = 0;
    this.blocked = false;
    this.currentDayKey = getDayKey();
    return this.getDailyStats();
  }

  getDailyStats() {
    this.#checkDayRollover();
    return {
      dailyPnL: Number(this.dailyPnL.toFixed(2)),
      tradesCount: this.tradesCount,
      blocked: this.blocked || this.#dailyLossLimitExceeded(),
    };
  }

  #checkDayRollover() {
    const today = getDayKey();

    if (today !== this.currentDayKey) {
      this.resetDailyStats();
    }
  }

  #dailyLossLimitExceeded() {
    const maxLoss = this.config.initialBalance * this.config.maxDailyLossPct;
    return maxLoss > 0 && this.dailyPnL <= -maxLoss;
  }
}

export default RiskManager;

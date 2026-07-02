import logger from '../utils/logger.js';
import { calcEquityFromStatus } from './portfolioRisk.js';

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
    // Last known live account equity (free quote + open position value),
    // refreshed from the status passed to canTrade(). The %-based daily-loss
    // limit scales off this so deposits/withdrawals/growth move the limit;
    // config.initialBalance is only the fallback before the first reading.
    this.lastEquity = null;
    this.currentDayKey = getDayKey();
    this.midnightCheckId = setInterval(() => this.#checkDayRollover(), MIDNIGHT_CHECK_INTERVAL_MS);
    this.midnightCheckId.unref?.();
  }

  /**
   * Seed today's P&L from persisted trade history so the daily loss limit
   * survives bot restarts. Call this once after dashboardState is loaded.
   * Only counts SELL trades that closed today (UTC date match).
   *
   * @param {Array<{side: string, pnl: number, timestamp: string}>} trades
   */
  seedFromHistory(trades = []) {
    const todayKey = getDayKey();
    const todayPnL = trades
      .filter((t) => {
        if (t.side !== 'SELL') return false;
        const ts = t.timestamp ? getDayKey(new Date(t.timestamp)) : null;
        return ts === todayKey;
      })
      .reduce((sum, t) => sum + Number(t.pnl ?? 0), 0);

    if (todayPnL !== 0) {
      this.dailyPnL = Number(todayPnL.toFixed(2));
      this.tradesCount = trades.filter((t) => {
        if (t.side !== 'SELL') return false;
        const ts = t.timestamp ? getDayKey(new Date(t.timestamp)) : null;
        return ts === todayKey;
      }).length;
      this.blocked = this.#dailyLossLimitExceeded();
    }
  }

  canTrade(symbol, decision, confidence, currentStatus = {}, minConfidenceOverride) {
    this.#checkDayRollover();

    if (decision === 'HOLD') {
      return { allowed: true, reason: 'No trade requested' };
    }

    // Track live equity for the daily-loss brake. Only positive readings are
    // kept — a failed balance fetch (balance 0, no positions) must not
    // collapse the limit to zero.
    const equity = calcEquityFromStatus(currentStatus);
    if (equity > 0) this.lastEquity = equity;

    // TSM core sleeve positions have their own capital budget and must not
    // consume the scalper's concurrent-position slots.
    const positions = (Array.isArray(currentStatus.positions) ? currentStatus.positions : [])
      .filter((position) => !position.isCore);
    const hasOpenPosition = positions.some((position) => position.symbol === symbol);

    if (hasOpenPosition) {
      logger.debug(`[RISK] ${symbol}: canTrade=true (managing existing position) decision=${decision}`);
      return { allowed: true, reason: 'Managing existing position' };
    }

    // Use per-symbol override when provided, else fall back to global minimum
    const minConf = Number.isFinite(Number(minConfidenceOverride))
      ? Number(minConfidenceOverride)
      : this.config.minConfidence;
    const normalizedConfidence = Number(confidence ?? 0);
    if (normalizedConfidence < minConf) {
      const result = {
        allowed: false,
        reason: `Confidence ${normalizedConfidence.toFixed(2)} below minimum ${minConf.toFixed(2)}`,
      };
      logger.debug(`[RISK] ${symbol}: canTrade=false conf=${normalizedConfidence.toFixed(2)}<${minConf.toFixed(2)} positions=${positions.length}/${this.config.maxOpenPositions} dailyPnL=${this.dailyPnL.toFixed(2)} blocked=${this.blocked}`);
      return result;
    }

    if (positions.length >= this.config.maxOpenPositions) {
      const result = {
        allowed: false,
        reason: `Open positions ${positions.length}/${this.config.maxOpenPositions} limit reached`,
      };
      logger.debug(`[RISK] ${symbol}: canTrade=false maxPositions positions=${positions.length}/${this.config.maxOpenPositions} dailyPnL=${this.dailyPnL.toFixed(2)}`);
      return result;
    }

    // Recomputed (not latched) so a deposit that grows equity above the
    // breach point lifts the block, symmetric with recordTrade().
    this.blocked = this.#dailyLossLimitExceeded();
    if (this.blocked) {
      logger.debug(`[RISK] ${symbol}: canTrade=false dailyLossLimit dailyPnL=${this.dailyPnL.toFixed(2)} maxLoss=${(this.#referenceEquity() * this.config.maxDailyLossPct).toFixed(2)}`);
      return {
        allowed: false,
        reason: `Daily loss limit reached (${this.dailyPnL.toFixed(2)})`,
      };
    }

    logger.debug(`[RISK] ${symbol}: canTrade=true decision=${decision} conf=${normalizedConfidence.toFixed(2)} positions=${positions.length}/${this.config.maxOpenPositions} dailyPnL=${this.dailyPnL.toFixed(2)}`);
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
    logger.debug(`[RISK] recordTrade pnl=${numericPnL.toFixed(2)} dailyPnL=${this.dailyPnL.toFixed(2)} trades=${this.tradesCount} blocked=${this.blocked}`);
    return this.getDailyStats();
  }

  resetDailyStats() {
    const prevPnL = this.dailyPnL;
    const prevTrades = this.tradesCount;
    this.dailyPnL = 0;
    this.tradesCount = 0;
    this.blocked = false;
    this.currentDayKey = getDayKey();
    logger.info(`[RISK] Day rollover — resetting daily stats (prev: pnl=${prevPnL.toFixed(2)} trades=${prevTrades})`);
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

  /** Base for %-of-account limits: live equity when known, else config. */
  #referenceEquity() {
    return this.lastEquity > 0 ? this.lastEquity : this.config.initialBalance;
  }

  #dailyLossLimitExceeded() {
    const maxLoss = this.#referenceEquity() * this.config.maxDailyLossPct;
    return maxLoss > 0 && this.dailyPnL <= -maxLoss;
  }
}

export default RiskManager;

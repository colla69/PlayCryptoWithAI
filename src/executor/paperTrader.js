import logger, { appendTrade } from '../utils/logger.js';

const roundMoney = (value) => Number(value.toFixed(2));
const roundPrice = (value) => Number(value.toFixed(8));
const roundQty = (value) => Number(value.toFixed(8));

export class PaperTrader {
  constructor(config) {
    this.config = {
      ...config,
      trailingStopPct: Number.isFinite(Number(config.trailingStopPct))
        ? Number(config.trailingStopPct)
        : undefined,
    };
    this.balance = roundMoney(config.initialBalance);
    this.positions = new Map();
    this.totalPnL = 0;
  }

  execute(symbol, decision, currentPrice, riskOverride) {
    const price = roundPrice(currentPrice);
    const riskResult = this.#checkRisk(symbol, price);

    if (riskResult) {
      return riskResult;
    }

    if (decision === 'BUY') {
      return this.#openPosition(symbol, price, riskOverride);
    }

    if (decision === 'SELL') {
      return this.#closePosition(symbol, price, 'strategy_sell');
    }

    return null;
  }

  getStatus() {
    return {
      balance: roundMoney(this.balance),
      positions: Array.from(this.positions.entries()).map(([symbol, position]) => {
        const currentPrice = roundPrice(position.currentPrice ?? position.entryPrice);
        return {
          symbol,
          qty: roundQty(position.qty),
          entryPrice: roundPrice(position.entryPrice),
          currentPrice,
          unrealizedPnl: roundMoney((currentPrice - position.entryPrice) * position.qty),
          stopLoss: roundPrice(position.stopLoss),
          takeProfit: roundPrice(position.takeProfit),
          highWaterMark: roundPrice(position.highWaterMark),
          openedAt: position.openedAt,
        };
      }),
      totalPnL: roundMoney(this.totalPnL),
    };
  }

  #checkRisk(symbol, currentPrice) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }

    this.#updateTrailingStop(symbol, currentPrice);

    // Track latest price for status reporting
    position.currentPrice = roundPrice(currentPrice);

    // Break-even: once price rises enough above entry, lock stop at entry price
    // so the trade can no longer result in a loss.
    const bePct = Number(this.config.breakEvenTriggerPct ?? 0);
    if (bePct > 0 && position.stopLoss < position.entryPrice) {
      if (currentPrice >= position.entryPrice * (1 + bePct)) {
        position.stopLoss = position.entryPrice;
        logger.info(`[PAPER] ${symbol}: break-even stop locked at ${position.entryPrice}`);
      }
    }

    if (currentPrice <= position.stopLoss) {
      const reason = position.trailingStopPct && position.stopLoss > position.initialStopLoss
        ? 'trailing_stop'
        : 'stop_loss';
      return this.#closePosition(symbol, currentPrice, reason);
    }

    if (currentPrice >= position.takeProfit) {
      return this.#closePosition(symbol, currentPrice, 'take_profit');
    }

    return null;
  }

  #openPosition(symbol, price, riskOverride) {
    if (this.positions.has(symbol)) {
      logger.info(`[PAPER] ${symbol}: BUY skipped, existing position open`);
      return null;
    }

    // Merge per-symbol risk on top of the global config for this trade
    const risk = riskOverride ? { ...this.config, ...riskOverride } : this.config;
    const allocation = roundMoney(this.balance * risk.maxPositionPct);

    if (allocation <= 0) {
      logger.warn(`[PAPER] ${symbol}: BUY skipped, insufficient balance`);
      return null;
    }

    const qty = roundQty(allocation / price);
    const cost = roundMoney(qty * price);

    if (qty <= 0 || cost > this.balance) {
      logger.warn(`[PAPER] ${symbol}: BUY skipped, position sizing invalid`);
      return null;
    }

    // Mirror the live exchange minimum notional so paper results stay comparable
    if (cost < 10) {
      logger.warn(`[PAPER] ${symbol}: BUY skipped, order value ${cost.toFixed(2)} below $10 minimum notional`);
      return null;
    }

    const initialStopLoss = roundPrice(price * (1 - risk.stopLossPct));
    const timestamp = new Date().toISOString();
    const position = {
      qty,
      entryPrice: price,
      initialStopLoss,
      stopLoss: initialStopLoss,
      takeProfit: roundPrice(price * (1 + risk.takeProfitPct)),
      highWaterMark: price,
      trailingStopPct: risk.trailingStopPct,
      openedAt: timestamp,
    };

    this.balance = roundMoney(this.balance - cost);
    this.positions.set(symbol, position);

    logger.info(
      `[PAPER] BUY ${symbol} qty=${qty.toFixed(8)} price=${price.toFixed(8)} balance=${this.balance.toFixed(2)}`,
    );

    appendTrade({
      timestamp,
      symbol,
      side: 'BUY',
      price,
      qty,
      pnl: 0,
      balance: this.balance,
    });

    return {
      ...position,
      symbol,
      side: 'BUY',
      timestamp,
      balance: this.balance,
    };
  }

  #closePosition(symbol, price, reason) {
    const position = this.positions.get(symbol);

    if (!position) {
      if (reason === 'strategy_sell') {
        logger.info(`[PAPER] ${symbol}: SELL skipped, no open position`);
      }
      return null;
    }

    const proceeds = roundMoney(position.qty * price);
    const costBasis = roundMoney(position.qty * position.entryPrice);
    const pnl = roundMoney(proceeds - costBasis);

    this.balance = roundMoney(this.balance + proceeds);
    this.totalPnL = roundMoney(this.totalPnL + pnl);
    this.positions.delete(symbol);

    logger.info(
      `[PAPER] SELL ${symbol} qty=${position.qty.toFixed(8)} price=${price.toFixed(8)} pnl=${pnl.toFixed(2)} reason=${reason} balance=${this.balance.toFixed(2)}`,
    );

    const timestamp = new Date().toISOString();

    appendTrade({
      timestamp,
      symbol,
      side: 'SELL',
      price,
      qty: position.qty,
      pnl,
      balance: this.balance,
    });

    return {
      ...position,
      symbol,
      side: 'SELL',
      timestamp,
      exitPrice: price,
      pnl,
      reason,
      balance: this.balance,
      openedAt: position.openedAt,
    };
  }

  #updateTrailingStop(symbol, currentPrice) {
    const position = this.positions.get(symbol);

    if (!position || !position.trailingStopPct) {
      return null;
    }

    if (currentPrice <= position.entryPrice || currentPrice <= position.highWaterMark) {
      return null;
    }

    position.highWaterMark = roundPrice(currentPrice);
    const nextStopLoss = roundPrice(currentPrice * (1 - position.trailingStopPct));

    if (nextStopLoss > position.stopLoss) {
      position.stopLoss = nextStopLoss;
      return position;
    }

    return null;
  }

  /**
   * Restore an in-memory position from a persisted BUY trade record.
   * Called on startup to rebuild the positions Map from trade history so that
   * SL/TP management and the dashboard positions panel work correctly after a restart.
   *
   * @param {object} trade - A BUY trade object previously saved by pushTrade / appendTrade
   */
  restorePosition(trade) {
    const symbol = trade.symbol;
    if (!symbol || this.positions.has(symbol)) return;

    const entryPrice = Number(trade.entryPrice ?? trade.price ?? 0);
    if (entryPrice <= 0) return;

    this.positions.set(symbol, {
      qty:             Number(trade.qty ?? 0),
      entryPrice,
      initialStopLoss: Number(trade.initialStopLoss ?? trade.stopLoss ?? 0),
      stopLoss:        Number(trade.stopLoss ?? trade.initialStopLoss ?? 0),
      takeProfit:      Number(trade.takeProfit ?? 0),
      highWaterMark:   Number(trade.highWaterMark ?? entryPrice),
      trailingStopPct: Number.isFinite(Number(trade.trailingStopPct)) ? Number(trade.trailingStopPct) : undefined,
      openedAt:        trade.openedAt ?? trade.timestamp ?? new Date().toISOString(),
      currentPrice:    entryPrice,
    });

    logger.info(
      `[PAPER] Restored position: ${symbol} qty=${trade.qty} entryPrice=${entryPrice} stopLoss=${trade.stopLoss ?? trade.initialStopLoss ?? 0}`,
    );
  }
}

export default PaperTrader;

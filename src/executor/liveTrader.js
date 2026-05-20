import { createOrder, fetchBalance, fetchOpenOrders, fetchTicker } from '../exchange/binanceClient.js';
import logger, { appendTrade } from '../utils/logger.js';

const MIN_NOTIONAL_USDT = 10;
const roundMoney = (value) => Number(Number(value ?? 0).toFixed(2));
const roundPrice = (value) => Number(Number(value ?? 0).toFixed(8));
const roundQty = (value) => Number(Number(value ?? 0).toFixed(8));

export class LiveTrader {
  constructor(config = {}) {
    this.config = {
      ...config,
      maxPositionPct: Number(config.maxPositionPct ?? 0),
      stopLossPct: Number(config.stopLossPct ?? 0),
      takeProfitPct: Number(config.takeProfitPct ?? 0),
      trailingStopPct: Number(config.trailingStopPct ?? 0),
      maxOpenPositions: Number(config.maxOpenPositions ?? Number.POSITIVE_INFINITY),
    };
    this.positions = new Map();
    this.initialBalance = null;
    this.totalPnL = 0;
  }

  async execute(symbol, decision, currentPrice, riskOverride) {
    const price = roundPrice(currentPrice);

    if (!Number.isFinite(price) || price <= 0) {
      logger.warn(`[LIVE] ${symbol}: invalid price ${currentPrice}`);
      return null;
    }

    const riskResult = await this.checkRisk(symbol, price);
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

  async checkRisk(symbol, currentPrice) {
    try {
      const position = this.positions.get(symbol);

      if (!position) {
        return null;
      }

      await this.#updateTrailingStop(symbol, currentPrice);

      // Break-even: once price rises enough above entry, lock stop at entry price
      const bePct = Number(this.config.breakEvenTriggerPct ?? 0);
      if (bePct > 0 && position.stopLoss < position.entryPrice) {
        if (currentPrice >= position.entryPrice * (1 + bePct)) {
          position.stopLoss = position.entryPrice;
          logger.info(`[LIVE] ${symbol}: break-even stop locked at ${position.entryPrice}`);
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
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: risk check failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  async getStatus() {
    try {
      const balance = await fetchBalance();
      const usdtBalance = roundMoney(balance.free?.USDT ?? balance.total?.USDT ?? 0);

      return {
        balance: usdtBalance,
        positions: Array.from(this.positions.entries()).map(([symbol, position]) => ({
          symbol,
          qty: roundQty(position.qty),
          entryPrice: roundPrice(position.entryPrice),
          stopLoss: roundPrice(position.stopLoss),
          takeProfit: roundPrice(position.takeProfit),
          highWaterMark: roundPrice(position.highWaterMark),
          openedAt: position.openedAt,
        })),
        totalPnL: roundMoney(this.totalPnL),
      };
    } catch (error) {
      logger.error(`[LIVE] status fetch failed - ${this.#formatError(error)}`);
      return {
        balance: 0,
        positions: Array.from(this.positions.entries()).map(([symbol, position]) => ({
          symbol,
          qty: roundQty(position.qty),
          entryPrice: roundPrice(position.entryPrice),
          stopLoss: roundPrice(position.stopLoss),
          takeProfit: roundPrice(position.takeProfit),
          highWaterMark: roundPrice(position.highWaterMark),
          openedAt: position.openedAt,
        })),
        totalPnL: roundMoney(this.totalPnL),
      };
    }
  }

  async syncPositions() {
    try {
      const openOrders = await fetchOpenOrders();
      return {
        openOrders,
        positions: Array.from(this.positions.entries()).map(([symbol, position]) => ({ symbol, ...position })),
      };
    } catch (error) {
      logger.error(`[LIVE] position sync failed - ${this.#formatError(error)}`);
      return {
        openOrders: [],
        positions: Array.from(this.positions.entries()).map(([symbol, position]) => ({ symbol, ...position })),
      };
    }
  }

  async #openPosition(symbol, referencePrice, riskOverride) {
    try {
      if (this.positions.has(symbol)) {
        logger.info(`[LIVE] ${symbol}: BUY skipped, existing position open`);
        return null;
      }

      if (this.positions.size >= this.config.maxOpenPositions) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, max open positions reached`);
        return null;
      }

      // Merge per-symbol risk override on top of global config for this trade
      const risk = riskOverride ? { ...this.config, ...riskOverride } : this.config;
      const balance = await fetchBalance();
      const freeUsdt = Number(balance.free?.USDT ?? balance.total?.USDT ?? 0);

      if (this.initialBalance === null) {
        this.initialBalance = roundMoney(balance.total?.USDT ?? freeUsdt);
      }

      const allocation = roundMoney(freeUsdt * risk.maxPositionPct);
      const qty = roundQty(allocation / referencePrice);
      const notional = roundMoney(qty * referencePrice);

      if (allocation <= 0 || qty <= 0) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, insufficient balance`);
        return null;
      }

      if (notional < MIN_NOTIONAL_USDT) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, order value ${notional.toFixed(2)} below ${MIN_NOTIONAL_USDT} USDT minimum`);
        return null;
      }

      const order = await createOrder(symbol, 'market', 'buy', qty);
      const entryPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
      const reportedQty = Number(order.filled ?? order.amount ?? qty);
      const filledQty = roundQty(reportedQty > 0 ? reportedQty : qty);
      const initialStopLoss = roundPrice(entryPrice * (1 - risk.stopLossPct));
      const trailingStopPct = Number.isFinite(risk.trailingStopPct) && risk.trailingStopPct > 0
        ? risk.trailingStopPct
        : undefined;
      const timestamp = new Date().toISOString();
      const position = {
        qty: filledQty,
        entryPrice,
        initialStopLoss,
        stopLoss: initialStopLoss,
        takeProfit: roundPrice(entryPrice * (1 + risk.takeProfitPct)),
        highWaterMark: entryPrice,
        orderId: order.id,
        side: 'buy',
        trailingStopPct,
        openedAt: timestamp,
      };

      this.positions.set(symbol, position);
      const balanceAfter = await this.#fetchUsdtBalance();

      logger.info(
        `[LIVE] BUY ${symbol} qty=${filledQty.toFixed(8)} price=${entryPrice.toFixed(8)} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
      );

      appendTrade({
        timestamp,
        symbol,
        side: 'BUY',
        price: entryPrice,
        qty: filledQty,
        pnl: 0,
        balance: balanceAfter,
      });

      return {
        symbol,
        side: 'BUY',
        qty: filledQty,
        entryPrice,
        stopLoss: position.stopLoss,
        takeProfit: position.takeProfit,
        timestamp,
        balance: balanceAfter,
        openedAt: timestamp,
      };
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: BUY failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  async #closePosition(symbol, referencePrice, reason) {
    try {
      const position = this.positions.get(symbol);

      if (!position) {
        if (reason === 'strategy_sell') {
          logger.info(`[LIVE] ${symbol}: SELL skipped, no open position`);
        }
        return null;
      }

      const order = await createOrder(symbol, 'market', 'sell', position.qty);
      const exitPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
      const proceeds = roundMoney(position.qty * exitPrice);
      const costBasis = roundMoney(position.qty * position.entryPrice);
      const pnl = roundMoney(proceeds - costBasis);
      const timestamp = new Date().toISOString();
      const balanceAfter = await this.#fetchUsdtBalance();

      this.totalPnL = roundMoney(this.totalPnL + pnl);
      this.positions.delete(symbol);

      logger.info(
        `[LIVE] SELL ${symbol} qty=${position.qty.toFixed(8)} price=${exitPrice.toFixed(8)} pnl=${pnl.toFixed(2)} reason=${reason} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
      );

      appendTrade({
        timestamp,
        symbol,
        side: 'SELL',
        price: exitPrice,
        qty: position.qty,
        pnl,
        balance: balanceAfter,
      });

      return {
        symbol,
        side: 'SELL',
        entryPrice: roundPrice(position.entryPrice),
        exitPrice,
        qty: roundQty(position.qty),
        pnl,
        reason,
        timestamp,
        balance: balanceAfter,
        openedAt: position.openedAt,
      };
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: SELL failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  async #resolveTradePrice(order, symbol, fallbackPrice) {
    const orderPrice = Number(order?.average ?? order?.price ?? 0);
    if (Number.isFinite(orderPrice) && orderPrice > 0) {
      return roundPrice(orderPrice);
    }

    try {
      const ticker = await fetchTicker(symbol);
      const tickerPrice = Number(ticker.last ?? 0);
      if (Number.isFinite(tickerPrice) && tickerPrice > 0) {
        return roundPrice(tickerPrice);
      }
    } catch (error) {
      logger.warn(`[LIVE] ${symbol}: price fallback failed - ${this.#formatError(error)}`);
    }

    return roundPrice(fallbackPrice);
  }

  async #fetchUsdtBalance() {
    const balance = await fetchBalance();
    return roundMoney(balance.free?.USDT ?? balance.total?.USDT ?? 0);
  }

  async #updateTrailingStop(symbol, currentPrice) {
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

  #formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export default LiveTrader;

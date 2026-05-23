import { createOrder, fetchBalance, fetchOpenOrders, fetchTicker } from '../exchange/binanceClient.js';
import logger, { appendTrade } from '../utils/logger.js';

const MIN_NOTIONAL = 1;
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
    // Derive quote currency from the first symbol in config, e.g. BTC/USDC → 'USDC'
    this.quoteCurrency = config.quoteCurrency ?? 'USDC';
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
      const quoteBalance = await this.#fetchQuoteBalance();
      return {
        balance: quoteBalance,
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

  async restorePositionsFromExchange(symbols, fetchTickerFn, getRiskForSymbol, tradeHistory = []) {
    let restored = 0;
    try {
      const balance = await fetchBalance();
      for (const symbol of symbols) {
        try {
          // Skip symbols already tracked in memory
          if (this.positions.has(symbol)) continue;

          const base = symbol.split('/')[0];
          const qty = Number(balance.free?.[base] ?? 0);
          if (qty <= 0) continue;

          // Fetch current price
          const ticker = await fetchTickerFn(symbol);
          const currentPrice = roundPrice(Number(ticker?.last ?? ticker?.close ?? 0));
          if (!currentPrice || currentPrice <= 0) continue;

          const notional = qty * currentPrice;
          if (notional < MIN_NOTIONAL) continue;

          // Find entry price from trade history: walk newest-first
          // Stop at first SELL (no open position) or first BUY (entry price found)
          let entryPrice = currentPrice; // fallback
          let foundEntry = false;
          for (let i = 0; i < tradeHistory.length; i++) {
            const t = tradeHistory[i];
            if (t.symbol !== symbol) continue;
            if (t.side === 'SELL') break; // a SELL before BUY means no open position from history
            if (t.side === 'BUY') {
              entryPrice = roundPrice(Number(t.price ?? currentPrice));
              foundEntry = true;
              break;
            }
          }

          const risk = getRiskForSymbol(symbol);
          const stopLossPct = Number(risk?.stopLossPct ?? this.config.stopLossPct ?? 0);
          const takeProfitPct = Number(risk?.takeProfitPct ?? this.config.takeProfitPct ?? 0);
          const breakEvenTriggerPct = Number(risk?.breakEvenTriggerPct ?? this.config.breakEvenTriggerPct ?? 0);

          const position = {
            symbol,
            qty: roundQty(qty),
            entryPrice: roundPrice(entryPrice),
            currentPrice: roundPrice(currentPrice),
            stopLoss: roundPrice(entryPrice * (1 - stopLossPct)),
            takeProfit: roundPrice(entryPrice * (1 + takeProfitPct)),
            breakEvenTriggerPct,
            pnl: roundMoney((currentPrice - entryPrice) * roundQty(qty)),
            pnlPct: roundMoney(((currentPrice - entryPrice) / entryPrice) * 100),
            entryTime: Date.now(),
            // Internal fields expected by checkRisk / trailing stop
            initialStopLoss: roundPrice(entryPrice * (1 - stopLossPct)),
            highWaterMark: roundPrice(currentPrice),
            trailingStopPct: Number.isFinite(this.config.trailingStopPct) && this.config.trailingStopPct > 0
              ? this.config.trailingStopPct
              : undefined,
            openedAt: foundEntry ? new Date().toISOString() : new Date().toISOString(),
          };

          this.positions.set(symbol, position);
          restored++;
          logger.info(`[LIVE] Restored position from exchange: ${symbol} qty=${qty} entry=${entryPrice} notional=$${notional.toFixed(2)}`);
        } catch (symErr) {
          logger.warn(`[LIVE] restorePositionsFromExchange: skipped ${symbol} - ${symErr.message}`);
        }
      }
    } catch (err) {
      logger.error(`[LIVE] restorePositionsFromExchange failed: ${err.message}`);
    }
    return restored;
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
      const freeQuote = Number(balance.free?.[this.quoteCurrency] ?? balance.total?.[this.quoteCurrency] ?? 0);

      if (this.initialBalance === null) {
        this.initialBalance = roundMoney(balance.total?.[this.quoteCurrency] ?? freeQuote);
      }

      const allocation = roundMoney(freeQuote * risk.maxPositionPct);
      const qty = roundQty(allocation / referencePrice);
      const notional = roundMoney(qty * referencePrice);

      if (allocation <= 0 || qty <= 0) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, insufficient balance`);
        return null;
      }

      if (notional < MIN_NOTIONAL) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, order value ${notional.toFixed(2)} below ${MIN_NOTIONAL} ${this.quoteCurrency} minimum`);
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
      const balanceAfter = await this.#fetchQuoteBalance();

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

      // Use the actual free balance for the base asset rather than the stored qty.
      // Binance deducts trading fees from the base asset on a BUY, so the real
      // holding is slightly less than what order.filled reported.  Selling the
      // stored qty would cause an "insufficient balance" rejection.
      const base = symbol.split('/')[0];
      let sellQty = position.qty;
      try {
        const bal = await fetchBalance();
        const freeBase = Number(bal.free?.[base] ?? bal.total?.[base] ?? 0);
        if (freeBase > 0 && freeBase < sellQty) {
          logger.info(`[LIVE] ${symbol}: adjusting sell qty ${sellQty.toFixed(8)} → ${freeBase.toFixed(8)} (fee deduction)`);
          sellQty = roundQty(freeBase);
        }
      } catch {
        // fetchBalance failed — fall back to stored qty and let Binance decide
      }

      const order = await createOrder(symbol, 'market', 'sell', sellQty);
      const exitPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
      const proceeds = roundMoney(sellQty * exitPrice);
      const costBasis = roundMoney(position.qty * position.entryPrice);
      const pnl = roundMoney(proceeds - costBasis);
      const timestamp = new Date().toISOString();
      const balanceAfter = await this.#fetchQuoteBalance();

      this.totalPnL = roundMoney(this.totalPnL + pnl);
      this.positions.delete(symbol);

      logger.info(
        `[LIVE] SELL ${symbol} qty=${sellQty.toFixed(8)} price=${exitPrice.toFixed(8)} pnl=${pnl.toFixed(2)} reason=${reason} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
      );

      appendTrade({
        timestamp,
        symbol,
        side: 'SELL',
        price: exitPrice,
        qty: sellQty,
        pnl,
        balance: balanceAfter,
      });

      return {
        symbol,
        side: 'SELL',
        entryPrice: roundPrice(position.entryPrice),
        exitPrice,
        qty: roundQty(sellQty),
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

  async #fetchQuoteBalance() {
    const balance = await fetchBalance();
    return roundMoney(balance.free?.[this.quoteCurrency] ?? balance.total?.[this.quoteCurrency] ?? 0);
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

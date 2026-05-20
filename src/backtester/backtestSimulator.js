const roundMoney = (value) => Number(value.toFixed(2));
const roundPrice = (value) => Number(value.toFixed(8));
const roundQty = (value) => Number(value.toFixed(8));

export class BacktestSimulator {
  constructor(riskConfig = {}) {
    this.config = riskConfig;
    this.initialBalance = roundMoney(Number(riskConfig.initialBalance ?? 0));
    this.balance = this.initialBalance;
    this.positions = new Map();
    this.totalPnL = 0;
    this.totalFees = 0;
    this.trades = [];
    this.equityCurve = [];
    this.currentTimestamp = Date.now();
    this.feePct = Number(riskConfig.feePct ?? 0.001);
    this.slippagePct = Number(riskConfig.slippagePct ?? 0.001);
  }

  setTimestamp(timestamp) {
    this.currentTimestamp = Number(timestamp ?? Date.now());
  }

  execute(symbol, decision, price) {
    const normalizedSymbol = String(symbol);
    const currentPrice = roundPrice(Number(price));
    const riskResult = this.#checkRisk(normalizedSymbol, currentPrice);

    if (riskResult) {
      this.#recordEquitySnapshot(normalizedSymbol, currentPrice);
      return riskResult;
    }

    let tradeResult = null;

    if (decision === 'BUY') {
      tradeResult = this.#openPosition(normalizedSymbol, currentPrice);
    } else if (decision === 'SELL') {
      tradeResult = this.#closePosition(normalizedSymbol, currentPrice, 'strategy_sell');
    }

    this.#recordEquitySnapshot(normalizedSymbol, currentPrice);
    return tradeResult;
  }

  checkAndUpdateTrailingStop(symbol, currentPrice) {
    const position = this.positions.get(symbol);

    if (!position || !Number.isFinite(position.trailingStopPct) || position.trailingStopPct <= 0) {
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

  getTrades() {
    return this.trades.map((trade) => ({ ...trade }));
  }

  getEquityCurve() {
    return this.equityCurve.map((point) => ({ ...point }));
  }

  getStatus() {
    return {
      balance: roundMoney(this.balance),
      positions: Array.from(this.positions.entries()).map(([symbol, position]) => ({
        symbol,
        qty: roundQty(position.qty),
        entryPrice: roundPrice(position.entryPrice),
        stopLoss: roundPrice(position.stopLoss),
        takeProfit: roundPrice(position.takeProfit),
        highWaterMark: roundPrice(position.highWaterMark),
      })),
      totalPnL: roundMoney(this.totalPnL),
      totalFees: roundMoney(this.totalFees),
    };
  }

  #checkRisk(symbol, currentPrice) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }

    this.checkAndUpdateTrailingStop(symbol, currentPrice);

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

  #openPosition(symbol, price) {
    if (this.positions.has(symbol)) {
      return null;
    }

    const allocation = roundMoney(this.balance * Number(this.config.maxPositionPct ?? 0));

    if (allocation <= 0) {
      return null;
    }

    const fillPrice = roundPrice(price * (1 + this.feePct + this.slippagePct));
    const qty = roundQty(allocation / fillPrice);
    const cost = roundMoney(qty * fillPrice);

    if (qty <= 0 || cost > this.balance) {
      return null;
    }

    const feeAmount = roundMoney(qty * price * this.feePct);
    const initialStopLoss = roundPrice(fillPrice * (1 - Number(this.config.stopLossPct ?? 0)));
    const trailingStopPct = Number(this.config.trailingStopPct);
    const position = {
      qty,
      entryPrice: fillPrice,
      entryFillPrice: fillPrice,
      entrySignalPrice: price,
      entryFee: feeAmount,
      costBasis: cost,
      initialStopLoss,
      stopLoss: initialStopLoss,
      takeProfit: roundPrice(fillPrice * (1 + Number(this.config.takeProfitPct ?? 0))),
      trailingStopPct: Number.isFinite(trailingStopPct) && trailingStopPct > 0 ? trailingStopPct : undefined,
      highWaterMark: fillPrice,
      entryTime: this.currentTimestamp,
    };

    this.balance = roundMoney(this.balance - cost);
    this.totalFees = roundMoney(this.totalFees + feeAmount);
    this.positions.set(symbol, position);
    return { ...position, symbol, side: 'BUY' };
  }

  #closePosition(symbol, price, reason) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }

    const fillPrice = roundPrice(price * (1 - this.feePct - this.slippagePct));
    const proceeds = roundMoney(position.qty * fillPrice);
    const costBasis = roundMoney(position.costBasis ?? position.qty * position.entryPrice);
    const feeAmount = roundMoney(position.qty * price * this.feePct);
    const totalFees = roundMoney((position.entryFee ?? 0) + feeAmount);
    const pnl = roundMoney(proceeds - costBasis);

    this.balance = roundMoney(this.balance + proceeds);
    this.totalPnL = roundMoney(this.totalPnL + pnl);
    this.totalFees = roundMoney(this.totalFees + feeAmount);
    this.positions.delete(symbol);

    const trade = {
      symbol,
      side: 'LONG',
      entryPrice: roundPrice(position.entrySignalPrice ?? position.entryPrice),
      exitPrice: roundPrice(price),
      entryFillPrice: roundPrice(position.entryFillPrice ?? position.entryPrice),
      exitFillPrice: fillPrice,
      qty: roundQty(position.qty),
      costBasis,
      proceeds,
      entryFee: roundMoney(position.entryFee ?? 0),
      exitFee: feeAmount,
      totalFees,
      pnl,
      reason,
      entryTime: position.entryTime,
      exitTime: this.currentTimestamp,
    };

    this.trades.push(trade);
    return trade;
  }

  #recordEquitySnapshot(symbol, currentPrice) {
    const openPositionValue = Array.from(this.positions.entries()).reduce((total, [positionSymbol, position]) => {
      const markPrice = positionSymbol === symbol ? currentPrice : position.entryPrice;
      return total + position.qty * markPrice;
    }, 0);

    this.equityCurve.push({
      timestamp: this.currentTimestamp,
      balance: roundMoney(this.balance + openPositionValue),
    });
  }
}

export default BacktestSimulator;

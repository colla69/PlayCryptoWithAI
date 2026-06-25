const roundMoney = (value) => Number(value.toFixed(2));
const roundPrice = (value) => Number(value.toFixed(8));
const roundQty = (value) => Number(value.toFixed(8));

import { calcPartialExit, calcATRStopPrices } from '../executor/traderUtils.js';

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

  execute(symbol, decision, price, opts = {}) {
    const normalizedSymbol = String(symbol);
    const currentPrice = roundPrice(Number(price));
    // fillPrice separates risk-check price (current candle close) from entry fill price
    // (typically next candle open). Falls back to currentPrice when not provided.
    const fillPrice = opts.fillPrice != null ? roundPrice(Number(opts.fillPrice)) : currentPrice;
    const riskResult = this.#checkRisk(normalizedSymbol, currentPrice);

    if (riskResult) {
      this.#recordEquitySnapshot(normalizedSymbol, currentPrice);
      return riskResult;
    }

    let tradeResult = null;

    if (decision === 'BUY') {
      tradeResult = this.#openPosition(normalizedSymbol, fillPrice, opts.positionPct, opts);
    } else if (decision === 'SELL') {
      tradeResult = this.#closePosition(normalizedSymbol, fillPrice, 'strategy_sell', opts);
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

    // Arm-after-profit: don't start trailing until the position is up by trailArmPct,
    // so early noise doesn't shake the rider out before the trend develops.
    const armPct = Number(this.config.trailArmPct ?? 0);
    if (armPct > 0 && currentPrice < position.entryPrice * (1 + armPct)) {
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

    const breakEvenTriggerPct = Number(this.config.breakEvenTriggerPct ?? 0);
    if (
      breakEvenTriggerPct > 0
      && position.stopLoss < position.entryPrice
      && currentPrice >= position.entryPrice * (1 + breakEvenTriggerPct)
    ) {
      // Cover round-trip fees (~0.2%) so break-even is truly net-zero
      position.stopLoss = roundPrice(position.entryPrice * 1.002);
    }

    // ── Two-stage exit (Phase 1) ────────────────────────────────────────────
    // When enabled and the position has reached `firstStagePctOfTp` of the way
    // to its TP target, close `firstStageFraction` of the qty. The remaining
    // qty stays in the position with the original SL/TP — break-even logic
    // above will move SL to entry on the next bar if it hasn't already.
    const twoStage = this.config.twoStageExit;
    if (twoStage?.enabled && !position.partialExitDone) {
      const partial = calcPartialExit(
        position,
        currentPrice,
        Number(twoStage.firstStagePctOfTp ?? 0.5),
        Number(twoStage.firstStageFraction ?? 0.5),
      );
      if (partial.shouldExit) {
        this.#partialClose(symbol, currentPrice, 'partial_exit', partial.fraction);
        position.partialExitDone = true;
        // Force break-even lock immediately for the remainder
        if (position.stopLoss < position.entryPrice) {
          position.stopLoss = roundPrice(position.entryPrice * 1.002);
        }
      }
    }

    // ── Ride-winners partial scale-out ──────────────────────────────────────
    // Take a fraction off at an absolute profit target, then lock break-even on
    // the remainder (which keeps riding via the trailing stop). No-op unless the
    // position was opened with a ridePartialTarget (riding mode only).
    if (position.ridePartialTarget && !position.partialExitDone && currentPrice >= position.ridePartialTarget) {
      this.#partialClose(symbol, currentPrice, 'partial_exit', position.ridePartialFraction);
      position.partialExitDone = true;
      if (position.stopLoss < position.entryPrice) {
        position.stopLoss = roundPrice(position.entryPrice * 1.002);
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

  #partialClose(symbol, price, reason, fraction) {
    const position = this.positions.get(symbol);
    if (!position) return null;
    const closeFrac = Math.min(Math.max(Number(fraction) || 0, 0), 1);
    if (closeFrac <= 0 || closeFrac >= 1) return null;
    const closeQty = roundQty(position.qty * closeFrac);
    if (closeQty <= 0 || closeQty >= position.qty) return null;
    const fillPrice = roundPrice(price * (1 - this.feePct - this.slippagePct));
    const proceeds = roundMoney(closeQty * fillPrice);
    const portionCostBasis = roundMoney(
      (position.costBasis ?? position.qty * position.entryPrice) * closeFrac,
    );
    const portionEntryFee = roundMoney((position.entryFee ?? 0) * closeFrac);
    const exitFee = roundMoney(closeQty * price * this.feePct);
    const pnl = roundMoney(proceeds - portionCostBasis);

    this.balance = roundMoney(this.balance + proceeds);
    this.totalPnL = roundMoney(this.totalPnL + pnl);
    this.totalFees = roundMoney(this.totalFees + exitFee);

    // Reduce the position in-place; preserve entry data on the remainder.
    position.qty = roundQty(position.qty - closeQty);
    position.costBasis = roundMoney(
      (position.costBasis ?? position.qty * position.entryPrice) - portionCostBasis,
    );
    position.entryFee = roundMoney((position.entryFee ?? 0) - portionEntryFee);

    const trade = {
      symbol,
      side: 'LONG',
      entryPrice: roundPrice(position.entrySignalPrice ?? position.entryPrice),
      exitPrice: roundPrice(price),
      entryFillPrice: roundPrice(position.entryFillPrice ?? position.entryPrice),
      exitFillPrice: fillPrice,
      qty: closeQty,
      costBasis: portionCostBasis,
      proceeds,
      entryFee: portionEntryFee,
      exitFee,
      totalFees: roundMoney(portionEntryFee + exitFee),
      pnl,
      reason,
      entryTime: position.entryTime,
      exitTime: this.currentTimestamp,
      partial: true,
    };
    this.trades.push(trade);
    return trade;
  }

  #openPosition(symbol, price, positionPct, opts = {}) {
    if (this.positions.has(symbol)) {
      return null;
    }

    const pct = positionPct != null ? Number(positionPct) : Number(this.config.maxPositionPct ?? 0);
    const allocation = roundMoney(this.balance * pct);

    if (allocation <= 0) {
      return null;
    }

    const slip = opts.slippagePct != null ? Number(opts.slippagePct) : this.slippagePct;
    const fillPrice = roundPrice(price * (1 + this.feePct + slip));
    const qty = roundQty(allocation / fillPrice);
    const cost = roundMoney(qty * fillPrice);

    if (qty <= 0 || cost > this.balance) {
      return null;
    }

    const feeAmount = roundMoney(qty * price * this.feePct);
    const stopLossPrice = Number(opts.stopLossPrice);
    const takeProfitPrice = Number(opts.takeProfitPrice);

    // ── ATR-based stops (Phase 1) ─────────────────────────────────────────
    // If the caller did not pass an explicit stopLossPrice/takeProfitPrice
    // AND atrPct is provided AND config.atrStops.enabled is true, derive
    // SL/TP from ATR. Falls back to fixed percent stops otherwise.
    let derivedSL = null;
    let derivedTP = null;
    const atrStops = this.config.atrStops;
    if (atrStops?.enabled
        && !(Number.isFinite(stopLossPrice) && stopLossPrice > 0)
        && !(Number.isFinite(takeProfitPrice) && takeProfitPrice > 0)
        && Number.isFinite(opts.atrPct) && opts.atrPct > 0) {
      const atrPrices = calcATRStopPrices({
        fillPrice,
        atrPct: opts.atrPct,
        slMultiplier: Number(atrStops.slMultiplier ?? 1.5),
        tpMultiplier: Number(atrStops.tpMultiplier ?? 3.0),
        minSlPct: Number(atrStops.minSlPct ?? 0.02),
        maxSlPct: Number(atrStops.maxSlPct ?? 0.12),
        minTpPct: Number(atrStops.minTpPct ?? 0.04),
        maxTpPct: Number(atrStops.maxTpPct ?? 0.30),
      });
      if (atrPrices) {
        derivedSL = atrPrices.stopLossPrice;
        derivedTP = atrPrices.takeProfitPrice;
      }
    }

    const initialStopLoss = roundPrice(
      Number.isFinite(stopLossPrice) && stopLossPrice > 0
        ? stopLossPrice
        : derivedSL ?? fillPrice * (1 - Number(this.config.stopLossPct ?? 0)),
    );
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
      takeProfit: roundPrice(
        Number.isFinite(takeProfitPrice) && takeProfitPrice > 0
          ? takeProfitPrice
          : derivedTP ?? fillPrice * (1 + Number(this.config.takeProfitPct ?? 0)),
      ),
      trailingStopPct: Number.isFinite(trailingStopPct) && trailingStopPct > 0 ? trailingStopPct : undefined,
      highWaterMark: fillPrice,
      entryTime: this.currentTimestamp,
      partialExitDone: false,
      // Ride-winners partial scale-out: lock a fraction at an absolute profit %,
      // ride the remainder on the trailing stop. Independent of the TP-relative
      // twoStageExit (which is disabled in riding mode). No-op when unconfigured.
      ridePartialTarget: this.config.ridePartial?.pct > 0
        ? roundPrice(fillPrice * (1 + Number(this.config.ridePartial.pct)))
        : undefined,
      ridePartialFraction: Number(this.config.ridePartial?.fraction ?? 0.5),
    };

    this.balance = roundMoney(this.balance - cost);
    this.totalFees = roundMoney(this.totalFees + feeAmount);
    this.positions.set(symbol, position);
    return { ...position, symbol, side: 'BUY' };
  }

  #closePosition(symbol, price, reason, opts = {}) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }

    const slip = opts?.slippagePct != null ? Number(opts.slippagePct) : this.slippagePct;
    const fillPrice = roundPrice(price * (1 - this.feePct - slip));
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

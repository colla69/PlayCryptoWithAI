const roundMoney = (value) => Number(value.toFixed(2));
const roundPrice = (value) => Number(value.toFixed(8));
const roundQty = (value) => Number(value.toFixed(8));

import {
  calcPartialExit, calcATRStopPrices, calcTrailingStop, calcBreakEven, calcExitSignal,
} from '../executor/traderUtils.js';
import { FALLBACK_MIN_NOTIONAL, bumpToMinNotional } from '../exchange/exchangeLimits.js';
import { stepSatellitePosition, satellitePositionPlan } from '../engine/satellites.js';

const HOUR_MS = 3_600_000;
const M15_MS = 900_000;

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
    // Exchange floor, overridable for research (set 0 to model a frictionless
    // exchange — but never for a run that informs a live decision).
    this.minNotional = Number.isFinite(Number(riskConfig.minNotional))
      ? Number(riskConfig.minNotional)
      : FALLBACK_MIN_NOTIONAL;
    this.minNotionalRejections = 0;
    // The portfolio backtester records one equity point per step with every
    // position marked (markEquity); the per-execute points it used to read
    // valued all but one position at entry. Single-symbol callers keep them.
    this.recordEquityOnExecute = riskConfig.recordEquityOnExecute !== false;
    // Satellite limit orders resting on the book, and the cash they lock (as the
    // exchange locks a resting buy's quote balance: no other order can spend it).
    this.pendingSatellite = new Map();
    this.reserved = 0;
    this.satelliteStats = { placed: 0, filled: 0, expired: 0 };
  }

  setTimestamp(timestamp) {
    this.currentTimestamp = Number(timestamp ?? Date.now());
  }

  /**
   * Adds cash, as a deposit to the live account does. Live sizes off its free
   * balance, so a replay of a live period needs the deposits on their dates. The
   * return metrics are not adjusted for deposits; read trades, not returns.
   */
  deposit(amount) {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    this.balance = roundMoney(this.balance + value);
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

    const trailing = calcTrailingStop(this.#stopView(position), currentPrice, this.config.trailArmPct);
    if (trailing.newHighWaterMark) position.highWaterMark = trailing.newHighWaterMark;
    if (trailing.shouldUpdate) {
      position.stopLoss = trailing.newStopLoss;
      return position;
    }
    return null;
  }

  /**
   * One price tick through the stop logic, filled at that price — the call
   * LiveTrader.checkRisk and PaperTrader.checkRisk answer (orderContract.test.js).
   * @returns {object|null} the closing trade, if a stop or target fired
   */
  checkRisk(symbol, price) {
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return null;
    return this.#checkRisk(String(symbol), roundPrice(value));
  }

  /**
   * TSM core sleeve positions, as LiveTrader / PaperTrader open them: a dollar
   * allocation (capped at the free balance), no stop and no target — the only exit is
   * closeCore on the vote flip — and resizes that add or trim at a blended entry.
   * Fees, slippage and the exchange floor as for any order. Key: '<symbol>#core'.
   */
  openCore(key, price, allocationUsd, { slippagePct } = {}) {
    if (this.positions.has(key)) return null;
    const allocation = roundMoney(Math.min(Number(allocationUsd) || 0, this.balance));
    const slip = slippagePct != null ? Number(slippagePct) : this.slippagePct;
    const fillPrice = roundPrice(Number(price) * (1 + this.feePct + slip));
    const qty = roundQty(allocation / fillPrice);
    const cost = roundMoney(qty * fillPrice);
    if (qty <= 0 || cost > this.balance) return null;
    if (cost < this.minNotional) { this.minNotionalRejections += 1; return null; }
    const position = {
      qty, entryPrice: fillPrice, entryFillPrice: fillPrice, entrySignalPrice: roundPrice(Number(price)),
      entryFee: roundMoney(qty * Number(price) * this.feePct), costBasis: cost,
      initialStopLoss: 0, stopLoss: 0, takeProfit: Infinity, highWaterMark: fillPrice,
      entryTime: this.currentTimestamp, positionPct: null, partialExitDone: false, isCore: true,
      lastPrice: roundPrice(Number(price)),
    };
    this.balance = roundMoney(this.balance - cost);
    this.totalFees = roundMoney(this.totalFees + position.entryFee);
    this.positions.set(key, position);
    return { ...position, symbol: key, side: 'BUY' };
  }

  closeCore(key, price, { slippagePct } = {}) {
    if (!this.positions.get(key)?.isCore) return null;
    return this.#closePosition(key, roundPrice(Number(price)), 'tsm_core_flip', { slippagePct });
  }

  resizeCore(key, price, deltaUsd, { slippagePct } = {}) {
    const position = this.positions.get(key);
    if (!position?.isCore) return null;
    const p = roundPrice(Number(price));
    position.lastPrice = p;
    const slip = slippagePct != null ? Number(slippagePct) : this.slippagePct;
    if (deltaUsd > 0) {
      const spend = roundMoney(Math.min(deltaUsd, this.balance));
      if (spend < this.minNotional) return null;
      const fillPrice = roundPrice(p * (1 + this.feePct + slip));
      const addQty = roundQty(spend / fillPrice);
      const cost = roundMoney(addQty * fillPrice);
      position.costBasis = roundMoney(position.costBasis + cost);
      position.qty = roundQty(position.qty + addQty);
      position.entryPrice = roundPrice(position.costBasis / position.qty);
      position.entryFee = roundMoney(position.entryFee + addQty * p * this.feePct);
      this.balance = roundMoney(this.balance - cost);
      return { symbol: key, side: 'BUY', qty: addQty, price: p, reason: 'tsm_core_resize', isCore: true };
    }
    if (deltaUsd < 0) {
      const sellQty = roundQty(Math.min(-deltaUsd / p, position.qty));
      if (sellQty * p < this.minNotional) return null;
      if (sellQty >= position.qty) return this.closeCore(key, p, { slippagePct });
      return this.#partialClose(key, p, 'tsm_core_resize', sellQty / position.qty);
    }
    return null;
  }

  /** Marks an open position at a price without touching its stops (as live's markPrice). */
  markPrice(symbol, price) {
    const position = this.positions.get(String(symbol));
    const value = Number(price);
    if (!position || !Number.isFinite(value) || value <= 0) return false;
    position.lastPrice = roundPrice(value);
    return true;
  }

  // ── Satellite strategies ('<symbol>#bo' / '<symbol>#rs', src/engine/satellites.js) ──
  // A resting limit buy that locks its cash until it fills or expires; a filled
  // position exits by its plan on 15m bars (replaySatelliteBar). Costs as live pays
  // them: the resting limit buy is a maker fill (fee only); every exit — stop,
  // break-even, target, tier, time — is a marketable limit sell into the bid, as
  // LiveTrader sends it (fee + slippage), with a market sell only as the fallback.

  /** @returns {object|null} the resting order, or null (already held or pending, no cash) */
  placeSatelliteOrder(key, { limitPrice, validUntil, sizeUsd, stopPrice, plan, slippagePct } = {}) {
    if (this.positions.has(key) || this.pendingSatellite.has(key)) return null;
    const reserve = roundMoney(Math.min(Number(sizeUsd) || 0, this.balance));
    if (reserve < this.minNotional) { this.minNotionalRejections += 1; return null; }
    const order = {
      key, limitPrice: roundPrice(Number(limitPrice)), validUntil: Number(validUntil), reserve,
      stopPrice: roundPrice(Number(stopPrice)), plan, placedAt: this.currentTimestamp,
      slippagePct: slippagePct != null ? Number(slippagePct) : this.slippagePct,
    };
    this.balance = roundMoney(this.balance - reserve);
    this.reserved = roundMoney(this.reserved + reserve);
    this.pendingSatellite.set(key, order);
    this.satelliteStats.placed += 1;
    return { ...order };
  }

  hasPendingSatellite(key) { return this.pendingSatellite.has(key); }

  /** Cancels a resting satellite order and frees its cash. */
  cancelSatelliteOrder(key) {
    const order = this.pendingSatellite.get(key);
    if (!order) return false;
    this.pendingSatellite.delete(key);
    this.reserved = roundMoney(this.reserved - order.reserve);
    this.balance = roundMoney(this.balance + order.reserve);
    return true;
  }

  /**
   * One 15m bar for a satellite order or position. A resting limit fills at its price
   * in the first bar that trades down to it, and expires
   * at `validUntil`. In the fill bar only the stop is checked: the bar's high may have
   * come before the fill. After that, in order: the time limit (sell at the open), a
   * pending tier exit (sell at the open), the stop (at the stop, or the open on a gap),
   * the target (at the target, or the open on a gap up), the break-even step, and at
   * each hour's close the tier rule on that hour's RSI.
   * @param {string} key
   * @param {{timestamp:number, open:number, high:number, low:number, close:number}} bar
   * @param {{rsi?: number|null}} [ctx] — RSI of the 1h bar this 15m bar closes, if it closes one
   * @returns {object|null} a fill (side 'BUY', no exitTime), a closing trade, or null
   */
  replaySatelliteBar(key, bar, { rsi = null } = {}) {
    const t = Number(bar.timestamp);
    const open = Number(bar.open); const low = Number(bar.low); const high = Number(bar.high); const close = Number(bar.close);
    this.setTimestamp(t);
    const order = this.pendingSatellite.get(key);
    if (order) {
      if (t < order.placedAt) return null;
      if (t >= order.validUntil) {
        this.cancelSatelliteOrder(key);
        this.satelliteStats.expired += 1;
        return null;
      }
      if (!(low <= order.limitPrice)) return null;
      this.pendingSatellite.delete(key);
      this.reserved = roundMoney(this.reserved - order.reserve);
      this.balance = roundMoney(this.balance + order.reserve);
      // A resting buy fills at its own price: sellers crossing it take the bid there.
      const fill = order.limitPrice;
      const qty = roundQty(order.reserve / (fill * (1 + this.feePct)));
      const cost = roundMoney(qty * fill * (1 + this.feePct));
      if (qty <= 0 || cost > this.balance || !(fill > order.stopPrice)) return null;
      const position = {
        isSatellite: true, qty, entryPrice: fill, entryFillPrice: fill, entrySignalPrice: fill,
        entryFee: roundMoney(qty * fill * this.feePct), costBasis: cost,
        ...satellitePositionPlan({ fillPrice: fill, stopPrice: order.stopPrice, plan: order.plan, filledAt: t }),
        entryTime: t, fillBarTs: t, slippagePct: order.slippagePct,
        lastPrice: close, positionPct: null, partialExitDone: false,
      };
      this.balance = roundMoney(this.balance - cost);
      this.totalFees = roundMoney(this.totalFees + position.entryFee);
      this.positions.set(key, position);
      this.satelliteStats.filled += 1;
      // A bar that opens under the stop gaps through it: the exit is the open, not the stop.
      if (low <= position.stopLoss) return this.#closePosition(key, Math.min(position.stopLoss, open), 'sat_stop', { slippagePct: order.slippagePct });
      position.highWaterMark = Math.max(fill, close);
      return { ...position, symbol: key, side: 'BUY' };
    }

    const pos = this.positions.get(key);
    if (!pos?.isSatellite || t <= pos.fillBarTs) return null;
    // The shared exit rules (src/engine/satellites.js), as PaperTrader and LiveTrader run them.
    const exit = stepSatellitePosition(pos, { t, open, low, high, close, rsi, hourClosed: (t + M15_MS) % HOUR_MS === 0 });
    return exit ? this.#closePosition(key, exit.price, exit.reason, { slippagePct: pos.slippagePct }) : null;
  }

  /**
   * Replays one bar's price path through the stop logic, the way live's 2-minute
   * risk loop meets it: open, low, high, close (the stop before the target when a
   * bar touches both). A stop crossed inside the bar fills at the stop, a gap
   * through it fills at the open; a target fills at the target, or at the open on
   * a gap up. Returns the closing trade, or null.
   *
   * @param {string} symbol
   * @param {{timestamp:number, open:number, high:number, low:number, close:number}} bar
   */
  replayBar(symbol, bar) {
    const ticks = [Number(bar.open), Number(bar.low), Number(bar.high), Number(bar.close)];
    this.setTimestamp(Number(bar.timestamp));
    for (let k = 0; k < ticks.length; k++) {
      if (!this.positions.has(symbol)) return null;
      const price = roundPrice(ticks[k]);
      const exitFill = k === 0
        ? null
        : (reason, position) => (reason === 'take_profit' ? position.takeProfit : position.stopLoss);
      const result = this.#checkRisk(symbol, price, exitFill);
      if (result) return result;
    }
    return null;
  }

  /**
   * One equity point with every open position marked at its latest price.
   * @param {Record<string, number>} [prices] — symbol → price at this time
   */
  markEquity(prices = {}) {
    let open = 0;
    for (const [symbol, position] of this.positions) {
      const mark = Number(prices[symbol]);
      if (Number.isFinite(mark) && mark > 0) position.lastPrice = mark;
      open += position.qty * (position.lastPrice ?? position.entryPrice);
    }
    this.equityCurve.push({ timestamp: this.currentTimestamp, balance: roundMoney(this.balance + this.reserved + open) });
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
        ...(position.isCore && { isCore: true }),
        ...(position.isSatellite && { isSatellite: true }),
      })),
      ...(this.reserved > 0 && { reserved: roundMoney(this.reserved) }),
      totalPnL: roundMoney(this.totalPnL),
      totalFees: roundMoney(this.totalFees),
    };
  }

  // Live's order on every price tick (liveTrader.checkRisk): trailing, break-even,
  // partial exit, then the exit decision — through the same shared helpers.
  // exitFill: null = fill at the tick price; a function = the level the price
  // crossed on its way (replayBar), given the exit reason and the position.
  #checkRisk(symbol, currentPrice, exitFill = null) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }
    position.lastPrice = currentPrice;
    // TSM core positions exit only on the vote flip (closeCore), as live's checkRisk;
    // satellite positions only by their own plan (replaySatelliteBar).
    if (position.isCore || position.isSatellite) return null;

    this.checkAndUpdateTrailingStop(symbol, currentPrice);

    const be = calcBreakEven(this.#stopView(position), currentPrice, this.config.breakEvenTriggerPct);
    if (be.shouldTrigger) position.stopLoss = be.newStopLoss;

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

    const exit = calcExitSignal(position, currentPrice);
    if (exit.shouldExit) {
      const fill = exitFill ? exitFill(exit.reason, position) : currentPrice;
      return this.#closePosition(symbol, fill, exit.reason);
    }

    return null;
  }

  // Live's stop rules measure from its entryPrice, the market fill; the exchange
  // charges the fee separately. The simulator's entryPrice carries the fee too, which
  // put the break-even 0.3% above live's (LDO 2026-09-25 stopped at break-even in the
  // replay and took +12.7% live). The stop rules see the fill without the fee.
  #stopView(position) {
    return position.stopRefPrice != null ? { ...position, entryPrice: position.stopRefPrice } : position;
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
    let qty = roundQty(allocation / fillPrice);
    let cost = roundMoney(qty * fillPrice);
    // Under the floor but close to it: buy the floor (shared rule, off by default).
    const bumped = bumpToMinNotional(cost, { freeBalance: this.balance, minNotional: this.minNotional, bump: this.config.minNotionalBump });
    if (bumped > cost) {
      qty = roundQty(bumped / fillPrice);
      cost = roundMoney(qty * fillPrice);
      this.minNotionalBumps = (this.minNotionalBumps ?? 0) + 1;
    }

    // Exchange minimum notional — the same floor liveTrader enforces. Without it
    // the simulator fills orders Binance would reject outright, which silently
    // overstates trade count and diversification on small accounts (the effect is
    // nil at the $1000 research budget and severe near $200). Rejections are
    // counted, not swallowed, so a run can report how many it lost.
    if (cost < this.minNotional) {
      this.minNotionalRejections += 1;
      return null;
    }

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
      stopRefPrice: roundPrice(price * (1 + slip)),
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
      positionPct: pct,
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
      positionPct: position.positionPct,
    };

    this.trades.push(trade);
    return trade;
  }

  #recordEquitySnapshot(symbol, currentPrice) {
    if (!this.recordEquityOnExecute) return;
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

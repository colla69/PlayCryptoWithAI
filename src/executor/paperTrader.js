import '../types.js'; // JSDoc type definitions
import logger, { appendTrade } from '../utils/logger.js';
import { calcTrailingStop, calcBreakEven, calcExitSignal, calcATRStopPrices, calcPartialExit } from './traderUtils.js';

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

  /**
   * @param {string} symbol
   * @param {'BUY'|'SELL'|'HOLD'} decision
   * @param {number} currentPrice
   * @param {RiskConfig} [riskOverride]
   * @returns {TradeResult|null}
   */
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
          isCore: position.isCore === true,
        };
      }),
      totalPnL: roundMoney(this.totalPnL),
    };
  }

  /**
   * Mark an open position to market. Mirrors LiveTrader.markPrice so paper and
   * live value an open book the same way — see the note there. Paper needs it
   * more, not less: the fast risk loop is live-only, and #checkRisk is private
   * and only reached through execute(), so a paper core leg was never marked
   * after it opened.
   *
   * @returns {boolean} whether a position was marked
   */
  markPrice(symbol, price) {
    const position = this.positions.get(symbol);
    if (!position) return false;
    // Validate BEFORE rounding — this trader's roundPrice calls .toFixed()
    // directly and throws on undefined.
    const value = Number(price);
    if (!Number.isFinite(value) || value <= 0) return false;
    position.currentPrice = roundPrice(value);
    return true;
  }

  #checkRisk(symbol, currentPrice) {
    const position = this.positions.get(symbol);

    if (!position) {
      return null;
    }

    // TSM core positions exit ONLY on signal flip (closeCorePosition) — no
    // SL/TP, trailing, break-even, or two-stage exits. Track price and bail.
    if (position.isCore) {
      position.currentPrice = roundPrice(currentPrice);
      return null;
    }

    logger.debug(`[PAPER] ${symbol}: checkRisk price=${currentPrice.toFixed(8)} SL=${position.stopLoss.toFixed(8)} TP=${position.takeProfit.toFixed(8)} HWM=${position.highWaterMark.toFixed(8)} entry=${position.entryPrice.toFixed(8)}`);

    // Trailing stop update
    const trailing = calcTrailingStop(position, currentPrice);
    if (trailing.newHighWaterMark) position.highWaterMark = trailing.newHighWaterMark;
    if (trailing.shouldUpdate) {
      const prevSL = position.stopLoss;
      position.stopLoss = trailing.newStopLoss;
      logger.debug(`[PAPER] ${symbol}: trailing stop updated ${prevSL.toFixed(8)} → ${trailing.newStopLoss.toFixed(8)} (HWM=${position.highWaterMark.toFixed(8)})`);
    }

    // Track latest price for status reporting
    position.currentPrice = roundPrice(currentPrice);

    // Break-even stop
    const be = calcBreakEven(position, currentPrice, this.config.breakEvenTriggerPct);
    if (be.shouldTrigger) {
      position.stopLoss = be.newStopLoss;
      logger.info(`[PAPER] ${symbol}: break-even stop locked at ${position.stopLoss.toFixed(8)} (entry + fees)`);
    }

    // Two-stage exit (Phase 1) — partial profit taking at firstStagePctOfTp
    // of the way to TP. Forces break-even on the remainder so it's risk-free.
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
        if (position.stopLoss < position.entryPrice) {
          position.stopLoss = roundPrice(position.entryPrice * 1.002);
          logger.info(`[PAPER] ${symbol}: break-even locked on remainder after partial exit`);
        }
      }
    }

    // Exit signal evaluation
    const exit = calcExitSignal(position, currentPrice);
    if (exit.shouldExit) {
      logger.info(`[PAPER] ${symbol}: ${exit.reason} triggered price=${currentPrice.toFixed(8)} SL=${position.stopLoss.toFixed(8)}`);
      return this.#closePosition(symbol, currentPrice, exit.reason);
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
    const proceeds = roundMoney(closeQty * price);
    const portionEntryCost = roundMoney(closeQty * position.entryPrice);
    const pnl = roundMoney(proceeds - portionEntryCost);
    const timestamp = new Date().toISOString();

    this.balance = roundMoney(this.balance + proceeds);
    this.totalPnL = roundMoney(this.totalPnL + pnl);
    position.qty = roundQty(position.qty - closeQty);

    logger.info(`[PAPER] ${reason} ${symbol} closed ${(closeFrac * 100).toFixed(0)}% qty=${closeQty.toFixed(8)} price=${price.toFixed(8)} pnl=${pnl.toFixed(2)}`);
    appendTrade({
      timestamp,
      symbol,
      side: 'SELL',
      price,
      qty: closeQty,
      pnl,
      balance: this.balance,
      note: 'partial_exit',
    });
    return { symbol, qty: closeQty, price, pnl, partial: true };
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

    logger.debug(`[PAPER] ${symbol}: sizing balance=${this.balance.toFixed(2)} maxPositionPct=${risk.maxPositionPct.toFixed(4)} allocation=${allocation.toFixed(2)} qty=${qty.toFixed(8)} cost=${cost.toFixed(2)}`);

    // ── ATR-based stops (Phase 1) ─────────────────────────────────────────
    // When risk.atrStops.enabled AND riskOverride.atrPct is provided, derive
    // SL/TP from ATR. Falls back to fixed percent stops otherwise. Keeps
    // behaviour-compat for callers that don't pass atrPct.
    let derivedSL = null;
    let derivedTP = null;
    const atrStops = risk.atrStops;
    if (atrStops?.enabled && Number.isFinite(risk.atrPct) && risk.atrPct > 0) {
      const atrPrices = calcATRStopPrices({
        fillPrice: price,
        atrPct: risk.atrPct,
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
        logger.debug(`[PAPER] ${symbol}: ATR stops SL=${derivedSL.toFixed(8)} (${(atrPrices.slPct*100).toFixed(1)}%) TP=${derivedTP.toFixed(8)} (${(atrPrices.tpPct*100).toFixed(1)}%) atrPct=${(risk.atrPct*100).toFixed(2)}%`);
      }
    }

    const initialStopLoss = derivedSL ?? roundPrice(price * (1 - risk.stopLossPct));
    const takeProfitPrice = derivedTP ?? roundPrice(price * (1 + risk.takeProfitPct));
    const timestamp = new Date().toISOString();
    const position = {
      qty,
      entryPrice: price,
      initialStopLoss,
      stopLoss: initialStopLoss,
      takeProfit: takeProfitPrice,
      highWaterMark: price,
      trailingStopPct: risk.trailingStopPct,
      openedAt: timestamp,
      partialExitDone: false,
    };

    this.balance = roundMoney(this.balance - cost);
    this.positions.set(symbol, position);

    logger.info(
      `[PAPER] BUY ${symbol} qty=${qty.toFixed(8)} price=${price.toFixed(8)} balance=${this.balance.toFixed(2)}`,
    );
    logger.debug(`[PAPER] ${symbol}: position opened SL=${position.stopLoss.toFixed(8)} TP=${position.takeProfit.toFixed(8)} trailingPct=${risk.trailingStopPct ?? 'off'}`);

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

  /**
   * Open a TSM core sleeve position: fixed USD allocation, no SL/TP — the only
   * exit is closeCorePosition() on a momentum-vote flip. `symbol` is the core
   * key ('BTC/USDC#core') so scalper positions on the same market coexist.
   *
   * @param {string} symbol core position key
   * @param {number} currentPrice
   * @param {number} allocationUsd sleeve allocation for this symbol
   * @returns {TradeResult|null}
   */
  openCorePosition(symbol, currentPrice, allocationUsd) {
    if (this.positions.has(symbol)) {
      logger.info(`[PAPER] ${symbol}: core BUY skipped, existing position open`);
      return null;
    }

    const price = roundPrice(currentPrice);
    const allocation = roundMoney(Math.min(Number(allocationUsd) || 0, this.balance));
    const qty = roundQty(allocation / price);
    const cost = roundMoney(qty * price);

    if (qty <= 0 || cost > this.balance || cost < 10) {
      logger.warn(`[PAPER] ${symbol}: core BUY skipped, allocation ${allocation.toFixed(2)} invalid (balance=${this.balance.toFixed(2)})`);
      return null;
    }

    const timestamp = new Date().toISOString();
    const position = {
      qty,
      entryPrice: price,
      initialStopLoss: 0,
      stopLoss: 0,
      takeProfit: 0,
      highWaterMark: price,
      trailingStopPct: undefined,
      openedAt: timestamp,
      partialExitDone: false,
      isCore: true,
    };

    this.balance = roundMoney(this.balance - cost);
    this.positions.set(symbol, position);

    logger.info(`[PAPER] CORE BUY ${symbol} qty=${qty.toFixed(8)} price=${price.toFixed(8)} alloc=${cost.toFixed(2)} balance=${this.balance.toFixed(2)}`);

    appendTrade({
      timestamp,
      symbol,
      side: 'BUY',
      price,
      qty,
      pnl: 0,
      balance: this.balance,
      note: '🧲 tsm-core',
      isCore: true,
    });

    return {
      ...position,
      symbol,
      side: 'BUY',
      timestamp,
      balance: this.balance,
      note: '🧲 tsm-core',
    };
  }

  /**
   * Close a TSM core position on a momentum-vote flip.
   * @param {string} symbol core position key ('BTC/USDC#core')
   * @param {number} currentPrice
   * @returns {TradeResult|null}
   */
  closeCorePosition(symbol, currentPrice) {
    return this.#closePosition(symbol, roundPrice(currentPrice), 'tsm_core_flip', '🧲 tsm-core');
  }

  /**
   * Partially resize a HELD core position toward its vol/macro target
   * (positive delta buys more, negative trims). Trade records carry the
   * post-resize position state (positionQty / positionEntryPrice) so restarts
   * restore correctly — a resize SELL does NOT mean the position closed.
   *
   * @param {string} symbol core position key ('BTC/USDC#core')
   * @param {number} currentPrice
   * @param {number} deltaUsd signed notional to trade
   * @returns {TradeResult|null}
   */
  resizeCorePosition(symbol, currentPrice, deltaUsd) {
    const position = this.positions.get(symbol);
    if (!position?.isCore) return null;
    const price = roundPrice(currentPrice);
    const delta = Number(deltaUsd) || 0;
    const timestamp = new Date().toISOString();

    if (delta > 0) {
      const spend = roundMoney(Math.min(delta, this.balance));
      if (spend < 10) {
        logger.info(`[PAPER] ${symbol}: core resize BUY skipped (${spend.toFixed(2)} below $10 min)`);
        return null;
      }
      const addQty = roundQty(spend / price);
      const newQty = roundQty(position.qty + addQty);
      // Blended entry keeps realised PnL correct on later trims/closes
      position.entryPrice = roundPrice((position.entryPrice * position.qty + spend) / newQty);
      position.qty = newQty;
      position.currentPrice = price;
      this.balance = roundMoney(this.balance - spend);
      logger.info(`[PAPER] CORE RESIZE +${spend.toFixed(2)} ${symbol} qty=${newQty.toFixed(8)} entry→${position.entryPrice.toFixed(8)} balance=${this.balance.toFixed(2)}`);
      const record = {
        timestamp, symbol, side: 'BUY', price, qty: addQty, pnl: 0, balance: this.balance,
        note: '🧲 tsm-core', isCore: true, reason: 'tsm_core_resize',
        positionQty: position.qty, positionEntryPrice: position.entryPrice,
      };
      appendTrade(record);
      return { ...record, openedAt: position.openedAt };
    }

    if (delta < 0) {
      const sellQty = roundQty(Math.min(-delta / price, position.qty));
      const proceeds = roundMoney(sellQty * price);
      if (proceeds < 10) {
        logger.info(`[PAPER] ${symbol}: core resize SELL skipped (${proceeds.toFixed(2)} below $10 min)`);
        return null;
      }
      if (sellQty >= position.qty) {
        // Never let a resize silently liquidate — full exits are the vote's job
        return this.closeCorePosition(symbol, price);
      }
      const pnl = roundMoney((price - position.entryPrice) * sellQty);
      position.qty = roundQty(position.qty - sellQty);
      position.currentPrice = price;
      this.balance = roundMoney(this.balance + proceeds);
      this.totalPnL = roundMoney(this.totalPnL + pnl);
      logger.info(`[PAPER] CORE RESIZE -${proceeds.toFixed(2)} ${symbol} qty=${position.qty.toFixed(8)} pnl=${pnl.toFixed(2)} balance=${this.balance.toFixed(2)}`);
      const record = {
        timestamp, symbol, side: 'SELL', price, qty: sellQty, pnl, balance: this.balance,
        note: '🧲 tsm-core', isCore: true, reason: 'tsm_core_resize',
        positionQty: position.qty, positionEntryPrice: position.entryPrice,
      };
      appendTrade(record);
      return { ...record, openedAt: position.openedAt };
    }

    return null;
  }

  #closePosition(symbol, price, reason, note) {
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
    const pnlPct = position.entryPrice > 0 ? ((price - position.entryPrice) / position.entryPrice * 100).toFixed(2) : '0.00';
    const durationMs = Date.now() - (position.openedAt ? new Date(position.openedAt).getTime() : Date.now());
    const durationHrs = (durationMs / 3_600_000).toFixed(1);

    this.balance = roundMoney(this.balance + proceeds);
    this.totalPnL = roundMoney(this.totalPnL + pnl);
    this.positions.delete(symbol);

    logger.info(
      `[PAPER] SELL ${symbol} qty=${position.qty.toFixed(8)} price=${price.toFixed(8)} pnl=${pnl.toFixed(2)} pnl%=${pnlPct}% reason=${reason} held=${durationHrs}h balance=${this.balance.toFixed(2)}`,
    );
    logger.debug(`[PAPER] ${symbol}: closed entry=${position.entryPrice.toFixed(8)} exit=${price.toFixed(8)} HWM=${position.highWaterMark.toFixed(8)} initialSL=${position.initialStopLoss.toFixed(8)} finalSL=${position.stopLoss.toFixed(8)}`);

    const timestamp = new Date().toISOString();

    appendTrade({
      timestamp,
      symbol,
      side: 'SELL',
      price,
      qty: position.qty,
      pnl,
      balance: this.balance,
      ...(note ? { note } : {}),
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
      ...(note ? { note } : {}),
    };
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

    // Core resize records carry the POST-resize position state — prefer it
    // over the traded amount so restarts rebuild the true position.
    const entryPrice = Number(trade.positionEntryPrice ?? trade.entryPrice ?? trade.price ?? 0);
    if (entryPrice <= 0) return;

    this.positions.set(symbol, {
      qty:             Number(trade.positionQty ?? trade.qty ?? 0),
      entryPrice,
      initialStopLoss: Number(trade.initialStopLoss ?? trade.stopLoss ?? 0),
      stopLoss:        Number(trade.stopLoss ?? trade.initialStopLoss ?? 0),
      takeProfit:      Number(trade.takeProfit ?? 0),
      highWaterMark:   Number(trade.highWaterMark ?? entryPrice),
      trailingStopPct: Number.isFinite(Number(trade.trailingStopPct)) ? Number(trade.trailingStopPct) : undefined,
      openedAt:        trade.openedAt ?? trade.timestamp ?? new Date().toISOString(),
      currentPrice:    entryPrice,
      // Core positions must survive restarts with their flag intact, or SL/TP
      // management would adopt them (stopLoss 0 → instant nonsense exits).
      isCore:          trade.isCore === true || String(symbol).endsWith('#core'),
    });

    logger.info(
      `[PAPER] Restored position: ${symbol} qty=${trade.qty} entryPrice=${entryPrice} stopLoss=${trade.stopLoss ?? trade.initialStopLoss ?? 0}`,
    );
  }
}

export default PaperTrader;

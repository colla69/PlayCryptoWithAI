import '../types.js'; // JSDoc type definitions
import fs from 'fs';
import path from 'path';
import { createOrder, fetchBalance, fetchOpenOrders, fetchTicker, amountToPrecision, getMarketLimits } from '../exchange/binanceClient.js';
import { FALLBACK_MIN_NOTIONAL as SHARED_MIN_NOTIONAL } from '../exchange/exchangeLimits.js';
import logger, { appendTrade } from '../utils/logger.js';
import { calcTrailingStop, calcBreakEven, calcExitSignal, calcATRStopPrices, calcPartialExit, calcCoreClaims } from './traderUtils.js';

// Minimum notional for new BUY orders — must clear Binance's $10 minimum with buffer
// Re-exported from the shared module so the backtester enforces the identical
// floor — see src/exchange/exchangeLimits.js.
const FALLBACK_MIN_NOTIONAL = SHARED_MIN_NOTIONAL;
// Minimum notional to recognise an existing balance as an open position on restore
// Lower than the order minimum because fees reduce the holding slightly below entry cost
const MIN_RESTORE_NOTIONAL = 5;
const roundMoney = (value) => Number(Number(value ?? 0).toFixed(2));
const roundPrice = (value) => Number(Number(value ?? 0).toFixed(8));
const roundQty = (value) => Number(Number(value ?? 0).toFixed(8));

const POSITION_STATE_FILE = path.join(process.cwd(), 'data', 'position_state.json');

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

  /**
   * @param {string} symbol
   * @param {'BUY'|'SELL'|'HOLD'} decision
   * @param {number} currentPrice
   * @param {RiskConfig} [riskOverride]
   * @returns {Promise<TradeResult|null>}
   */
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

      // TSM core positions exit ONLY on the momentum-vote flip — no SL/TP,
      // trailing, break-even, or two-stage exits. Track price and bail.
      if (position.isCore) {
        position.currentPrice = roundPrice(currentPrice);
        return null;
      }

      logger.debug(`[LIVE] ${symbol}: checkRisk price=${currentPrice.toFixed(8)} SL=${position.stopLoss.toFixed(8)} TP=${position.takeProfit.toFixed(8)} HWM=${position.highWaterMark.toFixed(8)} entry=${position.entryPrice.toFixed(8)}`);

      // Trailing stop update
      const trailing = calcTrailingStop(position, currentPrice);
      if (trailing.newHighWaterMark) position.highWaterMark = trailing.newHighWaterMark;
      if (trailing.shouldUpdate) {
        const prevSL = position.stopLoss;
        position.stopLoss = trailing.newStopLoss;
        logger.debug(`[LIVE] ${symbol}: trailing stop updated ${prevSL.toFixed(8)} → ${trailing.newStopLoss.toFixed(8)} (HWM=${position.highWaterMark.toFixed(8)})`);
        this.#savePositionState();
      }

      // Break-even stop
      const be = calcBreakEven(position, currentPrice, this.config.breakEvenTriggerPct);
      if (be.shouldTrigger) {
        position.stopLoss = be.newStopLoss;
        logger.info(`[LIVE] ${symbol}: break-even stop locked at ${position.stopLoss.toFixed(8)} (entry + fees)`);
        this.#savePositionState();
      }

      // Two-stage exit (Phase 1) — partial profit taking
      const twoStage = this.config.twoStageExit;
      if (twoStage?.enabled && !position.partialExitDone) {
        const partial = calcPartialExit(
          position,
          currentPrice,
          Number(twoStage.firstStagePctOfTp ?? 0.5),
          Number(twoStage.firstStageFraction ?? 0.5),
        );
        if (partial.shouldExit) {
          try {
            await this.#partialClose(symbol, currentPrice, 'partial_exit', partial.fraction);
            position.partialExitDone = true;
            if (position.stopLoss < position.entryPrice) {
              position.stopLoss = roundPrice(position.entryPrice * 1.002);
              logger.info(`[LIVE] ${symbol}: break-even locked on remainder after partial exit`);
            }
            this.#savePositionState();
          } catch (err) {
            logger.error(`[LIVE] ${symbol}: partial_exit failed - ${this.#formatError(err)}`);
          }
        }
      }

      // Exit signal evaluation
      const exit = calcExitSignal(position, currentPrice);
      if (exit.shouldExit) {
        logger.info(`[LIVE] ${symbol}: ${exit.reason} triggered price=${currentPrice.toFixed(8)} SL=${position.stopLoss.toFixed(8)}`);
        return this.#closePosition(symbol, currentPrice, exit.reason);
      }

      return null;
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: risk check failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  #positionRows() {
    return Array.from(this.positions.entries()).map(([symbol, position]) => ({
      symbol,
      qty: roundQty(position.qty),
      entryPrice: roundPrice(position.entryPrice),
      currentPrice: roundPrice(position.currentPrice ?? position.entryPrice),
      stopLoss: roundPrice(position.stopLoss),
      takeProfit: roundPrice(position.takeProfit),
      highWaterMark: roundPrice(position.highWaterMark),
      openedAt: position.openedAt,
      isCore: position.isCore === true,
    }));
  }

  async getStatus() {
    try {
      const quoteBalance = await this.#fetchQuoteBalance();
      return {
        balance: quoteBalance,
        positions: this.#positionRows(),
        totalPnL: roundMoney(this.totalPnL),
      };
    } catch (error) {
      logger.error(`[LIVE] status fetch failed - ${this.#formatError(error)}`);
      return {
        balance: 0,
        positions: this.#positionRows(),
        totalPnL: roundMoney(this.totalPnL),
      };
    }
  }

  async restorePositionsFromExchange(symbols, fetchTickerFn, getRiskForSymbol, tradeHistory = [], onSyntheticTrade = null) {
    let restored = 0;
    const savedState = LiveTrader.loadPositionState();
    try {
      const balance = await fetchBalance();
      const freeQuote = Number(balance.free?.[this.quoteCurrency] ?? balance.total?.[this.quoteCurrency] ?? 0);

      // ── TSM core positions first ──────────────────────────────────────────
      // The wallet asset is fungible: free BTC may back BOTH a core and a
      // scalper position. calcCoreClaims reserves what every core leg owns —
      // persisted AND already live in memory — so the scalper restore below can
      // only attribute what is genuinely left over. Reserving the in-memory legs
      // matters most: they never enter the restore loop, and omitting them let
      // the scalper claim the sleeve's own coins as a phantom position.
      const {
        claimsByBase: coreClaimedByBase,
        restorable: coreRestorable,
        dropped: coreDropped,
      } = calcCoreClaims({
        savedState,
        livePositions: this.positions,
        freeBalances: balance.free ?? {},
      });

      for (const { key, reason } of coreDropped) {
        logger.warn(`[LIVE] ${key}: core entry in position state has ${reason} — dropped (not claiming wallet coins)`);
      }

      for (const { key, market, base, savedQty, entryPrice, saved } of coreRestorable) {
        try {
          const freeBase = Number(balance.free?.[base] ?? 0);
          // Clamp to what the wallet actually holds (manual sells shrink it)
          const qty = roundQty(Math.min(savedQty, freeBase));
          const ticker = await fetchTickerFn(market);
          const currentPrice = roundPrice(Number(ticker?.last ?? ticker?.close ?? 0));
          if (qty <= 0 || !(currentPrice > 0) || qty * currentPrice < MIN_RESTORE_NOTIONAL) {
            logger.warn(`[LIVE] ${key}: core position in saved state but wallet holds too little (${qty} ${base}) — dropped`);
            continue;
          }

          this.positions.set(key, {
            qty,
            entryPrice,
            currentPrice,
            initialStopLoss: 0,
            stopLoss: 0,
            takeProfit: 0,
            highWaterMark: currentPrice,
            trailingStopPct: undefined,
            openedAt: saved.openedAt ?? new Date().toISOString(),
            partialExitDone: false,
            isCore: true,
          });
          restored++;
          logger.info(`[LIVE] Restored CORE position: ${key} qty=${qty} entry=${entryPrice} notional=$${(qty * currentPrice).toFixed(2)} (no SL/TP — momentum-flip exit)`);
        } catch (coreErr) {
          logger.warn(`[LIVE] core restore skipped ${key} - ${coreErr.message}`);
        }
      }

      for (const symbol of symbols) {
        try {
          // Skip symbols already tracked in memory
          if (this.positions.has(symbol)) continue;

          const base = symbol.split('/')[0];
          // Core legs already claimed part of this asset — don't double-count
          const qty = roundQty(Number(balance.free?.[base] ?? 0) - (coreClaimedByBase.get(base) ?? 0));
          if (qty <= 0) continue;

          // Fetch current price
          const ticker = await fetchTickerFn(symbol);
          const currentPrice = roundPrice(Number(ticker?.last ?? ticker?.close ?? 0));
          if (!currentPrice || currentPrice <= 0) continue;

          const notional = qty * currentPrice;
          if (notional < MIN_RESTORE_NOTIONAL) continue;

          // Find entry price from trade history: walk newest-first
          // Stop at first SELL (no open position) or first BUY (entry price found)
          let entryPrice = currentPrice; // fallback
          let entryTime = null;
          let foundEntry = false;

          // If position_state.json knows this symbol, it's been tracked before — use that
          const saved = savedState[symbol];
          if (saved && saved.entryPrice > 0) {
            entryPrice = roundPrice(saved.entryPrice);
            entryTime = saved.openedAt ?? null;
            foundEntry = true;
          } else {
            for (let i = 0; i < tradeHistory.length; i++) {
              const t = tradeHistory[i];
              if (t.symbol !== symbol) continue;
              if (t.side === 'SELL') break;
              if (t.side === 'BUY') {
                entryPrice = roundPrice(Number(t.price ?? currentPrice));
                entryTime = t.openedAt ?? t.timestamp ?? null;
                foundEntry = true;
                break;
              }
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
            entryTime: entryTime ? new Date(entryTime).getTime() : (savedState[symbol]?.openedAt ? new Date(savedState[symbol].openedAt).getTime() : Date.now()),
            // Internal fields expected by checkRisk / trailing stop
            initialStopLoss: roundPrice(entryPrice * (1 - stopLossPct)),
            highWaterMark: roundPrice(currentPrice),
            trailingStopPct: Number.isFinite(this.config.trailingStopPct) && this.config.trailingStopPct > 0
              ? this.config.trailingStopPct
              : undefined,
            openedAt: savedState[symbol]?.openedAt ?? entryTime ?? new Date().toISOString(),
          };

          // Re-apply break-even and trailing stop from persisted state or heuristic.
          if (saved && saved.stopLoss > 0) {
            position.stopLoss = roundPrice(saved.stopLoss);
            if (saved.highWaterMark > position.highWaterMark) {
              position.highWaterMark = roundPrice(saved.highWaterMark);
            }
            if (saved.breakEvenLocked && position.stopLoss < position.entryPrice) {
              position.stopLoss = roundPrice(position.entryPrice * 1.002);
            }
            logger.info(`[LIVE] ${symbol}: restored persisted stop=${position.stopLoss.toFixed(8)} HWM=${position.highWaterMark.toFixed(8)}${saved.breakEvenLocked ? ' (BE)' : ''}`);
          }

          // If stop is still below entry, only auto-lock BE when we can directly
          // observe the position is already at/above the BE level on the live ticker.
          // The previous heuristic (scan past 4h candles for highs ≥ BE) was unsafe
          // for positions with no real entry timestamp: it could find a historical
          // high from days/weeks before the position was opened and set SL above
          // entry, causing an immediate stop_loss on the next tick (observed June 1
          // 2026: SUI restored 4 times, stopped out 3 times within 26 minutes).
          // Without persisted state and without current price already above BE, we
          // start with the plain initial SL; normal calcBreakEven in the live loop
          // will lock BE the first time price genuinely reaches that level.
          if (
            breakEvenTriggerPct > 0
            && position.stopLoss < position.entryPrice
            && currentPrice >= entryPrice * (1 + breakEvenTriggerPct)
          ) {
            position.stopLoss = roundPrice(entryPrice * 1.002);
            logger.info(`[LIVE] ${symbol}: BE lock applied — current price ${currentPrice.toFixed(8)} ≥ BE level ${(entryPrice * (1 + breakEvenTriggerPct)).toFixed(8)}, stop set to ${position.stopLoss.toFixed(8)}`);
          }

          // Trailing stop (if enabled and price is above entry)
          if (position.stopLoss < position.entryPrice && position.trailingStopPct && currentPrice > entryPrice) {
            const trailStop = roundPrice(currentPrice * (1 - position.trailingStopPct));
            if (trailStop > position.stopLoss) {
              position.stopLoss = trailStop;
            }
          }

          this.positions.set(symbol, position);
          restored++;
          const protNote = position.stopLoss > position.initialStopLoss
            ? ` SL=${position.stopLoss.toFixed(6)} (BE/trail re-applied)`
            : ` SL=${position.stopLoss.toFixed(6)}`;
          logger.info(`[LIVE] Restored position from exchange: ${symbol} qty=${qty} entry=${entryPrice} notional=$${notional.toFixed(2)}${protNote}${foundEntry ? '' : ' (no history — synthetic BUY recorded)'}`);

          // If no matching BUY exists in the trade log, synthesise one so the
          // dashboard P&L, win-rate, and open-position panel are all consistent.
          if (!foundEntry && typeof onSyntheticTrade === 'function') {
            const synthetic = {
              timestamp: new Date().toISOString(),
              symbol,
              side: 'BUY',
              price: entryPrice,
              qty: roundQty(qty),
              pnl: 0,
              balance: roundMoney(freeQuote),
              note: '🔄 restored-from-exchange',
            };
            try {
              onSyntheticTrade(synthetic);
            } catch (cbErr) {
              logger.warn(`[LIVE] ${symbol}: synthetic trade callback failed — ${cbErr.message}`);
            }
          }
        } catch (symErr) {
          logger.warn(`[LIVE] restorePositionsFromExchange: skipped ${symbol} - ${symErr.message}`);
        }
      }
    } catch (err) {
      logger.error(`[LIVE] restorePositionsFromExchange failed: ${err.message}`);
    }
    // Immediately persist restored state so it's saved even before next risk check
    if (restored > 0) this.#savePositionState();
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

  /**
   * Open a TSM core sleeve position with a fixed USD allocation (real market
   * order). `symbol` is the core key ('BTC/USDC#core'); orders go to the
   * underlying market. No SL/TP — the only exit is closeCorePosition on a
   * momentum-vote flip; sizing drifts via resizeCorePosition.
   */
  async openCorePosition(symbol, referencePrice, allocationUsd) {
    try {
      if (this.positions.has(symbol)) {
        logger.info(`[LIVE] ${symbol}: core BUY skipped, existing position open`);
        return null;
      }
      const market = symbol.split('#')[0];
      const price = roundPrice(referencePrice);
      if (!Number.isFinite(price) || price <= 0) return null;

      const balance = await fetchBalance();
      const freeQuote = Number(balance.free?.[this.quoteCurrency] ?? 0);
      const allocation = roundMoney(Math.min(Number(allocationUsd) || 0, freeQuote));

      const rawQty = allocation / price;
      const qty = await amountToPrecision(market, rawQty).catch(() => roundQty(rawQty));
      const notional = roundMoney(qty * price);

      let minQty = 0;
      let minNotional = FALLBACK_MIN_NOTIONAL;
      try {
        const limits = await getMarketLimits(market);
        minQty = limits.minQty ?? 0;
        minNotional = Math.max(limits.minNotional ?? 0, FALLBACK_MIN_NOTIONAL);
      } catch {
        // Use fallback values — don't abort the trade on a limits-fetch failure
      }

      if (qty <= 0 || qty < minQty || notional < minNotional) {
        logger.warn(`[LIVE] ${symbol}: core BUY skipped, allocation ${allocation.toFixed(2)} → qty ${qty} below exchange minimums (minQty=${minQty}, minNotional=${minNotional})`);
        return null;
      }

      const order = await createOrder(market, 'market', 'buy', qty);
      const entryPrice = await this.#resolveTradePrice(order, market, price);
      const reportedQty = Number(order.filled ?? order.amount ?? qty);
      const filledQty = roundQty(reportedQty > 0 ? reportedQty : qty);
      const timestamp = new Date().toISOString();

      const position = {
        qty: filledQty,
        entryPrice,
        currentPrice: entryPrice,
        initialStopLoss: 0,
        stopLoss: 0,
        takeProfit: 0,
        highWaterMark: entryPrice,
        orderId: order.id,
        side: 'buy',
        trailingStopPct: undefined,
        openedAt: timestamp,
        partialExitDone: false,
        isCore: true,
      };
      this.positions.set(symbol, position);
      this.#savePositionState();
      const balanceAfter = await this.#fetchQuoteBalance();

      logger.info(`[LIVE] CORE BUY ${symbol} qty=${filledQty.toFixed(8)} price=${entryPrice.toFixed(8)} alloc=${notional.toFixed(2)} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`);
      appendTrade({
        timestamp, symbol, side: 'BUY', price: entryPrice, qty: filledQty, pnl: 0,
        balance: balanceAfter, note: '🧲 tsm-core', isCore: true,
      });
      return {
        symbol, side: 'BUY', qty: filledQty, entryPrice, price: entryPrice,
        orderId: order.id, timestamp, balance: balanceAfter, openedAt: timestamp,
        note: '🧲 tsm-core', isCore: true,
      };
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: core BUY failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  /** Close a TSM core position on a momentum-vote flip (real market sell). */
  async closeCorePosition(symbol, referencePrice) {
    return this.#closePosition(symbol, roundPrice(referencePrice), 'tsm_core_flip', '🧲 tsm-core');
  }

  /**
   * Partially resize a held core position toward its vol/macro target.
   * Positive delta buys more (blended entry), negative trims (realises PnL).
   * Trade records carry post-resize state (positionQty/positionEntryPrice).
   */
  async resizeCorePosition(symbol, referencePrice, deltaUsd) {
    try {
      const position = this.positions.get(symbol);
      if (!position?.isCore) return null;
      const market = symbol.split('#')[0];
      const price = roundPrice(referencePrice);
      if (!Number.isFinite(price) || price <= 0) return null;
      const delta = Number(deltaUsd) || 0;
      const timestamp = new Date().toISOString();

      if (delta > 0) {
        const balance = await fetchBalance();
        const freeQuote = Number(balance.free?.[this.quoteCurrency] ?? 0);
        const spend = roundMoney(Math.min(delta, freeQuote));
        const rawQty = spend / price;
        const qty = await amountToPrecision(market, rawQty).catch(() => roundQty(rawQty));
        if (qty <= 0 || qty * price < FALLBACK_MIN_NOTIONAL) {
          logger.info(`[LIVE] ${symbol}: core resize BUY skipped (${spend.toFixed(2)} below minimums)`);
          return null;
        }
        const order = await createOrder(market, 'market', 'buy', qty);
        const fillPrice = await this.#resolveTradePrice(order, market, price);
        const reported = Number(order.filled ?? order.amount ?? qty);
        const addQty = roundQty(reported > 0 ? reported : qty);
        const newQty = roundQty(position.qty + addQty);
        position.entryPrice = roundPrice((position.entryPrice * position.qty + fillPrice * addQty) / newQty);
        position.qty = newQty;
        position.currentPrice = fillPrice;
        this.#savePositionState();
        const balanceAfter = await this.#fetchQuoteBalance();
        logger.info(`[LIVE] CORE RESIZE +$${(addQty * fillPrice).toFixed(2)} ${symbol} qty=${newQty.toFixed(8)} entry→${position.entryPrice.toFixed(8)} orderId=${order.id ?? 'n/a'}`);
        const record = {
          timestamp, symbol, side: 'BUY', price: fillPrice, qty: addQty, pnl: 0,
          balance: balanceAfter, note: '🧲 tsm-core', isCore: true, reason: 'tsm_core_resize',
          positionQty: position.qty, positionEntryPrice: position.entryPrice,
        };
        appendTrade(record);
        return { ...record, openedAt: position.openedAt };
      }

      if (delta < 0) {
        // Trim toward target; never below zero, never more than the wallet holds
        const base = market.split('/')[0];
        let sellQty = Math.min(-delta / price, position.qty);
        try {
          const bal = await fetchBalance();
          const freeBase = Number(bal.free?.[base] ?? 0);
          sellQty = Math.min(sellQty, freeBase);
        } catch {
          // fall back to computed qty
        }
        sellQty = await amountToPrecision(market, sellQty).catch(() => roundQty(sellQty));
        if (sellQty <= 0 || sellQty * price < FALLBACK_MIN_NOTIONAL) {
          logger.info(`[LIVE] ${symbol}: core resize SELL skipped (below minimums)`);
          return null;
        }
        if (sellQty >= position.qty) {
          // Never let a resize silently liquidate — full exits are the vote's job
          return this.closeCorePosition(symbol, price);
        }
        const order = await createOrder(market, 'market', 'sell', sellQty);
        const fillPrice = await this.#resolveTradePrice(order, market, price);
        // Deduct what actually filled, not what we asked for — a partial fill
        // must not desync the tracked qty from the wallet.
        const reportedSold = Number(order.filled ?? order.amount ?? sellQty);
        const actualSold = roundQty(reportedSold > 0 ? Math.min(reportedSold, position.qty) : sellQty);
        const pnl = roundMoney((fillPrice - position.entryPrice) * actualSold);
        position.qty = roundQty(position.qty - actualSold);
        position.currentPrice = fillPrice;
        this.totalPnL = roundMoney(this.totalPnL + pnl);
        this.#savePositionState();
        const balanceAfter = await this.#fetchQuoteBalance();
        logger.info(`[LIVE] CORE RESIZE -$${(actualSold * fillPrice).toFixed(2)} ${symbol} qty=${position.qty.toFixed(8)} pnl=${pnl.toFixed(2)} orderId=${order.id ?? 'n/a'}`);
        const record = {
          timestamp, symbol, side: 'SELL', price: fillPrice, qty: actualSold, pnl,
          balance: balanceAfter, note: '🧲 tsm-core', isCore: true, reason: 'tsm_core_resize',
          positionQty: position.qty, positionEntryPrice: position.entryPrice,
        };
        appendTrade(record);
        return { ...record, openedAt: position.openedAt };
      }
      return null;
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: core resize failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  async #openPosition(symbol, referencePrice, riskOverride) {
    try {
      if (this.positions.has(symbol)) {
        logger.info(`[LIVE] ${symbol}: BUY skipped, existing position open`);
        return null;
      }

      // Core sleeve positions have their own capital budget (deploymentPct)
      // and must not consume the scalper's concurrent-position slots.
      const scalperCount = [...this.positions.values()].filter((p) => !p.isCore).length;
      if (scalperCount >= this.config.maxOpenPositions) {
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

      if (allocation <= 0) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, insufficient balance`);
        return null;
      }

      // Apply exchange lot-size step precision before any checks
      const rawQty = allocation / referencePrice;
      const qty = await amountToPrecision(symbol, rawQty).catch(() => roundQty(rawQty));
      const notional = roundMoney(qty * referencePrice);

      // Fetch exchange-enforced limits (minQty, minNotional) — fall back to safe defaults
      let minQty = 0;
      let minNotional = FALLBACK_MIN_NOTIONAL;
      try {
        const limits = await getMarketLimits(symbol);
        minQty = limits.minQty ?? 0;
        minNotional = Math.max(limits.minNotional ?? 0, FALLBACK_MIN_NOTIONAL);
      } catch {
        // Use fallback values — don't abort the trade on a limits-fetch failure
      }

      logger.debug(`[LIVE] ${symbol}: sizing balance=${freeQuote.toFixed(2)} maxPositionPct=${risk.maxPositionPct.toFixed(4)} allocation=${allocation.toFixed(2)} rawQty=${rawQty.toFixed(8)} qty=${qty} notional=${notional.toFixed(2)} minNotional=${minNotional} minQty=${minQty}`);

      if (qty <= 0 || qty < minQty) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, qty ${qty} below exchange minQty ${minQty}`);
        return null;
      }

      if (notional < minNotional) {
        logger.warn(`[LIVE] ${symbol}: BUY skipped, notional ${notional.toFixed(2)} below minimum ${minNotional.toFixed(2)} ${this.quoteCurrency}`);
        return null;
      }

      const order = await createOrder(symbol, 'market', 'buy', qty);
      logger.debug(`[LIVE] ${symbol}: BUY order response id=${order.id ?? 'n/a'} status=${order.status ?? 'n/a'} filled=${order.filled ?? 'n/a'} avg=${order.average ?? order.price ?? 'n/a'}`);
      const entryPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
      const reportedQty = Number(order.filled ?? order.amount ?? qty);
      const filledQty = roundQty(reportedQty > 0 ? reportedQty : qty);

      // ── ATR-based stops (Phase 1) ─────────────────────────────────────────
      let derivedSL = null;
      let derivedTP = null;
      const atrStops = risk.atrStops;
      if (atrStops?.enabled && Number.isFinite(risk.atrPct) && risk.atrPct > 0) {
        const atrPrices = calcATRStopPrices({
          fillPrice: entryPrice,
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
          logger.debug(`[LIVE] ${symbol}: ATR stops SL=${derivedSL.toFixed(8)} (${(atrPrices.slPct*100).toFixed(1)}%) TP=${derivedTP.toFixed(8)} (${(atrPrices.tpPct*100).toFixed(1)}%) atrPct=${(risk.atrPct*100).toFixed(2)}%`);
        }
      }

      const initialStopLoss = derivedSL ?? roundPrice(entryPrice * (1 - risk.stopLossPct));
      const takeProfit      = derivedTP ?? roundPrice(entryPrice * (1 + risk.takeProfitPct));
      const trailingStopPct = Number.isFinite(risk.trailingStopPct) && risk.trailingStopPct > 0
        ? risk.trailingStopPct
        : undefined;
      const timestamp = new Date().toISOString();
      const position = {
        qty: filledQty,
        entryPrice,
        initialStopLoss,
        stopLoss: initialStopLoss,
        takeProfit,
        highWaterMark: entryPrice,
        orderId: order.id,
        side: 'buy',
        trailingStopPct,
        openedAt: timestamp,
        partialExitDone: false,
      };

      this.positions.set(symbol, position);
      this.#savePositionState();
      const balanceAfter = await this.#fetchQuoteBalance();

      logger.info(
        `[LIVE] BUY ${symbol} qty=${filledQty.toFixed(8)} price=${entryPrice.toFixed(8)} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
      );
      logger.debug(`[LIVE] ${symbol}: position opened SL=${position.stopLoss.toFixed(8)} TP=${position.takeProfit.toFixed(8)} trailingPct=${trailingStopPct ?? 'off'}`);

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
        orderId: order.id,
        timestamp,
        balance: balanceAfter,
        openedAt: timestamp,
      };
    } catch (error) {
      logger.error(`[LIVE] ${symbol}: BUY failed - ${this.#formatError(error)}`);
      return null;
    }
  }

  async #partialClose(symbol, referencePrice, reason, fraction) {
    const position = this.positions.get(symbol);
    if (!position) return null;
    const closeFrac = Math.min(Math.max(Number(fraction) || 0, 0), 1);
    if (closeFrac <= 0 || closeFrac >= 1) return null;
    let sellQty = roundQty(position.qty * closeFrac);
    if (sellQty <= 0 || sellQty >= position.qty) return null;

    // Apply Binance lot-size step truncation and check minimum notional
    const base = symbol.split('/')[0];
    try {
      const bal = await fetchBalance();
      const freeBase = Number(bal.free?.[base] ?? bal.total?.[base] ?? 0);
      if (freeBase > 0) {
        const maxSellable = await amountToPrecision(symbol, Math.min(freeBase, sellQty));
        if (maxSellable < sellQty) sellQty = maxSellable;
      }
    } catch { /* fall back to computed qty */ }
    if (sellQty <= 0) return null;
    if (sellQty * referencePrice < FALLBACK_MIN_NOTIONAL) {
      logger.info(`[LIVE] ${symbol}: ${reason} skipped, notional ${(sellQty * referencePrice).toFixed(2)} below $${FALLBACK_MIN_NOTIONAL} minimum`);
      return null;
    }

    const order = await createOrder(symbol, 'market', 'sell', sellQty);
    const exitPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
    const proceeds = roundMoney(sellQty * exitPrice);
    const portionEntryCost = roundMoney(sellQty * position.entryPrice);
    const pnl = roundMoney(proceeds - portionEntryCost);
    const timestamp = new Date().toISOString();
    const balanceAfter = await this.#fetchQuoteBalance();

    this.totalPnL = roundMoney(this.totalPnL + pnl);
    position.qty = roundQty(position.qty - sellQty);

    logger.info(
      `[LIVE] ${reason} ${symbol} closed ${(closeFrac * 100).toFixed(0)}% qty=${sellQty.toFixed(8)} price=${exitPrice.toFixed(8)} pnl=${pnl.toFixed(2)} balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
    );

    appendTrade({
      timestamp,
      symbol,
      side: 'SELL',
      price: exitPrice,
      qty: sellQty,
      pnl,
      balance: balanceAfter,
      note: 'partial_exit',
    });

    return { symbol, qty: sellQty, price: exitPrice, pnl, partial: true };
  }

  async #closePosition(symbol, referencePrice, reason, note = null) {
    try {
      const position = this.positions.get(symbol);

      if (!position) {
        if (reason === 'strategy_sell') {
          logger.info(`[LIVE] ${symbol}: SELL skipped, no open position`);
        }
        return null;
      }

      // Core positions are keyed '<market>#core' — exchange calls use the market.
      const market = symbol.split('#')[0];

      const durationMs = Date.now() - (position.openedAt ? new Date(position.openedAt).getTime() : Date.now());
      const durationHrs = (durationMs / 3_600_000).toFixed(1);
      logger.debug(`[LIVE] ${symbol}: closing position reason=${reason} entry=${position.entryPrice.toFixed(8)} refPrice=${referencePrice.toFixed(8)} qty=${position.qty.toFixed(8)} held=${durationHrs}h HWM=${position.highWaterMark.toFixed(8)}`);

      // Use the actual free balance and apply Binance's lot-size step truncation.
      // Never sell MORE than this position's qty: the wallet asset is fungible
      // and may back a coexisting core/scalper position on the same market.
      const base = market.split('/')[0];
      let sellQty = position.qty;
      try {
        const bal = await fetchBalance();
        const freeBase = Number(bal.free?.[base] ?? bal.total?.[base] ?? 0);
        if (freeBase > 0) {
          const maxSellable = await amountToPrecision(market, Math.min(freeBase, sellQty));
          const dust = roundQty(Math.min(freeBase, sellQty) - maxSellable);
          if (dust > 0) {
            logger.info(`[LIVE] ${symbol}: dust after step-size truncation: ${dust} ${base} (≈ ${(dust * referencePrice).toFixed(4)} ${this.quoteCurrency})`);
          }
          if (maxSellable < sellQty) {
            logger.info(`[LIVE] ${symbol}: adjusting sell qty ${sellQty.toFixed(8)} → ${maxSellable.toFixed(8)}`);
            sellQty = maxSellable;
          }
        }
      } catch {
        // fetchBalance/amountToPrecision failed — fall back to stored qty
      }

      const order = await createOrder(market, 'market', 'sell', sellQty);
      logger.debug(`[LIVE] ${symbol}: SELL order response id=${order.id ?? 'n/a'} status=${order.status ?? 'n/a'} filled=${order.filled ?? 'n/a'} avg=${order.average ?? order.price ?? 'n/a'}`);
      const exitPrice = await this.#resolveTradePrice(order, market, referencePrice);
      const proceeds = roundMoney(sellQty * exitPrice);
      const costBasis = roundMoney(position.qty * position.entryPrice);
      const pnl = roundMoney(proceeds - costBasis);
      const pnlPct = position.entryPrice > 0 ? ((exitPrice - position.entryPrice) / position.entryPrice * 100).toFixed(2) : '0.00';
      const timestamp = new Date().toISOString();
      const balanceAfter = await this.#fetchQuoteBalance();

      this.totalPnL = roundMoney(this.totalPnL + pnl);
      this.positions.delete(symbol);
      this.#savePositionState();

      logger.info(
        `[LIVE] SELL ${symbol} qty=${sellQty.toFixed(8)} price=${exitPrice.toFixed(8)} pnl=${pnl.toFixed(2)} pnl%=${pnlPct}% reason=${reason} held=${durationHrs}h balance=${balanceAfter.toFixed(2)} orderId=${order.id ?? 'n/a'}`,
      );

      appendTrade({
        timestamp,
        symbol,
        side: 'SELL',
        price: exitPrice,
        qty: sellQty,
        pnl,
        balance: balanceAfter,
        ...(note ? { note } : {}),
        ...(position.isCore ? { isCore: true } : {}),
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
        ...(note ? { note } : {}),
        ...(position.isCore ? { isCore: true } : {}),
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

  #formatError(error) {
    return error instanceof Error ? error.message : String(error);
  }

  /** Persist current position stop-loss/HWM state to disk (atomic write). */
  #savePositionState() {
    try {
      const state = {};
      for (const [symbol, pos] of this.positions) {
        state[symbol] = {
          stopLoss: pos.stopLoss,
          highWaterMark: pos.highWaterMark,
          initialStopLoss: pos.initialStopLoss,
          entryPrice: pos.entryPrice,
          openedAt: pos.openedAt,
          breakEvenLocked: pos.stopLoss >= pos.entryPrice,
          // Core sleeve positions restore from this state (qty is required —
          // the wallet balance alone can't attribute coins between the core
          // and scalper legs of the same market).
          qty: pos.qty,
          isCore: pos.isCore === true,
        };
      }
      const json = JSON.stringify(state, null, 2);
      // Atomic write: tmp → rename prevents corruption on crash
      const tmpFile = POSITION_STATE_FILE + '.tmp';
      fs.writeFileSync(tmpFile, json);
      fs.renameSync(tmpFile, POSITION_STATE_FILE);
      // Also write a backup so we have redundancy
      fs.writeFileSync(POSITION_STATE_FILE + '.bak', json);
    } catch (e) {
      logger.debug(`[LIVE] position state save failed: ${e.message}`);
    }
  }

  /** Load persisted position state (stop-loss levels that survive restarts). */
  static loadPositionState() {
    // Try primary file first, then backup if primary is corrupt/missing
    for (const file of [POSITION_STATE_FILE, POSITION_STATE_FILE + '.bak']) {
      try {
        if (!fs.existsSync(file)) continue;
        const content = fs.readFileSync(file, 'utf8').trim();
        if (!content || content === '{}') continue;
        const parsed = JSON.parse(content);
        if (Object.keys(parsed).length > 0) return parsed;
      } catch {
        // try next file
      }
    }
    return {};
  }
}

export default LiveTrader;

import '../types.js'; // JSDoc type definitions
import fs from 'fs';
import path from 'path';
import { createOrder, fetchBalance, fetchOpenOrders, fetchTicker, fetchOHLCV, amountToPrecision, getMarketLimits } from '../exchange/binanceClient.js';
import logger, { appendTrade } from '../utils/logger.js';
import { calcTrailingStop, calcBreakEven, calcExitSignal } from './traderUtils.js';

// Minimum notional for new BUY orders — must clear Binance's $10 minimum with buffer
const FALLBACK_MIN_NOTIONAL = 11;
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

  async restorePositionsFromExchange(symbols, fetchTickerFn, getRiskForSymbol, tradeHistory = [], onSyntheticTrade = null) {
    let restored = 0;
    const savedState = LiveTrader.loadPositionState();
    try {
      const balance = await fetchBalance();
      const freeQuote = Number(balance.free?.[this.quoteCurrency] ?? balance.total?.[this.quoteCurrency] ?? 0);

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
          if (notional < MIN_RESTORE_NOTIONAL) continue;

          // Find entry price from trade history: walk newest-first
          // Stop at first SELL (no open position) or first BUY (entry price found)
          let entryPrice = currentPrice; // fallback
          let entryTime = null;
          let foundEntry = false;
          for (let i = 0; i < tradeHistory.length; i++) {
            const t = tradeHistory[i];
            if (t.symbol !== symbol) continue;
            if (t.side === 'SELL') break; // a SELL before BUY means no open position from history
            if (t.side === 'BUY') {
              entryPrice = roundPrice(Number(t.price ?? currentPrice));
              entryTime = t.openedAt ?? t.timestamp ?? null;
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
          const saved = savedState[symbol];
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

          // If stop is still below entry, verify with candle data whether BE should be locked.
          // This catches: (a) no persisted state, (b) stale file with pre-BE stop, (c) corrupt data.
          if (breakEvenTriggerPct > 0 && position.stopLoss < position.entryPrice) {
            const beLevel = entryPrice * (1 + breakEvenTriggerPct);
            let beLocked = false;
            if (currentPrice >= beLevel) {
              beLocked = true;
            } else {
              try {
                const openedAtMs = position.entryTime;
                const posAgeMs = openedAtMs ? Date.now() - openedAtMs : 7 * 24 * 3600_000;
                const candleCount = Math.min(500, Math.max(42, Math.ceil(posAgeMs / (4 * 3600_000))));
                const candles = await fetchOHLCV(symbol, '4h', candleCount);
                if (candles && candles.length > 0) {
                  for (const c of candles) {
                    // Only consider candles after the trade was opened
                    if (openedAtMs && c.timestamp < openedAtMs) continue;
                    if (c.high >= beLevel) {
                      beLocked = true;
                      break;
                    }
                  }
                }
                if (!beLocked) {
                  logger.debug(`[LIVE] ${symbol}: ${candles?.length ?? 0} candles checked, none reached BE level ${beLevel.toFixed(6)}`);
                }
              } catch (candleErr) {
                logger.warn(`[LIVE] ${symbol}: candle BE check failed — ${candleErr.message}`);
              }
            }
            if (beLocked) {
              position.stopLoss = roundPrice(entryPrice * 1.002);
              logger.info(`[LIVE] ${symbol}: BE lock confirmed from market data — stop set to ${position.stopLoss.toFixed(8)}`);
            }
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

      const durationMs = Date.now() - (position.openedAt ? new Date(position.openedAt).getTime() : Date.now());
      const durationHrs = (durationMs / 3_600_000).toFixed(1);
      logger.debug(`[LIVE] ${symbol}: closing position reason=${reason} entry=${position.entryPrice.toFixed(8)} refPrice=${referencePrice.toFixed(8)} qty=${position.qty.toFixed(8)} held=${durationHrs}h HWM=${position.highWaterMark.toFixed(8)}`);

      // Use the actual free balance and apply Binance's lot-size step truncation.
      const base = symbol.split('/')[0];
      let sellQty = position.qty;
      try {
        const bal = await fetchBalance();
        const freeBase = Number(bal.free?.[base] ?? bal.total?.[base] ?? 0);
        if (freeBase > 0) {
          const maxSellable = await amountToPrecision(symbol, freeBase);
          const dust = roundQty(freeBase - maxSellable);
          if (dust > 0) {
            logger.info(`[LIVE] ${symbol}: dust after step-size truncation: ${dust} ${base} (≈ ${(dust * referencePrice).toFixed(4)} ${this.quoteCurrency})`);
          }
          if (maxSellable < sellQty || freeBase < sellQty) {
            logger.info(`[LIVE] ${symbol}: adjusting sell qty ${sellQty.toFixed(8)} → ${maxSellable.toFixed(8)}`);
            sellQty = maxSellable;
          }
        }
      } catch {
        // fetchBalance/amountToPrecision failed — fall back to stored qty
      }

      const order = await createOrder(symbol, 'market', 'sell', sellQty);
      logger.debug(`[LIVE] ${symbol}: SELL order response id=${order.id ?? 'n/a'} status=${order.status ?? 'n/a'} filled=${order.filled ?? 'n/a'} avg=${order.average ?? order.price ?? 'n/a'}`);
      const exitPrice = await this.#resolveTradePrice(order, symbol, referencePrice);
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

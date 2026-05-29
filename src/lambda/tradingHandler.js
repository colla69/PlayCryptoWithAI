/**
 * AWS Lambda handler for the trading bot.
 * Triggered every 15 minutes by EventBridge.
 *
 * Flow:
 * 1. Load positions state from S3
 * 2. Fetch candles for all symbols from Binance
 * 3. Run signal aggregator
 * 4. Execute trades (with OCO exit orders on Binance)
 * 5. Save updated state to S3
 */
import 'dotenv/config';
import config from '../../config/default.js';
import { fetchOHLCV, fetchTicker } from '../exchange/binanceClient.js';
import { placeOcoExit } from '../exchange/ocoOrders.js';
import SignalAggregator from '../engine/signalAggregator.js';
import { LiveTrader } from '../executor/liveTrader.js';
import RiskManager from '../risk/index.js';
import { stateStore } from '../state/index.js';
import { isMarketTrending, computeATRPct, calculateADX } from '../utils/indicators.js';
import { mtfAlignScore, mtf4hMomentumScore } from '../utils/mtfAlignment.js';
import { buildCorrelationMatrix } from '../utils/correlation.js';
import {
  buildStrategiesForSymbol,
  getRiskForSymbol,
  getSignalConfigForSymbol,
  buildSignalReasons,
} from '../utils/strategyBuilder.js';

const quoteCurrency = (config.symbols[0] ?? 'BTC/USDC').split('/')[1] ?? 'USDC';

export async function handler(event) {
  const startTime = Date.now();
  console.log(`[Lambda] Trading cycle started at ${new Date().toISOString()}`);

  try {
    // 1. Load persisted state
    const savedPositions = await stateStore.load('positions') ?? [];
    const tradeHistory = await stateStore.load('trades') ?? [];

    // 2. Initialise trader with restored positions
    const trader = new LiveTrader({ ...config.risk, quoteCurrency });
    for (const pos of savedPositions) {
      trader.positions.set(pos.symbol, pos);
    }

    const riskManager = new RiskManager(config.risk);

    // Rebuild daily stats from today's trades
    const today = new Date().toISOString().slice(0, 10);
    for (const t of tradeHistory.filter(t => t.timestamp?.startsWith(today) && t.side === 'SELL')) {
      riskManager.recordTrade(t.pnl ?? 0);
    }

    // 3. Fetch candles for all symbols
    const candleCache = {};
    const candle4hCache = {};

    await Promise.all(config.symbols.map(async (sym) => {
      try {
        candleCache[sym] = await fetchOHLCV(sym, '15m', 100);
        if (config.mtf4hFilter?.enabled) {
          candle4hCache[sym] = await fetchOHLCV(sym, '4h', 30);
        }
      } catch (err) {
        console.error(`[Lambda] Failed to fetch candles for ${sym}: ${err.message}`);
      }
    }));

    // 4. Build correlation matrix
    const correlationMatrix = buildCorrelationMatrix(
      config.symbols,
      (sym) => candleCache[sym] ?? [],
      config.correlation
    );

    // 5. Run signal evaluation and trade execution for each symbol
    const results = [];

    for (const symbol of config.symbols) {
      try {
        const candles = candleCache[symbol];
        if (!candles || candles.length < 50) continue;

        const currentPrice = candles[candles.length - 1].close;
        const symRisk = getRiskForSymbol(symbol, config);
        const signalConf = getSignalConfigForSymbol(symbol, config.signals);
        const strategies = buildStrategiesForSymbol(symbol);
        const aggregator = new SignalAggregator(strategies, signalConf);

        const result = aggregator.evaluate(candles);

        // Check risk manager (daily loss limit, etc.)
        const tradeCheck = riskManager.canTrade(result, currentPrice);

        // Skip if already at max positions and this is a BUY
        if (result.decision === 'BUY' && trader.positions.size >= config.risk.maxOpenPositions) {
          console.log(`[Lambda] ${symbol}: BUY blocked — max positions (${config.risk.maxOpenPositions})`);
          continue;
        }

        // Correlation filter
        if (result.decision === 'BUY' && config.correlation?.enabled) {
          const openSymbols = [...trader.positions.keys()];
          const blocked = openSymbols.some(open => {
            const corr = correlationMatrix[symbol]?.[open] ?? 0;
            return corr >= (config.correlation.threshold ?? 0.75);
          });
          if (blocked) {
            console.log(`[Lambda] ${symbol}: BUY blocked — correlated with open position`);
            continue;
          }
        }

        // 4h momentum filter
        if (result.decision === 'BUY' && config.mtf4hFilter?.enabled) {
          const candles4h = candle4hCache[symbol];
          if (candles4h && candles4h.length >= 21) {
            const score = mtf4hMomentumScore(candles4h, candles4h.length - 2);
            if (score < (config.mtf4hFilter.threshold ?? 0.45)) {
              console.log(`[Lambda] ${symbol}: BUY blocked — 4h momentum ${score.toFixed(2)} < threshold`);
              continue;
            }
          }
        }

        // Regime-aware sizing
        let positionPct = symRisk.maxPositionPct ?? config.risk.maxPositionPct;
        if (config.regimeSizing?.enabled && result.decision === 'BUY') {
          const recentCandles = candles.slice(-50);
          const adx = calculateADX(recentCandles, 14);
          if (adx >= 25) positionPct *= config.regimeSizing.trendMultiplier ?? 1.3;
          else if (adx < 15) positionPct *= config.regimeSizing.chopMultiplier ?? 0.5;
        }

        if (!tradeCheck.allowed) {
          console.log(`[Lambda] ${symbol}: trade blocked — ${tradeCheck.reason}`);
          continue;
        }

        // Check existing position risk (SL/TP)
        if (trader.positions.has(symbol)) {
          const riskResult = await trader.checkRisk(symbol, currentPrice);
          if (riskResult) {
            results.push(riskResult);
            console.log(`[Lambda] ${symbol}: ${riskResult.side} (${riskResult.reason ?? 'risk'}) pnl=${riskResult.pnl?.toFixed(2)}`);
          }
          continue;
        }

        // Execute trade
        if (result.decision === 'BUY') {
          const effectiveRisk = { ...symRisk, maxPositionPct: positionPct };
          const tradeResult = await trader.execute(symbol, 'BUY', currentPrice, effectiveRisk);

          if (tradeResult) {
            results.push(tradeResult);
            console.log(`[Lambda] ${symbol}: BUY @ ${currentPrice.toFixed(4)} conf=${(result.confidence * 100).toFixed(0)}%`);

            // Place OCO exit order (SL + TP on Binance server-side)
            try {
              await placeOcoExit(symbol, tradeResult.qty, tradeResult.entryPrice, symRisk);
              console.log(`[Lambda] ${symbol}: OCO exit placed — SL=${tradeResult.stopLoss.toFixed(4)} TP=${tradeResult.takeProfit.toFixed(4)}`);
            } catch (err) {
              console.error(`[Lambda] ${symbol}: OCO placement failed — ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[Lambda] ${symbol}: cycle error — ${err.message}`);
      }
    }

    // 6. Check if any OCO orders were filled (positions closed by exchange)
    await syncExchangeFilledOrders(trader, tradeHistory);

    // 7. Persist state
    const positionsToSave = [...trader.positions.entries()].map(([symbol, pos]) => ({
      symbol, ...pos,
    }));
    await stateStore.save('positions', positionsToSave);

    // Append new trades
    for (const r of results.filter(r => r.side)) {
      tradeHistory.push({
        timestamp: r.timestamp ?? new Date().toISOString(),
        symbol: r.symbol,
        side: r.side,
        price: r.entryPrice ?? r.exitPrice ?? r.price,
        qty: r.qty,
        pnl: r.pnl ?? 0,
        balance: r.balance ?? 0,
        reason: r.reason,
      });
    }
    await stateStore.save('trades', tradeHistory);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[Lambda] Cycle complete: ${results.length} actions, ${trader.positions.size} open positions, ${elapsed}s`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        actions: results.length,
        openPositions: trader.positions.size,
        elapsed: `${elapsed}s`,
      }),
    };
  } catch (err) {
    console.error(`[Lambda] Fatal error: ${err.message}`, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}

/**
 * Check Binance for filled OCO orders that closed positions while Lambda was sleeping.
 * Updates trader state and appends trades to history.
 */
async function syncExchangeFilledOrders(trader, tradeHistory) {
  for (const [symbol, position] of trader.positions) {
    try {
      const ticker = await fetchTicker(symbol);
      const price = ticker?.last ?? ticker?.close;
      if (!price) continue;

      // If price has passed SL or TP, the OCO should have filled on-exchange.
      // Remove position from our state (the exchange already sold).
      if (price <= position.stopLoss || price >= position.takeProfit) {
        const exitPrice = price;
        const pnl = (exitPrice - position.entryPrice) * position.qty;
        const reason = price <= position.stopLoss ? 'stop_loss_oco' : 'take_profit_oco';

        trader.positions.delete(symbol);
        tradeHistory.push({
          timestamp: new Date().toISOString(),
          symbol,
          side: 'SELL',
          price: exitPrice,
          qty: position.qty,
          pnl,
          reason,
        });
        console.log(`[Lambda] ${symbol}: OCO filled (${reason}) pnl=${pnl.toFixed(2)}`);
      }
    } catch (err) {
      console.error(`[Lambda] ${symbol}: sync check failed — ${err.message}`);
    }
  }
}

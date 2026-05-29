/**
 * OCO (One-Cancels-the-Other) order placement for Binance.
 * Places a combined stop-loss + take-profit order so the exchange
 * monitors exits 24/7 — no need for the bot to stay running.
 *
 * Binance OCO order:
 * - Limit sell at take-profit price
 * - Stop-limit sell at stop-loss price (with small buffer for stop-limit gap)
 * When one fills, the other is automatically cancelled.
 */
import { amountToPrecision, fetchOpenOrders, cancelOrder } from './binanceClient.js';
import ccxt from 'ccxt';

// Re-use the ccxt client from binanceClient (same credentials)
const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_API_SECRET;
const testnetMode = process.env.BINANCE_TESTNET === 'true';

const client = new ccxt.binance({
  apiKey,
  secret,
  enableRateLimit: true,
  timeout: 15000,
  options: { defaultType: 'spot' },
});

if (testnetMode) {
  client.urls.api.public  = 'https://testnet.binance.vision/api/v3';
  client.urls.api.private = 'https://testnet.binance.vision/api/v3';
  client.urls.api.v1      = 'https://testnet.binance.vision/api/v1';
}

/**
 * Place an OCO exit order (take-profit limit + stop-loss stop-limit).
 *
 * @param {string} symbol - e.g. 'BTC/USDC'
 * @param {number} qty - quantity to sell
 * @param {number} entryPrice - entry price for computing SL/TP levels
 * @param {object} risk - { stopLossPct, takeProfitPct }
 * @returns {object} OCO order response from Binance
 */
export async function placeOcoExit(symbol, qty, entryPrice, risk) {
  await client.loadMarkets();

  const takeProfitPrice = entryPrice * (1 + risk.takeProfitPct);
  const stopLossPrice = entryPrice * (1 - risk.stopLossPct);
  // Stop-limit price slightly below stop trigger to ensure fill
  const stopLimitPrice = stopLossPrice * 0.998;

  // Round prices to exchange precision
  const market = client.markets[symbol];
  if (!market) throw new Error(`Market ${symbol} not found`);

  const preciseQty = await amountToPrecision(symbol, qty);
  const preciseTP = Number(client.priceToPrecision(symbol, takeProfitPrice));
  const preciseSL = Number(client.priceToPrecision(symbol, stopLossPrice));
  const preciseSLLimit = Number(client.priceToPrecision(symbol, stopLimitPrice));

  // Use Binance's native OCO endpoint via ccxt
  // ccxt doesn't have a direct OCO method, so we use the private API
  const binanceSymbol = symbol.replace('/', '');

  const params = {
    symbol: binanceSymbol,
    side: 'SELL',
    quantity: preciseQty,
    price: preciseTP,            // Limit price (take-profit)
    stopPrice: preciseSL,        // Stop trigger price
    stopLimitPrice: preciseSLLimit, // Stop-limit execution price
    stopLimitTimeInForce: 'GTC',
  };

  const response = await client.privatePostOrderOco(params);

  return {
    orderId: response.orderListId,
    symbol,
    qty: preciseQty,
    takeProfit: preciseTP,
    stopLoss: preciseSL,
    stopLimitPrice: preciseSLLimit,
    status: response.listOrderStatus,
  };
}

/**
 * Cancel any existing OCO orders for a symbol.
 * Used when the bot needs to update exit levels (e.g., trailing stop adjustment).
 */
export async function cancelOcoOrders(symbol) {
  const openOrders = await fetchOpenOrders(symbol);
  const cancelled = [];

  for (const order of openOrders) {
    try {
      await cancelOrder(order.id, symbol);
      cancelled.push(order.id);
    } catch (err) {
      // Order may have already filled — ignore
      if (!err.message?.includes('Unknown order')) {
        throw err;
      }
    }
  }

  return cancelled;
}

/**
 * Update OCO levels (cancel existing + place new).
 * Useful for trailing stop adjustment every 15 minutes.
 */
export async function updateOcoExit(symbol, qty, newEntryPrice, risk) {
  await cancelOcoOrders(symbol);
  return placeOcoExit(symbol, qty, newEntryPrice, risk);
}

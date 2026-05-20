import signalBus from './signalBus.js';
import logger from '../utils/logger.js';

export function startCopyTrading(config = {}) {
  const {
    leaderApiKey,
    leaderApiSecret,
    testnet = false,
    symbols = [],
    intervalMs = 30_000,
    sizeRatio = 1.0,
  } = config;

  if (!leaderApiKey || !leaderApiSecret) {
    logger.warn('Copy trading leader API keys not set — copy trading disabled');
    return null;
  }

  const lastTradeIds = new Map();

  async function fetchLeaderTrades(symbol) {
    const { createHmac } = await import('crypto');
    const binanceSymbol = symbol.replace('/', '');
    const timestamp = Date.now();
    const query = `symbol=${binanceSymbol}&limit=10&timestamp=${timestamp}`;
    const signature = createHmac('sha256', leaderApiSecret).update(query).digest('hex');
    const baseUrl = testnet ? 'https://testnet.binance.vision' : 'https://api.binance.com';
    const url = `${baseUrl}/api/v3/myTrades?${query}&signature=${signature}`;

    const response = await fetch(url, {
      headers: { 'X-MBX-APIKEY': leaderApiKey },
    });

    if (!response.ok) {
      throw new Error(`Binance API ${response.status}: ${await response.text()}`);
    }

    return response.json();
  }

  async function checkLeaderTrades() {
    for (const symbol of symbols) {
      try {
        const trades = await fetchLeaderTrades(symbol);
        if (!Array.isArray(trades) || trades.length === 0) {
          continue;
        }

        const sorted = [...trades].sort((left, right) => right.id - left.id);
        const newest = sorted[0];
        const lastId = lastTradeIds.get(symbol);

        if (lastId === undefined) {
          lastTradeIds.set(symbol, newest.id);
          logger.info(`CopyTrade: initialized for ${symbol}, last trade id=${newest.id}`);
          continue;
        }

        if (newest.id <= lastId) {
          continue;
        }

        const newTrades = sorted.filter((trade) => trade.id > lastId);
        lastTradeIds.set(symbol, newest.id);

        for (const trade of newTrades.reverse()) {
          const side = trade.isBuyer ? 'BUY' : 'SELL';
          const payload = {
            symbol,
            signal: side,
            source: 'copy_trade',
            confidence: 0.85,
            reason: `Leader ${side} ${parseFloat(trade.qty).toFixed(6)} @ ${parseFloat(trade.price).toFixed(2)} (copy ratio: ${sizeRatio})`,
            timestamp: Date.now(),
            meta: { leaderQty: trade.qty, price: trade.price, sizeRatio },
          };
          signalBus.emit('signal', payload);
          logger.info(`${symbol}: CopyTrade leader ${side} detected → emitting signal`);
        }
      } catch (error) {
        logger.error(`CopyTrade check failed for ${symbol}: ${error.message}`);
      }
    }
  }

  void checkLeaderTrades();
  const interval = setInterval(() => void checkLeaderTrades(), intervalMs);
  logger.info(`Copy trading started, watching ${symbols.join(', ')} every ${intervalMs / 1000}s`);
  return { interval, stop: () => clearInterval(interval) };
}

export default startCopyTrading;

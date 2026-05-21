import 'dotenv/config';
import ccxt from 'ccxt';
import logger from '../utils/logger.js';

const apiKey = process.env.BINANCE_API_KEY;
const secret = process.env.BINANCE_API_SECRET;
export const paperMode = process.env.PAPER_MODE === 'true' || !apiKey || !secret;
export const testnetMode = process.env.BINANCE_TESTNET === 'true';

const client = new ccxt.binance({
  apiKey: paperMode ? undefined : apiKey,
  secret: paperMode ? undefined : secret,
  enableRateLimit: true,
  timeout: 15000,
  options: {
    defaultType: 'spot',
    createMarketBuyOrderRequiresPrice: false,
  },
});

/**
 * Retries an async function up to `maxAttempts` times on network/timeout errors.
 * Only retries on transient failures (timeout, network error, 5xx).
 * Does NOT retry on auth errors, rate-limits, or order-related calls.
 *
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number, baseDelayMs?: number, label?: string }} opts
 * @returns {Promise<T>}
 */
async function withRetry(fn, { maxAttempts = 3, baseDelayMs = 1000, label = 'request' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = String(err?.message ?? err);
      const isTransient = msg.includes('timed out') || msg.includes('ECONNRESET') ||
                          msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') ||
                          msg.includes('socket hang up') || msg.includes('EAI_AGAIN') ||
                          (err?.httpCode >= 500 && err?.httpCode < 600);
      if (!isTransient || attempt === maxAttempts) throw err;
      const delay = baseDelayMs * attempt;
      logger.warn(`[exchange] ${label} timed out (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

if (testnetMode) {
  // Override all URL groups so no request accidentally hits real Binance with testnet keys
  client.urls.api.public  = 'https://testnet.binance.vision/api/v3';
  client.urls.api.private = 'https://testnet.binance.vision/api/v3';
  client.urls.api.v1      = 'https://testnet.binance.vision/api/v1';
}

let marketsPromise;

async function loadTestnetMarkets() {
  // Testnet has no sapi endpoints — ccxt's loadMarkets() calls sapi/capital/config/getall
  // which rejects testnet keys. Instead, build the market map manually from publicGetExchangeInfo.
  const info = await client.publicGetExchangeInfo();
  const markets = {};
  const marketsById = {};
  for (const s of info.symbols ?? []) {
    if (s.status !== 'TRADING') continue;
    const symbol = `${s.baseAsset}/${s.quoteAsset}`;
    const lotFilter = s.filters?.find((f) => f.filterType === 'LOT_SIZE') ?? {};
    const priceFilter = s.filters?.find((f) => f.filterType === 'PRICE_FILTER') ?? {};
    const m = {
      id: s.symbol, symbol,
      base: s.baseAsset, quote: s.quoteAsset,
      baseId: s.baseAsset, quoteId: s.quoteAsset,
      active: true, type: 'spot', spot: true,
      precision: {
        amount: parseInt(s.baseAssetPrecision),
        price: parseInt(s.quotePrecision),
      },
      limits: {
        amount: { min: parseFloat(lotFilter.minQty ?? 0), max: parseFloat(lotFilter.maxQty ?? 0) },
        price:  { min: parseFloat(priceFilter.minPrice ?? 0), max: parseFloat(priceFilter.maxPrice ?? 0) },
      },
      info: s,
    };
    markets[symbol] = m;
    marketsById[s.symbol] = m;
  }
  client.markets = markets;
  client.marketsById = marketsById;
  client.symbols = Object.keys(markets);
  return markets;
}

async function ensureMarketsLoaded() {
  if (!marketsPromise) {
    marketsPromise = (testnetMode ? loadTestnetMarkets() : client.loadMarkets())
      .catch((error) => {
        marketsPromise = null;
        throw error;
      });
  }
  return marketsPromise;
}

export async function fetchOHLCV(symbol, timeframe, limit = 100) {
  await ensureMarketsLoaded();
  const candles = await withRetry(
    () => client.fetchOHLCV(symbol, timeframe, undefined, limit),
    { label: `fetchOHLCV(${symbol})` },
  );

  return candles.map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
    volume: Number(volume),
  }));
}

// Milliseconds per timeframe string
const TF_MS = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000,
  '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000, '3d': 259_200_000,
  '1w': 604_800_000,
};

/**
 * Fetches up to `totalCandles` historical OHLCV candles by paginating backwards
 * in batches of 1000 (Binance's per-request maximum).
 * Returns candles sorted oldest → newest, deduplicated.
 */
export async function fetchHistoricalOHLCV(symbol, timeframe, totalCandles = 2250) {
  await ensureMarketsLoaded();

  const msPerCandle = TF_MS[timeframe] ?? 3_600_000;
  const batchSize   = 1000;
  const allRaw      = [];

  // Start `since` far enough back to cover the full requested history
  let since = Date.now() - totalCandles * msPerCandle;

  while (allRaw.length < totalCandles) {
    const batch = await withRetry(
        () => client.fetchOHLCV(symbol, timeframe, since, batchSize),
        { label: `fetchHistoricalOHLCV(${symbol})` },
      );
    if (!batch.length) break;

    allRaw.push(...batch);
    const lastTs = batch.at(-1)[0];
    since = lastTs + msPerCandle;

    // Reached present — no need for another page
    if (batch.length < batchSize) break;

    // Safety: avoid hammering the API
    await new Promise((r) => setTimeout(r, 300));
  }

  // Deduplicate by timestamp and sort oldest → newest
  const seen  = new Set();
  const clean = allRaw.filter(([ts]) => {
    if (seen.has(ts)) return false;
    seen.add(ts);
    return true;
  });
  clean.sort((a, b) => a[0] - b[0]);

  return clean.slice(-totalCandles).map(([timestamp, open, high, low, close, volume]) => ({
    timestamp,
    open:   Number(open),
    high:   Number(high),
    low:    Number(low),
    close:  Number(close),
    volume: Number(volume),
  }));
}

export async function fetchTicker(symbol) {
  await ensureMarketsLoaded();
  const ticker = await withRetry(
    () => client.fetchTicker(symbol),
    { label: `fetchTicker(${symbol})` },
  );

  return {
    symbol,
    last: Number(ticker.last ?? 0),
    bid: Number(ticker.bid ?? 0),
    ask: Number(ticker.ask ?? 0),
  };
}

export async function fetchBalance() {
  if (paperMode) {
    return {
      mode: 'paper',
      total: { USDT: 0 },
      free: { USDT: 0 },
      used: { USDT: 0 },
    };
  }

  await ensureMarketsLoaded();

  if (testnetMode) {
    const account = await withRetry(
      () => client.privateGetAccount(),
      { label: 'fetchBalance(testnet)' },
    );
    const balance = {
      info: account,
      free: {},
      used: {},
      total: {},
    };

    for (const assetBalance of account.balances ?? []) {
      const asset = String(assetBalance.asset ?? '');
      const free = Number(assetBalance.free ?? 0);
      const used = Number(assetBalance.locked ?? 0);

      if (!asset) {
        continue;
      }

      balance.free[asset] = free;
      balance.used[asset] = used;
      balance.total[asset] = free + used;
    }

    return balance;
  }

  return withRetry(() => client.fetchBalance(), { label: 'fetchBalance(live)' });
}

export async function createOrder(symbol, type, side, amount, price = undefined) {
  await ensureMarketsLoaded();
  return client.createOrder(symbol, type, side, amount, price);
}

export async function cancelOrder(orderId, symbol) {
  await ensureMarketsLoaded();
  return client.cancelOrder(orderId, symbol);
}

export async function fetchOpenOrders(symbol = undefined) {
  await ensureMarketsLoaded();
  return client.fetchOpenOrders(symbol);
}

export async function fetchOrderStatus(orderId, symbol) {
  await ensureMarketsLoaded();
  return client.fetchOrder(orderId, symbol);
}

export async function testConnection() {
  const mode = paperMode ? 'paper' : testnetMode ? 'testnet' : 'live';

  try {
    if (paperMode) {
      await fetchTicker('BTC/USDT');
      return {
        ok: true,
        mode,
        balance: await fetchBalance(),
        error: null,
      };
    }

    return {
      ok: true,
      mode,
      balance: await fetchBalance(),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      mode,
      balance: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default {
  fetchOHLCV,
  fetchHistoricalOHLCV,
  fetchTicker,
  fetchBalance,
  createOrder,
  cancelOrder,
  fetchOpenOrders,
  fetchOrderStatus,
  testConnection,
  paperMode,
  testnetMode,
};

import TelegramBot from 'node-telegram-bot-api';
import logger from '../utils/logger.js';

let bot = null;
let chatIds = [];

/**
 * Initialize the Telegram notifier (send-only, no polling).
 * If token or chatIds are missing the module becomes a no-op.
 */
export function initNotifier(token, ids) {
  if (!token || !ids || ids.length === 0) {
    logger.debug('[NOTIFY] Telegram notifier disabled — missing token or chat IDs');
    return;
  }
  bot = new TelegramBot(token, { polling: false });
  chatIds = ids;
  logger.info(`[NOTIFY] Telegram notifier ready → ${chatIds.length} chat(s)`);
}

/**
 * Send a message to all configured chat IDs. Never throws.
 */
async function broadcast(text) {
  if (!bot || chatIds.length === 0) return;
  for (const chatId of chatIds) {
    try {
      await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (err) {
      logger.debug(`[NOTIFY] Failed to send to ${chatId}: ${err.message}`);
    }
  }
}

/**
 * Plain operator alert (order failures, stuck exits). No-op when Telegram
 * is not configured — callers must also log the condition.
 */
export async function notifyAlert(text) {
  await broadcast(`🚨 <b>ALERT</b>\n${text}`);
}

/**
 * Format a human-readable duration from ms.
 */
function formatDuration(ms) {
  if (!ms || ms <= 0) return 'unknown';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMoney(value) {
  const num = Number(value ?? 0);
  return `${num >= 0 ? '+' : ''}${num.toFixed(2)}`;
}

function formatPrice(value) {
  return Number(value ?? 0).toFixed(8);
}

function formatPct(value) {
  return `${Number(value ?? 0).toFixed(1)}%`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * Send a trade notification. Accepts a trade result object from the executor.
 */
export async function notifyTrade(trade) {
  if (!bot || !trade) return;
  try {
    const symbol = trade.symbol ?? '?';
    const side = (trade.side ?? '').toUpperCase();

    if (side === 'BUY') {
      const price = Number(trade.entryPrice ?? trade.price ?? 0);
      const qty = Number(trade.qty ?? 0);
      const size = (price * qty).toFixed(2);
      const sl = trade.stopLoss != null ? formatPrice(trade.stopLoss) : 'n/a';
      const tp = trade.takeProfit != null ? formatPrice(trade.takeProfit) : 'n/a';
      const bal = trade.balance != null ? formatMoney(trade.balance) : 'n/a';
      const orderId = trade.orderId != null ? `\nOrder: <code>${escapeHtml(trade.orderId)}</code>` : '';
      const msg =
       `🟢 <b>BUY</b> ${symbol}\n` +
       `Entry: <code>${formatPrice(price)}</code>\n` +
       `Qty: <code>${qty.toFixed(8)}</code>\n` +
       `Notional: <code>$${size}</code>\n` +
       `SL/TP: <code>${sl}</code> / <code>${tp}</code>\n` +
       `Balance: <code>$${bal}</code>` +
       orderId;
      await broadcast(msg);
    } else if (side === 'SELL') {
      const price = Number(trade.exitPrice ?? trade.price ?? 0);
      const entryPrice = Number(trade.entryPrice ?? 0);
      const qty = Number(trade.qty ?? 0);
      const pnl = Number(trade.pnl ?? 0);
      const pnlPct = Number(trade.pnlPct ?? 0);
      const duration = trade.entryTime
       ? formatDuration(Date.now() - new Date(trade.entryTime).getTime())
       : (trade.duration ?? 'unknown');
      const reason = trade.reason ? `\nReason: <code>${escapeHtml(trade.reason)}</code>` : '';
      const entry = entryPrice > 0 ? `\nEntry/Exit: <code>${formatPrice(entryPrice)}</code> → <code>${formatPrice(price)}</code>` : '';
      const note = trade.note ? `\nNote: <code>${escapeHtml(trade.note)}</code>` : '';
      const bal = trade.balance != null ? `\nBalance: <code>$${formatMoney(trade.balance)}</code>` : '';
      const msg =
       `🔴 <b>SELL</b> ${symbol}` +
       `${entry}` +
       `\nQty: <code>${qty.toFixed(8)}</code>` +
       `\nP&L: <code>${formatMoney(pnl)} USDC</code> (${formatPct(pnlPct)})` +
       `\nHeld: <code>${duration}</code>` +
       `${reason}${bal}${note}`;
      await broadcast(msg);
    }
  } catch (err) {
    logger.debug(`[NOTIFY] notifyTrade error: ${err.message}`);
  }
}

/**
 * Send a startup notification.
 */
export async function notifyStartup(mode, symbols, meta = {}) {
  if (!bot) return;
  try {
    const filters = [
      meta.mtf ? 'MTF 15m' : null,
      meta.mtf4h ? 'MTF 4h' : null,
      meta.atr ? 'ATR' : null,
      meta.macro ? 'Macro' : null,
      meta.regimeSizing ? 'Regime sizing' : null,
      meta.confSizing ? 'Conf sizing' : null,
    ].filter(Boolean).join(', ') || 'none';
    const msg =
      `🤖 <b>Bot Started</b>\n` +
      `Mode: <code>${escapeHtml(mode)}</code>\n` +
      `Symbols: <code>${symbols.length}</code>\n` +
      `Timeframe: <code>${meta.timeframe ?? 'n/a'}</code>\n` +
      `Slots: <code>${meta.maxOpenPositions ?? 'n/a'}</code>\n` +
      `Min conf: <code>${meta.minConfidence ?? 'n/a'}</code>\n` +
      `Filters: <code>${escapeHtml(filters)}</code>\n` +
      `Time: <code>${new Date().toUTCString()}</code>`;
    await broadcast(msg);
  } catch (err) {
    logger.debug(`[NOTIFY] notifyStartup error: ${err.message}`);
  }
}

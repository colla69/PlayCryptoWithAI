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
      const msg = `🟢 <b>BUY</b> ${symbol}\nPrice: ${price}\nQty: ${qty}\nSize: $${size}`;
      await broadcast(msg);
    } else if (side === 'SELL') {
      const price = Number(trade.exitPrice ?? trade.price ?? 0);
      const qty = Number(trade.qty ?? 0);
      const pnl = Number(trade.pnl ?? 0);
      const pnlPct = Number(trade.pnlPct ?? 0);
      const duration = trade.entryTime
        ? formatDuration(Date.now() - new Date(trade.entryTime).getTime())
        : (trade.duration ?? 'unknown');
      const note = trade.note ? `\nNote: ${trade.note}` : '';
      const msg = `🔴 <b>SELL</b> ${symbol}\nPrice: ${price}\nQty: ${qty}\nP&L: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDC (${pnlPct.toFixed(1)}%)\nHeld: ${duration}${note}`;
      await broadcast(msg);
    }
  } catch (err) {
    logger.debug(`[NOTIFY] notifyTrade error: ${err.message}`);
  }
}

/**
 * Send a startup notification.
 */
export async function notifyStartup(mode, symbols) {
  if (!bot) return;
  try {
    const msg = `🤖 <b>Bot Started</b>\nMode: ${mode}\nSymbols: ${symbols.length}\nTime: ${new Date().toUTCString()}`;
    await broadcast(msg);
  } catch (err) {
    logger.debug(`[NOTIFY] notifyStartup error: ${err.message}`);
  }
}

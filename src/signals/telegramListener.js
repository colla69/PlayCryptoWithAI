import TelegramBot from 'node-telegram-bot-api';
import signalBus from './signalBus.js';
import { parseTelegramSignal } from './signalParser.js';
import logger from '../utils/logger.js';

export function startTelegramListener(token, channelIds = []) {
  if (!token) {
    logger.warn('Telegram token not set — listener disabled');
    return null;
  }

  const allowedChannelIds = new Set(
    (channelIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  );
  const bot = new TelegramBot(token, { polling: true });

  const processMessage = (msg, eventName) => {
    try {
      const chatId = String(msg.chat?.id ?? msg.sender_chat?.id ?? '');
      if (!chatId) return;

      if (allowedChannelIds.size > 0 && !allowedChannelIds.has(chatId)) return;

      const rawText = msg.text ?? msg.caption ?? '';
      logger.debug(`Telegram raw [${chatId}] via ${eventName}: ${rawText.slice(0, 120)}`);

      const parsed = parseTelegramSignal(rawText, 'telegram');
      if (!parsed) return;

      signalBus.emit('signal', parsed);

      const extras = [
        parsed.entry    ? `entry=${parsed.entry}`                        : null,
        parsed.takeProfit?.length ? `tp=[${parsed.takeProfit.join(',')}]` : null,
        parsed.stopLoss ? `sl=${parsed.stopLoss}`                        : null,
      ].filter(Boolean).join(' ');

      logger.info(
        `Telegram signal: ${parsed.symbol} ${parsed.signal} ` +
        `confidence=${parsed.confidence} ${extras} chat=${chatId}`,
      );
    } catch (err) {
      logger.error(`Telegram message handling failed: ${err.message}`);
    }
  };

  bot.on('message',      (msg) => processMessage(msg, 'message'));
  bot.on('channel_post', (msg) => processMessage(msg, 'channel_post'));
  bot.on('polling_error', (err) => logger.error(`Telegram polling error: ${err.message}`));

  logger.info(`Telegram listener started, watching ${allowedChannelIds.size || 'all'} channel(s)`);
  return bot;
}

export default startTelegramListener;

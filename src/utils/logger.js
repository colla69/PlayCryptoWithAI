import fs from 'fs';
import path from 'path';
import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const logsDir = path.join(process.cwd(), 'logs');
const tradesCsvPath = path.join(logsDir, 'trades.csv');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const consoleLevel = process.env.CONSOLE_LOG_LEVEL || process.env.LOG_LEVEL || 'info';
const fileLevel = process.env.FILE_LOG_LEVEL || 'debug';

const logger = createLogger({
  level: 'debug', // capture everything; transports filter by their own level
  format: format.combine(format.timestamp(), format.errors({ stack: true })),
  transports: [
    new transports.Console({
      level: consoleLevel,
      format: format.combine(
        format.colorize({ all: true }),
        format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`),
      ),
    }),
    new DailyRotateFile({
      level: fileLevel,
      dirname: logsDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '30d',
      format: format.combine(
        format.timestamp(),
        format.json(),
      ),
    }),
    new DailyRotateFile({
      level: 'error',
      dirname: logsDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '50m',
      maxFiles: '30d',
      format: format.combine(
        format.timestamp(),
        format.json(),
      ),
    }),
  ],
});

function ensureTradeHeader() {
  if (!fs.existsSync(tradesCsvPath)) {
    fs.writeFileSync(tradesCsvPath, 'timestamp,symbol,side,price,qty,pnl,balance\n', 'utf8');
  }
}

export function appendTrade(trade) {
  ensureTradeHeader();

  const row = [
    trade.timestamp,
    trade.symbol,
    trade.side,
    Number(trade.price).toFixed(8),
    Number(trade.qty).toFixed(8),
    Number(trade.pnl).toFixed(2),
    Number(trade.balance).toFixed(2),
  ].join(',');

  fs.appendFileSync(tradesCsvPath, `${row}\n`, 'utf8');
}

export default logger;

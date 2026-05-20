import fs from 'fs';
import path from 'path';
import { createLogger, format, transports } from 'winston';

const logsDir = path.join(process.cwd(), 'logs');
const appLogPath = path.join(logsDir, 'app.log');
const tradesCsvPath = path.join(logsDir, 'trades.csv');

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(format.timestamp(), format.errors({ stack: true })),
  transports: [
    new transports.Console({
      format: format.combine(
        format.colorize({ all: true }),
        format.printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`),
      ),
    }),
    new transports.File({
      filename: appLogPath,
      format: format.combine(
        format.timestamp(),
        format.printf(({ level, message, timestamp, stack }) => `${timestamp} ${level}: ${stack || message}`),
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

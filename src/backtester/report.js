import fs from 'fs/promises';
import path from 'path';

const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

function colorize(value, numericValue) {
  if (numericValue > 0) {
    return `${GREEN}${value}${RESET}`;
  }

  if (numericValue < 0) {
    return `${RED}${value}${RESET}`;
  }

  return value;
}

function formatNumber(value, digits = 2) {
  return Number(value ?? 0).toFixed(digits);
}

function formatRatio(value) {
  return Number.isFinite(value) ? formatNumber(value, 4) : 'Infinity';
}

export function printReport(symbol, metrics, config) {
  const rows = [
    ['Symbol', symbol],
    ['Timeframe', config.timeframe],
    ['Total Trades', String(metrics.totalTrades)],
    ['Winning Trades', String(metrics.winningTrades)],
    ['Losing Trades', String(metrics.losingTrades)],
    ['Win Rate', `${(metrics.winRate * 100).toFixed(2)}%`],
    ['Total Return', colorize(metrics.totalReturnPct, metrics.totalReturn)],
    ['Total PnL', colorize(formatNumber(metrics.totalPnL), metrics.totalPnL)],
    ['Avg Win', formatNumber(metrics.avgWin)],
    ['Avg Loss', formatNumber(metrics.avgLoss)],
    ['Profit Factor', formatRatio(metrics.profitFactor)],
    ['Max Drawdown', colorize(metrics.maxDrawdownPct, -metrics.maxDrawdown)],
    ['Sharpe Ratio', formatNumber(metrics.sharpeRatio, 4)],
    ['Avg Trade Duration (ms)', String(metrics.avgTradeDurationMs)],
  ];

  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const valueWidth = Math.max(...rows.map(([, value]) => String(value).replace(/\u001b\[[0-9;]*m/g, '').length));
  const border = `┌${'─'.repeat(labelWidth + 2)}┬${'─'.repeat(valueWidth + 2)}┐`;
  const divider = `├${'─'.repeat(labelWidth + 2)}┼${'─'.repeat(valueWidth + 2)}┤`;
  const footer = `└${'─'.repeat(labelWidth + 2)}┴${'─'.repeat(valueWidth + 2)}┘`;

  console.log(border);
  rows.forEach(([label, value], index) => {
    const plainValue = String(value).replace(/\u001b\[[0-9;]*m/g, '');
    const paddedValue = String(value).replace(plainValue, plainValue.padEnd(valueWidth));
    console.log(`│ ${label.padEnd(labelWidth)} │ ${paddedValue} │`);

    if (index === rows.length - 1) {
      return;
    }

    console.log(divider);
  });
  console.log(footer);
}

export async function saveReport(symbol, metrics, trades, config) {
  const logsDir = path.join(process.cwd(), 'logs');
  const dateKey = new Date().toISOString().slice(0, 10);
  const fileName = `backtest-${symbol.replace('/', '_')}-${dateKey}.json`;
  const filePath = path.join(logsDir, fileName);

  await fs.mkdir(logsDir, { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        symbol,
        metrics,
        trades,
        config,
      },
      null,
      2,
    ),
    'utf8',
  );

  return filePath;
}

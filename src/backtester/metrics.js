function formatPercentage(value) {
  const normalized = Number(value ?? 0);
  const sign = normalized > 0 ? '+' : '';
  return `${sign}${(normalized * 100).toFixed(2)}%`;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  if (values.length < 2) {
    return 0;
  }

  const mean = average(values);
  const variance = average(values.map((value) => (value - mean) ** 2));
  return Math.sqrt(variance);
}

function getDailyBalances(equityCurve) {
  const dailyBalances = new Map();

  for (const point of equityCurve) {
    const balance = Number(point?.balance);

    if (!Number.isFinite(balance)) {
      continue;
    }

    const timestamp = Number(point?.timestamp ?? Date.now());
    const dayKey = new Date(timestamp).toISOString().slice(0, 10);
    dailyBalances.set(dayKey, balance);
  }

  return Array.from(dailyBalances.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, balance]) => balance);
}

export function calculateMetrics(trades, equityCurve, initialBalance) {
  const safeTrades = Array.isArray(trades) ? trades : [];
  const safeEquityCurve = Array.isArray(equityCurve) ? equityCurve : [];
  const startingBalance = Number(initialBalance ?? 0);
  const winningTrades = safeTrades.filter((trade) => Number(trade.pnl) > 0);
  const losingTrades = safeTrades.filter((trade) => Number(trade.pnl) < 0);
  const totalPnL = safeTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
  const finalBalance = Number(safeEquityCurve.at(-1)?.balance ?? (startingBalance + totalPnL));
  const grossProfit = winningTrades.reduce((sum, trade) => sum + Number(trade.pnl ?? 0), 0);
  const grossLoss = losingTrades.reduce((sum, trade) => sum + Math.abs(Number(trade.pnl ?? 0)), 0);
  const totalReturn = startingBalance > 0 ? (finalBalance - startingBalance) / startingBalance : 0;

  let peak = startingBalance;
  let maxDrawdown = 0;

  for (const point of safeEquityCurve) {
    const balance = Number(point?.balance ?? peak);

    if (balance > peak) {
      peak = balance;
    }

    if (peak > 0) {
      maxDrawdown = Math.max(maxDrawdown, (peak - balance) / peak);
    }
  }

  const dailyBalances = getDailyBalances(safeEquityCurve);
  const dailyReturns = [];
  for (let index = 1; index < dailyBalances.length; index += 1) {
    const previousBalance = dailyBalances[index - 1];
    const currentBalance = dailyBalances[index];

    if (previousBalance > 0) {
      dailyReturns.push((currentBalance - previousBalance) / previousBalance);
    }
  }

  const avgTradeDurationMs = safeTrades.length === 0
    ? 0
    : average(
        safeTrades.map((trade) => Math.max(0, Number(trade.exitTime ?? 0) - Number(trade.entryTime ?? 0))),
      );

  const byReason = {
    stop_loss: { count: 0, totalPnL: 0 },
    take_profit: { count: 0, totalPnL: 0 },
    strategy_sell: { count: 0, totalPnL: 0 },
    trailing_stop: { count: 0, totalPnL: 0 },
  };

  for (const trade of safeTrades) {
    const reason = String(trade.reason ?? 'strategy_sell');

    if (!byReason[reason]) {
      byReason[reason] = { count: 0, totalPnL: 0 };
    }

    byReason[reason].count += 1;
    byReason[reason].totalPnL = Number((byReason[reason].totalPnL + Number(trade.pnl ?? 0)).toFixed(2));
  }

  return {
    totalTrades: safeTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: safeTrades.length > 0 ? winningTrades.length / safeTrades.length : 0,
    totalReturn,
    totalReturnPct: formatPercentage(totalReturn),
    totalPnL: Number(totalPnL.toFixed(2)),
    avgWin: Number(average(winningTrades.map((trade) => Number(trade.pnl ?? 0))).toFixed(2)),
    avgLoss: Number(average(losingTrades.map((trade) => Number(trade.pnl ?? 0))).toFixed(2)),
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Number.POSITIVE_INFINITY : 0) : Number((grossProfit / grossLoss).toFixed(4)),
    maxDrawdown,
    maxDrawdownPct: formatPercentage(maxDrawdown === 0 ? 0 : -maxDrawdown),
    sharpeRatio: dailyReturns.length < 2 || standardDeviation(dailyReturns) === 0
      ? 0
      : Number(((average(dailyReturns) / standardDeviation(dailyReturns)) * Math.sqrt(252)).toFixed(4)),
    avgTradeDurationMs: Number(avgTradeDurationMs.toFixed(0)),
    byReason,
  };
}

export default calculateMetrics;

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

export const DAYS_PER_YEAR = 365;
const DAY_MS = 86_400_000;

/** Crypto trades every calendar day; use sample deviation consistently across reports. */
export function annualizedSharpe(returns, periodsPerYear = DAYS_PER_YEAR) {
  if (returns.length < 2) return 0;
  const mean = average(returns);
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(periodsPerYear) : 0;
}

/**
 * Daily time-weighted returns, net of cash flows at each observation. Missing days
 * carry the last valuation forward, not the clock: this does not repair missing prices.
 * The integer keys are UTC days, as used by the replay comparison reports.
 */
export function dailyReturnsFromEquity(equity, initialBalance, deposits = [], fromTs = null) {
  const points = equity.filter((p) => Number.isFinite(Number(p.timestamp)) && Number.isFinite(Number(p.balance)))
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
  if (!points.length) return new Map();
  const start = fromTs ?? Number(points[0].timestamp);
  const flows = deposits.filter((d) => Number.isFinite(Number(d.ts)) && Number.isFinite(Number(d.amount)) && d.ts >= start)
    .sort((a, b) => a.ts - b.ts);
  const out = new Map();
  let previous = Number(initialBalance);
  let k = 0;
  for (const p of points) {
    if (Number(p.timestamp) < start) continue;
    let flow = 0;
    while (k < flows.length && flows[k].ts <= Number(p.timestamp)) flow += Number(flows[k++].amount);
    const r = previous > 0 ? (Number(p.balance) - flow) / previous - 1 : 0;
    const day = Math.floor(Number(p.timestamp) / DAY_MS);
    out.set(day, (1 + (out.get(day) ?? 0)) * (1 + r) - 1);
    previous = Number(p.balance);
  }
  if (!out.size) return out;
  const calendar = new Map();
  const lastDay = Math.floor(Number(points.at(-1).timestamp) / DAY_MS);
  for (let day = Math.floor(start / DAY_MS); day <= lastDay; day++) calendar.set(day, out.get(day) ?? 0);
  return calendar;
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

  const dailyReturns = [...dailyReturnsFromEquity(safeEquityCurve, startingBalance).values()];

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
    sharpeRatio: Number(annualizedSharpe(dailyReturns).toFixed(4)),
    sortinoRatio: (() => {
      if (dailyReturns.length < 2) return 0;
      const negReturns = dailyReturns.filter(r => r < 0);
      if (negReturns.length === 0) return dailyReturns.length > 0 ? Infinity : 0;
      const downDev = Math.sqrt(negReturns.reduce((s, r) => s + r * r, 0) / dailyReturns.length);
      return downDev === 0 ? 0 : Number(((average(dailyReturns) / downDev) * Math.sqrt(DAYS_PER_YEAR)).toFixed(4));
    })(),
    avgTradeDurationMs: Number(avgTradeDurationMs.toFixed(0)),
    byReason,
  };
}

export default calculateMetrics;

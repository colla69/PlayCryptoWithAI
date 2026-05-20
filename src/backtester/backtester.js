import SignalAggregator from '../engine/signalAggregator.js';
import { BacktestSimulator } from './backtestSimulator.js';

const MIN_WARMUP_CANDLES = 50;

export class Backtester {
  constructor(strategies = [], config = {}) {
    this.strategies = strategies;
    this.config = {
      ...config,
      signals: config.signals ?? {},
      risk: config.risk ?? {},
    };
    this.aggregator = new SignalAggregator(strategies, this.config.signals);
  }

  async run(symbol, candles) {
    if (!Array.isArray(candles) || candles.length < MIN_WARMUP_CANDLES) {
      throw new Error(`Backtester requires at least ${MIN_WARMUP_CANDLES} candles`);
    }

    const simulator = new BacktestSimulator(this.config.risk);
    const equity = [];

    for (let index = MIN_WARMUP_CANDLES; index < candles.length; index += 1) {
      const slice = candles.slice(0, index + 1);
      const currentCandle = slice.at(-1);
      const result = this.aggregator.aggregate(slice, symbol, this.config.signals);
      const currentPrice = Number(currentCandle.close);

      simulator.setTimestamp(currentCandle.timestamp);
      simulator.execute(symbol, result.decision, currentPrice);

      const status = simulator.getStatus();
      const latestEquity = simulator.getEquityCurve().at(-1) ?? {
        timestamp: currentCandle.timestamp,
        balance: status.balance,
      };

      equity.push({
        timestamp: currentCandle.timestamp,
        price: currentPrice,
        decision: result.decision,
        confidence: result.confidence,
        balance: latestEquity.balance,
        pnl: status.totalPnL,
      });
    }

    const equityCurve = simulator.getEquityCurve();
    return {
      symbol,
      trades: simulator.getTrades(),
      equity,
      equityCurve,
      finalBalance: equityCurve.at(-1)?.balance ?? Number(this.config.risk.initialBalance ?? 0),
      initialBalance: Number(this.config.risk.initialBalance ?? 0),
    };
  }
}

export default Backtester;

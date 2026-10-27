import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as metrics from '../../src/backtester/metrics.js';
import { aggregateFolds, monteCarloShuffle } from '../../src/backtester/walkForward.js';
import { deflatedSharpeRatio } from '../../src/backtester/deflatedSharpe.js';

const DAY = 86_400_000;
const FRIDAY = Date.UTC(2026, 9, 23);

describe('calendar-day performance reporting', () => {
  test('baseline and walk-forward count the first day and use the same crypto Sharpe', () => {
    const equity = [{ timestamp: FRIDAY, balance: 110 }, { timestamp: FRIDAY + DAY, balance: 110 }];
    const baseline = metrics.calculateMetrics([], equity, 100);
    const walk = aggregateFolds([{
      forward_equity: equity, forward_trades: [], fold_start_balance: 100, fold_end_balance: 110,
    }], { budget: 100 });
    // Daily returns +10%, 0% have sample mean/deviation 1/sqrt(2).
    assert.equal(baseline.sharpeRatio, 13.5093);
    assert.equal(walk.sharpe, baseline.sharpeRatio);
  });

  test('deposits do not become returns and crypto weekends remain observations', () => {
    const returns = metrics.dailyReturnsFromEquity([
      { timestamp: FRIDAY - 1, balance: 1000 },
      { timestamp: FRIDAY, balance: 1000 },
      { timestamp: FRIDAY + DAY, balance: 1100 },
      { timestamp: FRIDAY + 2 * DAY, balance: 1089 },
    ], 1000, [{ ts: FRIDAY + DAY, amount: 100 }], FRIDAY);
    assert.deepEqual([...returns.keys()], [FRIDAY / DAY, FRIDAY / DAY + 1, FRIDAY / DAY + 2]);
    assert.equal(returns.get(FRIDAY / DAY), 0);
    assert.equal(returns.get(FRIDAY / DAY + 1), 0);
    assert.ok(Math.abs(returns.get(FRIDAY / DAY + 2) + 0.01) < 1e-12);
  });

  test('a gap in valuations does not compress several calendar days into one', () => {
    const returns = metrics.dailyReturnsFromEquity([
      { timestamp: FRIDAY, balance: 100 },
      { timestamp: FRIDAY + 2 * DAY, balance: 110 },
    ], 100);
    assert.equal(returns.size, 3);
    assert.equal(returns.get(FRIDAY / DAY + 1), 0);
    assert.ok(Math.abs(returns.get(FRIDAY / DAY + 2) - 0.1) < 1e-12);
  });

  test('deflated Sharpe converts the reporting annualization back to observation units', () => {
    const returns = [0.01, -0.02, 0.03, 0.01, -0.005, 0.02];
    const crypto = deflatedSharpeRatio({
      observedSharpe: metrics.annualizedSharpe(returns), returns, nTrials: 10,
    });
    const explicit = deflatedSharpeRatio({
      observedSharpe: metrics.annualizedSharpe(returns, 252), periodsPerYear: 252, returns, nTrials: 10,
    });
    assert.deepEqual(crypto, explicit, 'changing display units must not change statistical significance');
  });

  test('a trade-order shuffle does not pretend its observations are daily returns', () => {
    const r = monteCarloShuffle({ trades: [{ pnl: 10 }, { pnl: 0 }], initialBalance: 100, iterations: 2, rng: () => 0.5 });
    assert.equal(r.observed.sharpe, 0.7071);
  });
});

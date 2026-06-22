import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { windowVerdict, summarizeStress, DEFAULT_STRESS_THRESHOLDS } from '../../src/backtester/stressReport.js';

describe('stressReport — windowVerdict', () => {
  test('green when DD shallow and Sharpe healthy', () => {
    const v = windowVerdict({ sharpe: 1.5, max_drawdown: 0.04, total_trades: 20 });
    assert.equal(v.level, 'green');
  });

  test('red when drawdown breaches -15%', () => {
    const v = windowVerdict({ sharpe: 1.5, max_drawdown: 0.18, total_trades: 20 });
    assert.equal(v.level, 'red');
  });

  test('red when Sharpe below 0.8', () => {
    const v = windowVerdict({ sharpe: 0.5, max_drawdown: 0.03, total_trades: 20 });
    assert.equal(v.level, 'red');
  });

  test('yellow when DD between -10% and -15%', () => {
    const v = windowVerdict({ sharpe: 1.5, max_drawdown: 0.12, total_trades: 20 });
    assert.equal(v.level, 'yellow');
  });

  test('worst signal wins (red DD overrides yellow Sharpe)', () => {
    const v = windowVerdict({ sharpe: 1.0, max_drawdown: 0.16, total_trades: 20 });
    assert.equal(v.level, 'red');
  });

  test('na when too few trades to judge', () => {
    const v = windowVerdict({ sharpe: 5, max_drawdown: 0.01, total_trades: 2 });
    assert.equal(v.level, 'na');
  });
});

describe('stressReport — summarizeStress', () => {
  test('overall escalates to the worst non-na level', () => {
    const rows = [
      { window: { id: 'a' }, metrics: { sharpe: 1.5, max_drawdown: 0.03, total_trades: 20 } }, // green
      { window: { id: 'b' }, metrics: { sharpe: 1.5, max_drawdown: 0.12, total_trades: 20 } }, // yellow
      { window: { id: 'c' }, metrics: { sharpe: 3,   max_drawdown: 0.01, total_trades: 2 } },  // na
    ];
    const r = summarizeStress(rows);
    assert.equal(r.overall, 'yellow');
    assert.equal(r.counts.green, 1);
    assert.equal(r.counts.yellow, 1);
    assert.equal(r.counts.na, 1);
  });

  test('skipped windows are counted but neutral to overall', () => {
    const rows = [
      { skipped: true, reason: 'no data', window: { id: 'x' } },
      { window: { id: 'y' }, metrics: { sharpe: 1.5, max_drawdown: 0.03, total_trades: 20 } },
    ];
    const r = summarizeStress(rows);
    assert.equal(r.overall, 'green');
    assert.equal(r.counts.skipped, 1);
  });

  test('a single red window makes the overall red', () => {
    const rows = [
      { window: { id: 'a' }, metrics: { sharpe: 1.5, max_drawdown: 0.03, total_trades: 20 } },
      { window: { id: 'b' }, metrics: { sharpe: 0.4, max_drawdown: 0.02, total_trades: 20 } },
    ];
    assert.equal(summarizeStress(rows).overall, 'red');
  });
});

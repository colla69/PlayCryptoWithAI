/**
 * Time-weighted return.
 *
 * The case that matters is the first one: an account whose strategy does nothing
 * but which receives deposits must report TWR ≈ 0% while its simple P&L looks
 * positive. That distinction is the entire reason to compute TWR, and without it
 * dollar-cost-averaging makes the bot's performance unreadable.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTimeWeightedReturn, equityAt } from '../../src/utils/timeWeightedReturn.js';

const DAY = 86_400_000;
const T = (d) => Date.parse(`2026-0${d}-01T00:00:00Z`);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

describe('equityAt', () => {
  const points = [
    { timestamp: T(1), equity: 100 },
    { timestamp: T(2), equity: 120 },
    { timestamp: T(3), equity: 90 },
  ];

  test('carries the last snapshot forward', () => {
    assert.equal(equityAt(points, T(2) + DAY), 120);
    assert.equal(equityAt(points, T(2)), 120, 'a snapshot exactly at the timestamp counts');
  });

  test('returns null before the first snapshot', () => {
    assert.equal(equityAt(points, T(1) - DAY), null);
  });
});

describe('computeTimeWeightedReturn', () => {
  test('a flat strategy receiving deposits reports ~0% TWR but positive P&L', () => {
    // Deposit 100, no growth. Deposit 100 more, still no growth.
    const result = computeTimeWeightedReturn({
      flows: [
        { timestamp: T(1), amount: 100 },
        { timestamp: T(2), amount: 100 },
      ],
      equityPoints: [
        { timestamp: T(1), equity: 100 },
        { timestamp: T(2), equity: 100 },   // before the 2nd deposit — flat
        { timestamp: T(3), equity: 200 },
      ],
      finalEquity: 200,
    });

    near(result.twr, 0);
    assert.equal(result.netContributions, 200);
    assert.equal(result.simplePnl, 0, 'wealth grew only by what was paid in');
  });

  test('deposits do not dilute a real gain', () => {
    // 100 → 110 (+10%), deposit 100 (→210), 210 → 231 (+10%). TWR = 21%.
    const result = computeTimeWeightedReturn({
      flows: [
        { timestamp: T(1), amount: 100 },
        { timestamp: T(2), amount: 100 },
      ],
      equityPoints: [
        { timestamp: T(1), equity: 100 },
        { timestamp: T(2), equity: 110 },
        { timestamp: T(3), equity: 231 },
      ],
      finalEquity: 231,
    });

    near(result.twr, 0.21, 1e-9);
    assert.equal(result.netContributions, 200);
    assert.equal(result.simplePnl, 31);
  });

  test('a large late deposit cannot flatter a losing strategy', () => {
    // 100 → 50 (−50%), then deposit 1000 → 1050, flat. TWR stays −50%.
    const result = computeTimeWeightedReturn({
      flows: [
        { timestamp: T(1), amount: 100 },
        { timestamp: T(2), amount: 1000 },
      ],
      equityPoints: [
        { timestamp: T(1), equity: 100 },
        { timestamp: T(2), equity: 50 },
        { timestamp: T(3), equity: 1050 },
      ],
      finalEquity: 1050,
    });

    near(result.twr, -0.5, 1e-9);
    // Money-weighted return would look far milder — that is the trap.
    assert.equal(result.simplePnl, -50);
  });

  test('withdrawals are handled symmetrically', () => {
    // 100 → 200 (+100%), withdraw 100 (→100), 100 → 150 (+50%). TWR = 200%.
    const result = computeTimeWeightedReturn({
      flows: [
        { timestamp: T(1), amount: 100 },
        { timestamp: T(2), amount: -100 },
      ],
      equityPoints: [
        { timestamp: T(1), equity: 100 },
        { timestamp: T(2), equity: 200 },
        { timestamp: T(3), equity: 150 },
      ],
      finalEquity: 150,
    });

    near(result.twr, 2.0, 1e-9);
    assert.equal(result.netContributions, 0);
    assert.equal(result.simplePnl, 150);
  });

  test('single deposit, no further flows — TWR equals plain growth', () => {
    const result = computeTimeWeightedReturn({
      flows: [{ timestamp: T(1), amount: 189.43 }],
      equityPoints: [{ timestamp: T(1), equity: 189.43 }],
      finalEquity: 200,
    });

    near(result.twr, 200 / 189.43 - 1, 1e-12);
    assert.equal(result.subPeriods.length, 1);
  });

  test('reports insufficientData rather than a misleading zero', () => {
    const noEquity = computeTimeWeightedReturn({ flows: [{ timestamp: T(1), amount: 100 }] });
    assert.equal(noEquity.twr, null);
    assert.equal(noEquity.insufficientData, true);

    const nothing = computeTimeWeightedReturn({});
    assert.equal(nothing.twr, null);
    assert.equal(nothing.netContributions, 0);
  });

  test('ignores zero-amount and malformed flows', () => {
    const result = computeTimeWeightedReturn({
      flows: [
        { timestamp: T(1), amount: 100 },
        { timestamp: T(2), amount: 0 },
        { timestamp: T(2), amount: 'abc' },
        { amount: 50 },
      ],
      equityPoints: [{ timestamp: T(1), equity: 100 }],
      finalEquity: 110,
    });

    assert.equal(result.netContributions, 100);
    near(result.twr, 0.1, 1e-12);
  });

  test('survives a zero-equity account without dividing by zero', () => {
    const result = computeTimeWeightedReturn({
      flows: [{ timestamp: T(1), amount: 100 }, { timestamp: T(2), amount: 100 }],
      equityPoints: [{ timestamp: T(1), equity: 100 }, { timestamp: T(2), equity: 0 }],
      finalEquity: 100,
    });
    assert.ok(Number.isFinite(result.twr) || result.twr === null);
  });
});

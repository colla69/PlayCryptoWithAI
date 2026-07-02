/**
 * TSM core sleeve — signal math and reconciliation logic.
 *
 * Live scenarios covered: momentum majority vote (all-positive, split,
 * all-negative), insufficient history forcing CASH, and the open/close
 * action diff against currently held core positions.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeTsmVote, planCoreActions, coreKey, isCoreSymbol, baseSymbol } from '../../src/engine/tsmCore.js';
import { makeTrend, makeCandles } from '../helpers.js';

const LOOKBACKS = [60, 90, 120];

describe('tsmCore: key helpers', () => {
  test('coreKey / isCoreSymbol / baseSymbol round-trip', () => {
    assert.equal(coreKey('BTC/USDC'), 'BTC/USDC#core');
    assert.equal(isCoreSymbol('BTC/USDC#core'), true);
    assert.equal(isCoreSymbol('BTC/USDC'), false);
    assert.equal(baseSymbol('BTC/USDC#core'), 'BTC/USDC');
    assert.equal(baseSymbol('ETH/USDC'), 'ETH/USDC');
  });
});

describe('tsmCore: computeTsmVote', () => {
  test('uptrend → all lookbacks positive → LONG', () => {
    const candles = makeTrend(100, 200, 200);
    const vote = computeTsmVote(candles, LOOKBACKS);
    assert.equal(vote.on, true);
    assert.equal(vote.positive, 3);
    assert.equal(vote.needed, 2);
    assert.equal(vote.insufficientHistory, false);
  });

  test('downtrend → all lookbacks negative → CASH', () => {
    const candles = makeTrend(200, 100, 200);
    const vote = computeTsmVote(candles, LOOKBACKS);
    assert.equal(vote.on, false);
    assert.equal(vote.positive, 0);
  });

  test('split vote: 2 of 3 positive → LONG (majority)', () => {
    // Steep 80-bar dump then a 70-bar recovery. last=212; refs: 60-bar=152 (+),
    // 90-bar=182 (+), 120-bar=242 (−) → 2/3 → LONG.
    const closes = [
      ...Array.from({ length: 80 }, (_, i) => 300 - i * 2), // 300 → 142
      ...Array.from({ length: 70 }, (_, i) => 143 + i),     // 143 → 212
    ];
    const vote = computeTsmVote(makeCandles(closes), LOOKBACKS);
    assert.equal(vote.positive, 2);
    assert.equal(vote.on, true);
  });

  test('1 of 3 positive → CASH (no majority)', () => {
    // Long slow uptrend then a shallow 70-bar dump. last=134.5; refs:
    // 60-bar=164.5 (−), 90-bar=149 (−), 120-bar=119 (+) → 1/3 → CASH.
    const closes = [
      ...Array.from({ length: 130 }, (_, i) => 40 + i),        // 40 → 169
      ...Array.from({ length: 70 }, (_, i) => 169 - i * 0.5),  // 169 → 134.5
    ];
    const vote = computeTsmVote(makeCandles(closes), LOOKBACKS);
    assert.equal(vote.positive, 1);
    assert.equal(vote.on, false);
  });

  test('insufficient history → invalid lookbacks vote CASH', () => {
    const candles = makeTrend(100, 200, 80); // covers the 60-bar lookback only
    const vote = computeTsmVote(candles, LOOKBACKS);
    assert.equal(vote.insufficientHistory, true);
    // 60-bar vote is positive but 90/120 are forced NO → 1/3 < majority
    assert.equal(vote.positive, 1);
    assert.equal(vote.on, false);
  });

  test('empty candles or lookbacks → CASH, never throws', () => {
    assert.equal(computeTsmVote([], LOOKBACKS).on, false);
    assert.equal(computeTsmVote(makeTrend(100, 200, 200), []).on, false);
    assert.equal(computeTsmVote(undefined, LOOKBACKS).on, false);
  });
});

describe('tsmCore: planCoreActions', () => {
  const SYMBOLS = ['BTC/USDC', 'ETH/USDC'];
  const v = (positive, total = 3) => ({ positive, total });

  test('default thresholds = majority: 2/3 opens, 1/3 does not', () => {
    const actions = planCoreActions({
      symbols: SYMBOLS,
      signals: new Map([['BTC/USDC', v(2)], ['ETH/USDC', v(1)]]),
      positions: [],
    });
    assert.deepEqual(actions, [{ type: 'open', symbol: 'BTC/USDC', key: 'BTC/USDC#core' }]);
  });

  test('below majority + core position → close; scalper position on same base is ignored', () => {
    const actions = planCoreActions({
      symbols: SYMBOLS,
      signals: new Map([['BTC/USDC', v(1)], ['ETH/USDC', v(0)]]),
      positions: [
        { symbol: 'BTC/USDC#core', isCore: true },
        { symbol: 'BTC/USDC' }, // scalper position — must not mask the core close
      ],
    });
    assert.deepEqual(actions, [{ type: 'close', symbol: 'BTC/USDC', key: 'BTC/USDC#core' }]);
  });

  test('steady state (held + majority, flat + minority) → no actions', () => {
    const actions = planCoreActions({
      symbols: SYMBOLS,
      signals: new Map([['BTC/USDC', v(2)], ['ETH/USDC', v(1)]]),
      positions: [{ symbol: 'BTC/USDC#core', isCore: true }],
    });
    assert.equal(actions.length, 0);
  });

  test('slow-in hysteresis: 2/3 does NOT open when enterVotes=3, 3/3 does', () => {
    const base = { symbols: SYMBOLS, positions: [], enterVotes: 3, stayVotes: 2 };
    assert.equal(planCoreActions({ ...base, signals: new Map([['BTC/USDC', v(2)], ['ETH/USDC', v(2)]]) }).length, 0);
    const actions = planCoreActions({ ...base, signals: new Map([['BTC/USDC', v(3)], ['ETH/USDC', v(2)]]) });
    assert.deepEqual(actions, [{ type: 'open', symbol: 'BTC/USDC', key: 'BTC/USDC#core' }]);
  });

  test('slow-in hysteresis: held position survives 2/3 but closes at 1/3', () => {
    const base = {
      symbols: SYMBOLS,
      positions: [{ symbol: 'BTC/USDC#core', isCore: true }],
      enterVotes: 3,
      stayVotes: 2,
    };
    assert.equal(planCoreActions({ ...base, signals: new Map([['BTC/USDC', v(2)]]) }).length, 0);
    const actions = planCoreActions({ ...base, signals: new Map([['BTC/USDC', v(1)]]) });
    assert.deepEqual(actions, [{ type: 'close', symbol: 'BTC/USDC', key: 'BTC/USDC#core' }]);
  });
});

/**
 * Signal Aggregator — Live Trading Scenario Tests
 *
 * Tests simulate real signal aggregation: strategy voting, ties,
 * confidence thresholds, external signal ingestion.
 *
 * Formula (Phase 1, confidence-weighted):
 *   confidence = winner_vote_weight / total_voters
 *   where vote_weight = algoWeight × strategy.confidence
 *   and HOLD votes count in the denominator (no more HOLD suppression bug).
 *
 * See src/engine/aggregatorVoting.js for the canonical reference.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SignalAggregator } from '../../src/engine/signalAggregator.js';
import { makeCandles } from '../helpers.js';

// Mock strategy factory: returns a strategy that always gives a fixed signal
function mockStrategy(signal, confidence = 0.7, reason = 'mock') {
  return {
    name: `mock_${signal.toLowerCase()}`,
    analyze: () => ({ signal, confidence, reason }),
  };
}

const CANDLES = makeCandles(Array.from({ length: 50 }, (_, i) => 50000 + i * 10));
// Approx-equal helper for floating point confidence comparisons.
const approxEq = (a, b, eps = 1e-3) => Math.abs(Number(a) - Number(b)) <= eps;

describe('SignalAggregator: Voting Logic', () => {
  test('unanimous BUY returns confidence = average per-strategy confidence', () => {
    const strategies = [
      mockStrategy('BUY', 0.8),
      mockStrategy('BUY', 0.7),
      mockStrategy('BUY', 0.9),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    // (0.8 + 0.7 + 0.9) / 3 = 0.80
    assert.ok(approxEq(result.confidence, 0.80),
      `expected ~0.80, got ${result.confidence}`);
    agg.destroy();
  });

  test('unanimous SELL returns confidence = average per-strategy confidence', () => {
    const strategies = [
      mockStrategy('SELL', 0.8),
      mockStrategy('SELL', 0.7),
      mockStrategy('SELL', 0.6),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'SELL');
    // (0.8 + 0.7 + 0.6) / 3 = 0.70
    assert.ok(approxEq(result.confidence, 0.70),
      `expected ~0.70, got ${result.confidence}`);
    agg.destroy();
  });

  test('majority BUY wins over minority SELL', () => {
    const strategies = [
      mockStrategy('BUY', 0.7),
      mockStrategy('BUY', 0.7),
      mockStrategy('SELL', 0.7),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.4 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    // BUY vote weight = 1.4, total voters = 3 → confidence = 1.4 / 3 ≈ 0.467
    assert.ok(approxEq(result.confidence, 1.4 / 3),
      `expected ~0.467, got ${result.confidence}`);
    agg.destroy();
  });

  test('BUY/SELL tie resolves to HOLD', () => {
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('SELL'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'HOLD');
    agg.destroy();
  });

  test('all HOLD produces HOLD with zero confidence', () => {
    const strategies = [
      mockStrategy('HOLD'),
      mockStrategy('HOLD'),
      mockStrategy('HOLD'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'HOLD');
    agg.destroy();
  });

  test('majority HOLD overrides single BUY (no conviction)', () => {
    // 1 BUY + 2 HOLD — HOLD wins by vote weight (BUY has only 1 voter)
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('HOLD'),
      mockStrategy('HOLD'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'HOLD');
    agg.destroy();
  });

  test('HOLD votes DO dilute confidence (fix for Phase 1 resolution bug)', () => {
    // PRE-PHASE 1: this returned conf=1.00 because HOLD was suppressed from denominator
    // POST-PHASE 1: returns 2/3 = 0.67 — much more honest
    const strategies = [
      mockStrategy('BUY', 1.0),
      mockStrategy('BUY', 1.0),
      mockStrategy('HOLD', 0.5),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.4 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    // 2 BUY × conf 1.0 = 2.0, total voters = 3 → confidence = 2/3 ≈ 0.667
    assert.ok(approxEq(result.confidence, 2 / 3),
      `expected ~0.667, got ${result.confidence}`);
    agg.destroy();
  });

  test('per-strategy confidence is actually used (not just direction)', () => {
    // Two scenarios with same direction counts but different confidence
    // should produce different aggregate confidences.
    const weakBuy = [mockStrategy('BUY', 0.5), mockStrategy('BUY', 0.5), mockStrategy('BUY', 0.5)];
    const strongBuy = [mockStrategy('BUY', 1.0), mockStrategy('BUY', 1.0), mockStrategy('BUY', 1.0)];
    const agg1 = new SignalAggregator(weakBuy, { minConfidence: 0.4 });
    const agg2 = new SignalAggregator(strongBuy, { minConfidence: 0.4 });
    const r1 = agg1.aggregate(CANDLES, 'BTC/USDC');
    const r2 = agg2.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(r1.decision, 'BUY');
    assert.equal(r2.decision, 'BUY');
    assert.ok(r2.confidence > r1.confidence,
      `strong (${r2.confidence}) should exceed weak (${r1.confidence})`);
    assert.ok(approxEq(r1.confidence, 0.5), `weak: expected 0.5, got ${r1.confidence}`);
    assert.ok(approxEq(r2.confidence, 1.0), `strong: expected 1.0, got ${r2.confidence}`);
    agg1.destroy();
    agg2.destroy();
  });
});

describe('SignalAggregator: Confidence Threshold', () => {
  test('BUY below minConfidence resolves to HOLD', () => {
    // 2 BUY + 1 SELL all conf 0.7 → weighted = 1.4/3 ≈ 0.467 < 0.7
    const strategies = [
      mockStrategy('BUY', 0.7),
      mockStrategy('BUY', 0.7),
      mockStrategy('SELL', 0.7),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.7 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'HOLD');
    agg.destroy();
  });

  test('unanimous BUY at conf 1.0 passes minConfidence 1.0', () => {
    const strategies = [
      mockStrategy('BUY', 1.0),
      mockStrategy('BUY', 1.0),
      mockStrategy('BUY', 1.0),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 1.0 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    assert.ok(approxEq(result.confidence, 1.0));
    agg.destroy();
  });
});

describe('SignalAggregator: External Signals', () => {
  test('external BUY signal contributes to vote', () => {
    const strategies = [mockStrategy('BUY', 0.8), mockStrategy('HOLD', 0)];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.3 });

    // Inject external signal
    agg.ingestExternal({
      symbol: 'BTC/USDC',
      signal: 'BUY',
      confidence: 0.9,
      source: 'tradingview',
    });

    const result = agg.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(result.decision, 'BUY');
    assert.equal(result.externalSignals.length, 1);
    agg.destroy();
  });

  test('expired external signals are pruned', async () => {
    const strategies = [mockStrategy('HOLD')];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });

    // Inject signal with old timestamp (> 5 min ago)
    agg.ingestExternal({
      symbol: 'BTC/USDC',
      signal: 'BUY',
      confidence: 0.9,
      source: 'webhook',
      timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
    });

    const result = agg.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(result.externalSignals.length, 0);
    agg.destroy();
  });
});

describe('SignalAggregator: Strategy Results Array', () => {
  test('result.signals contains each strategy output', () => {
    const strategies = [
      mockStrategy('BUY', 0.8, 'RSI oversold'),
      mockStrategy('SELL', 0.6, 'EMA bearish'),
      mockStrategy('HOLD', 0.3, 'MACD flat'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.3 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.signals.length, 3);
    assert.equal(result.signals[0].signal, 'BUY');
    assert.equal(result.signals[1].signal, 'SELL');
    assert.equal(result.signals[2].signal, 'HOLD');
    assert.equal(result.signals[0].reason, 'RSI oversold');
    agg.destroy();
  });
});

describe('SignalAggregator: Multi-bar Confirmation', () => {
  // Borderline = conf in [minConfidence, minConfidence + 0.10) — strict
  // confirmation only for signals BARELY passing the threshold.
  // With minConfidence=0.55 → borderlineCeiling=0.65
  // 2-of-3 BUY conf 0.9 + 1 HOLD → vote 1.8/3 = 0.60 (borderline)
  // 3-of-3 BUY conf 0.9          → vote 0.9    (above ceiling, bypasses gate)

  test('first bar of borderline BUY is suppressed to HOLD', () => {
    const strategies = [
      mockStrategy('BUY', 0.9),
      mockStrategy('BUY', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    const agg = new SignalAggregator(strategies, {
      minConfidence: 0.55,
      multiBarConfirmation: true,
    });
    const r1 = agg.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(r1.decision, 'HOLD', `expected HOLD on first borderline bar, got ${r1.decision}`);
    assert.equal(r1.suppressedDecision, 'BUY');
    assert.equal(r1.suppressedReason, 'multi-bar confirmation pending');
    agg.destroy();
  });

  test('second consecutive borderline BUY is confirmed and executes', () => {
    const strategies = [
      mockStrategy('BUY', 0.9),
      mockStrategy('BUY', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    const agg = new SignalAggregator(strategies, {
      minConfidence: 0.55,
      multiBarConfirmation: true,
    });
    agg.aggregate(CANDLES, 'BTC/USDC');                 // bar 1 → suppressed
    const r2 = agg.aggregate(CANDLES, 'BTC/USDC');      // bar 2 → confirmed
    assert.equal(r2.decision, 'BUY', `expected BUY on second bar, got ${r2.decision}`);
    assert.equal(r2.suppressedDecision, undefined);
    agg.destroy();
  });

  test('high-confidence BUY bypasses multi-bar gate', () => {
    const strategies = [
      mockStrategy('BUY', 1.0),
      mockStrategy('BUY', 1.0),
      mockStrategy('BUY', 1.0),
    ];
    const agg = new SignalAggregator(strategies, {
      minConfidence: 0.55,
      multiBarConfirmation: true,
    });
    const r1 = agg.aggregate(CANDLES, 'BTC/USDC');
    // 3/3 conf 1.0 → confidence 1.0 ≥ ceiling 0.65 → bypass gate
    assert.equal(r1.decision, 'BUY', `expected BUY (bypass gate), got ${r1.decision}`);
    agg.destroy();
  });

  test('HOLD between two BUY signals resets the streak', () => {
    const buyStrategies = [
      mockStrategy('BUY', 0.9),
      mockStrategy('BUY', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    const holdStrategies = [
      mockStrategy('HOLD', 0.3),
      mockStrategy('HOLD', 0.3),
      mockStrategy('HOLD', 0.3),
    ];
    const agg = new SignalAggregator(buyStrategies, {
      minConfidence: 0.55,
      multiBarConfirmation: true,
    });
    agg.aggregate(CANDLES, 'BTC/USDC');                                // bar 1 BUY → suppressed
    agg.strategies = holdStrategies;
    agg.aggregate(CANDLES, 'BTC/USDC');                                // bar 2 HOLD → streak reset
    agg.strategies = buyStrategies;
    const r3 = agg.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(r3.decision, 'HOLD', `expected HOLD on bar 3 (streak reset), got ${r3.decision}`);
    assert.equal(r3.suppressedDecision, 'BUY');
    agg.destroy();
  });

  test('opposite-direction prior decision does not confirm', () => {
    const sellStrategies = [
      mockStrategy('SELL', 0.9),
      mockStrategy('SELL', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    const buyStrategies = [
      mockStrategy('BUY', 0.9),
      mockStrategy('BUY', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    const agg = new SignalAggregator(sellStrategies, {
      minConfidence: 0.55,
      multiBarConfirmation: true,
    });
    agg.aggregate(CANDLES, 'BTC/USDC');                                // bar 1 SELL suppressed
    agg.strategies = buyStrategies;
    const r2 = agg.aggregate(CANDLES, 'BTC/USDC');                     // bar 2 BUY (different dir)
    assert.equal(r2.decision, 'HOLD', `expected HOLD (BUY can't confirm SELL streak)`);
    assert.equal(r2.suppressedDecision, 'BUY');
    agg.destroy();
  });

  test('multi-bar gate is OFF by default (preserves backwards-compat)', () => {
    const strategies = [
      mockStrategy('BUY', 0.9),
      mockStrategy('BUY', 0.9),
      mockStrategy('HOLD', 0.5),
    ];
    // No multiBarConfirmation flag passed
    const agg = new SignalAggregator(strategies, { minConfidence: 0.55 });
    const r1 = agg.aggregate(CANDLES, 'BTC/USDC');
    assert.equal(r1.decision, 'BUY', 'default behaviour must NOT suppress');
    agg.destroy();
  });
});

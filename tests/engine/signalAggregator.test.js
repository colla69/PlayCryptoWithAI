/**
 * Signal Aggregator — Live Trading Scenario Tests
 *
 * Tests simulate real signal aggregation: strategy voting, ties,
 * confidence thresholds, external signal ingestion.
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

describe('SignalAggregator: Voting Logic', () => {
  test('unanimous BUY from all strategies produces BUY', () => {
    const strategies = [
      mockStrategy('BUY', 0.8),
      mockStrategy('BUY', 0.7),
      mockStrategy('BUY', 0.9),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    assert.equal(result.confidence, 1.0); // 3/3 BUY weight
    agg.destroy();
  });

  test('unanimous SELL from all strategies produces SELL', () => {
    const strategies = [
      mockStrategy('SELL', 0.8),
      mockStrategy('SELL', 0.7),
      mockStrategy('SELL', 0.6),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'SELL');
    assert.equal(result.confidence, 1.0);
    agg.destroy();
  });

  test('majority BUY wins over minority SELL', () => {
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('BUY'),
      mockStrategy('SELL'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    // 2 BUY vs 1 SELL → confidence = 2/3 ≈ 0.67
    assert.ok(result.confidence > 0.6 && result.confidence < 0.7);
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
    assert.equal(result.confidence, 0);
    agg.destroy();
  });

  test('majority HOLD overrides single BUY (no conviction)', () => {
    // 1 BUY + 2 HOLD — HOLD wins by vote count (correct: majority is uncertain)
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

  test('HOLD votes do not dilute confidence when BUY wins', () => {
    // 2 BUY + 1 HOLD — BUY wins; confidence uses only directional weight
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('BUY'),
      mockStrategy('HOLD'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    // 2 BUY directional votes, totalWeight=2, confidence=2/2=1.0
    assert.equal(result.confidence, 1.0);
    agg.destroy();
  });
});

describe('SignalAggregator: Confidence Threshold', () => {
  test('BUY below minConfidence resolves to HOLD', () => {
    // 2 BUY + 1 SELL → confidence 0.67, but minConfidence is 0.7
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('BUY'),
      mockStrategy('SELL'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.7 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'HOLD');
    agg.destroy();
  });

  test('BUY at exactly minConfidence is allowed', () => {
    // 3 BUY + 0 SELL → confidence 1.0, well above any threshold
    const strategies = [
      mockStrategy('BUY'),
      mockStrategy('BUY'),
      mockStrategy('BUY'),
    ];
    const agg = new SignalAggregator(strategies, { minConfidence: 1.0 });
    const result = agg.aggregate(CANDLES, 'BTC/USDC');

    assert.equal(result.decision, 'BUY');
    agg.destroy();
  });
});

describe('SignalAggregator: External Signals', () => {
  test('external BUY signal contributes to vote', () => {
    const strategies = [mockStrategy('BUY'), mockStrategy('HOLD')];
    const agg = new SignalAggregator(strategies, { minConfidence: 0.5 });

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

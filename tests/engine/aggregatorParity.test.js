/**
 * Aggregator parity fixture.
 *
 * The cardinal rule of this codebase: live trading and backtesting MUST
 * produce byte-identical decisions for the same inputs. We enforce this
 * by routing the live `SignalAggregator` and the optimizer's local
 * `aggregate()` function through the same pure module
 * `src/engine/aggregatorVoting.js`.
 *
 * This fixture tests:
 *   1. `aggregateVotes()` against a comprehensive table of inputs spanning
 *      unanimous, majority, weighted-confidence, HOLD-suppression, tie,
 *      external-signal, and edge-case scenarios.
 *   2. `SignalAggregator.aggregate()` returns the same decision/confidence
 *      as the direct pure-function call on the same inputs.
 *   3. Both `SignalAggregator` and the optimizer import `aggregateVotes`
 *      from the canonical module (static grep — fails on regression).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { aggregateVotes } from '../../src/engine/aggregatorVoting.js';
import { SignalAggregator } from '../../src/engine/signalAggregator.js';
import { makeCandles } from '../helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

const CANDLES = makeCandles(Array.from({ length: 50 }, (_, i) => 50000 + i * 10));

const mockStrategy = (signal, confidence, name = signal) => ({
  name,
  analyze: () => ({ signal, confidence, reason: 'fixture' }),
});

const FIXTURE_CASES = [
  {
    name: 'unanimous BUY at conf 0.9',
    signals: [
      { signal: 'BUY', confidence: 0.9 },
      { signal: 'BUY', confidence: 0.9 },
      { signal: 'BUY', confidence: 0.9 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 0.9,
  },
  {
    name: 'unanimous BUY mixed confidence',
    signals: [
      { signal: 'BUY', confidence: 0.5 },
      { signal: 'BUY', confidence: 1.0 },
      { signal: 'BUY', confidence: 0.7 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 2.2 / 3,
  },
  {
    name: 'majority BUY 2-1 over SELL',
    signals: [
      { signal: 'BUY', confidence: 0.8 },
      { signal: 'BUY', confidence: 0.8 },
      { signal: 'SELL', confidence: 0.8 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 1.6 / 3,
  },
  {
    name: 'majority BUY 2-1 with HOLD (resolution bug fix)',
    signals: [
      { signal: 'BUY', confidence: 1.0 },
      { signal: 'BUY', confidence: 1.0 },
      { signal: 'HOLD', confidence: 0.5 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 2 / 3,
  },
  {
    name: 'single BUY with 2 HOLDs — HOLD wins by weight',
    signals: [
      { signal: 'BUY', confidence: 1.0 },
      { signal: 'HOLD', confidence: 0.6 },
      { signal: 'HOLD', confidence: 0.6 },
    ],
    // HOLD weight = 1.2, BUY weight = 1.0 → HOLD wins
    expectWinner: 'HOLD',
    expectConfidence: 1.2 / 3,
  },
  {
    name: 'single high-conf BUY beats weak HOLDs',
    signals: [
      { signal: 'BUY', confidence: 1.0 },
      { signal: 'HOLD', confidence: 0.1 },
      { signal: 'HOLD', confidence: 0.1 },
    ],
    // BUY = 1.0, HOLD = 0.2 → BUY wins
    expectWinner: 'BUY',
    expectConfidence: 1 / 3,
  },
  {
    name: 'all HOLD with zero confidence',
    signals: [
      { signal: 'HOLD', confidence: 0 },
      { signal: 'HOLD', confidence: 0 },
      { signal: 'HOLD', confidence: 0 },
    ],
    expectWinner: 'HOLD',
    expectConfidence: 0,
  },
  {
    name: 'BUY/SELL tie at equal weight',
    signals: [
      { signal: 'BUY', confidence: 0.8 },
      { signal: 'SELL', confidence: 0.8 },
    ],
    expectWinner: 'BUY',                 // ranked by Object.entries order
    expectConfidence: 0.8 / 2,
    expectTie: true,
  },
  {
    name: 'confidence clamping — negative + over-1 inputs',
    signals: [
      { signal: 'BUY', confidence: -0.5 },   // clamped to 0
      { signal: 'BUY', confidence: 1.7 },    // clamped to 1.0
      { signal: 'BUY', confidence: 0.5 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 1.5 / 3,
  },
  {
    name: 'invalid signal coerces to HOLD',
    signals: [
      { signal: 'BUY',     confidence: 0.7 },
      { signal: 'GARBAGE', confidence: 0.7 }, // → HOLD
      { signal: 'BUY',     confidence: 0.7 },
    ],
    // BUY = 1.4, HOLD (from garbage) = 0.7 → BUY wins
    expectWinner: 'BUY',
    expectConfidence: 1.4 / 3,
  },
  {
    name: '5-strategy unanimous BUY',
    signals: [
      { signal: 'BUY', confidence: 0.6 },
      { signal: 'BUY', confidence: 0.6 },
      { signal: 'BUY', confidence: 0.6 },
      { signal: 'BUY', confidence: 0.6 },
      { signal: 'BUY', confidence: 0.6 },
    ],
    expectWinner: 'BUY',
    expectConfidence: 0.6,
  },
];

const approxEq = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

describe('aggregateVotes — table-driven truth', () => {
  for (const tc of FIXTURE_CASES) {
    test(tc.name, () => {
      const r = aggregateVotes({ strategySignals: tc.signals });
      assert.equal(r.winner, tc.expectWinner,
        `winner: expected ${tc.expectWinner}, got ${r.winner}`);
      assert.ok(approxEq(r.confidence, tc.expectConfidence),
        `confidence: expected ${tc.expectConfidence.toFixed(4)}, got ${r.confidence}`);
      if (tc.expectTie != null) {
        assert.equal(r.tie, tc.expectTie, `tie flag mismatch`);
      }
    });
  }
});

describe('SignalAggregator parity with aggregateVotes()', () => {
  for (const tc of FIXTURE_CASES) {
    test(`live aggregator matches pure fn — ${tc.name}`, () => {
      const strategies = tc.signals.map((s, i) => mockStrategy(s.signal, s.confidence, `s${i}`));
      const agg = new SignalAggregator(strategies, { minConfidence: 0 });
      const liveResult = agg.aggregate(CANDLES, 'BTC/USDC');
      const pureResult = aggregateVotes({ strategySignals: tc.signals });

      // Tie or HOLD winners get coerced to 'HOLD' decision in the live wrapper.
      const expectedDecision =
        (pureResult.tie || pureResult.winner === 'HOLD') ? 'HOLD' : pureResult.winner;

      assert.equal(liveResult.decision, expectedDecision,
        `decision drift: live=${liveResult.decision} pure=${pureResult.winner} (tie=${pureResult.tie})`);
      assert.ok(approxEq(liveResult.confidence, pureResult.confidence),
        `confidence drift: live=${liveResult.confidence} pure=${pureResult.confidence}`);
      agg.destroy();
    });
  }

  test('external signals contribute to vote weight identically', () => {
    const strategies = [mockStrategy('BUY', 0.5)];
    const agg = new SignalAggregator(strategies, { minConfidence: 0 });
    agg.ingestExternal({
      symbol: 'BTC/USDC',
      signal: 'BUY',
      confidence: 0.9,
      source: 'tradingview',  // sourceWeight = 0.8 default
    });
    const liveResult = agg.aggregate(CANDLES, 'BTC/USDC');

    const pureResult = aggregateVotes({
      strategySignals: [{ signal: 'BUY', confidence: 0.5 }],
      externalSignals: [{ signal: 'BUY', confidence: 0.9, source: 'tradingview' }],
      getSourceWeight: (src) => src === 'tradingview' ? 0.8 : 1,
    });
    assert.equal(liveResult.decision, pureResult.winner);
    assert.ok(approxEq(liveResult.confidence, pureResult.confidence),
      `external-signal parity broken: live=${liveResult.confidence} pure=${pureResult.confidence}`);
    agg.destroy();
  });
});

describe('Source-code parity contract', () => {
  // Static checks that catch a regression where someone re-implements
  // vote counting inline instead of using the shared module.
  test('SignalAggregator imports aggregateVotes', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/engine/signalAggregator.js'), 'utf8');
    assert.ok(/from ['"]\.\/aggregatorVoting\.js['"]/.test(src),
      'signalAggregator.js must import from ./aggregatorVoting.js — do not re-implement voting math inline');
    assert.ok(/aggregateVotes\s*\(/.test(src),
      'signalAggregator.js must call aggregateVotes() — local voting loops are forbidden');
  });

  test('perSymbolOptimizer imports aggregateVotes', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/scripts/perSymbolOptimizer.mjs'), 'utf8');
    assert.ok(/from ['"]\.\.\/engine\/aggregatorVoting\.js['"]/.test(src),
      'perSymbolOptimizer.mjs must import from ../engine/aggregatorVoting.js — do not re-implement voting math inline');
    assert.ok(/aggregateVotes\s*\(/.test(src),
      'perSymbolOptimizer.mjs must call aggregateVotes() — local voting loops are forbidden');
  });

  test('PortfolioBacktester reuses live SignalAggregator (no local aggregate)', () => {
    const src = readFileSync(join(PROJECT_ROOT, 'src/backtester/portfolioBacktester.js'), 'utf8');
    assert.ok(/from ['"]\.\.\/engine\/signalAggregator\.js['"]/.test(src),
      'portfolioBacktester.js must import SignalAggregator from ../engine/signalAggregator.js');
  });
});

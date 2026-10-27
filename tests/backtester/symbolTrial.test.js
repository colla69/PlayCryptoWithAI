/**
 * The optimizer's trial (src/backtester/symbolTrial.js, plan 2026-10 section E
 * item 4): one coin through the live filter stack. The trial takes three shortcuts
 * for speed — cached strategy results, the context's price-only row fields, and the
 * shared candle-only series — and each must leave the run unchanged: a trial has to
 * trade exactly like a plain PortfolioBacktester run of the same coin with the
 * other coins present and silent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../../src/backtester/portfolioBacktester.js';
import { FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides } from '../../src/backtester/baselineFramework.js';
import {
  precomputeStrategyResults, cachedStrategy, trialContext, runSymbolTrial,
} from '../../src/backtester/symbolTrial.js';
import { syntheticMarket } from '../helpers.js';

const H12 = 12 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 1);
const SYMBOLS = ['BTC/USDC', 'XRP/USDC', 'LINK/USDC', 'SOL/USDC'];
const BARS = 500;
const TARGET = 'XRP/USDC';

/** Votes on the closed bars' trailing return (the forming bar is dropped, as the real strategies do). */
class Trailing {
  constructor(n, conf) { this.n = n; this.conf = conf; }
  analyze(candles) {
    const closed = candles.slice(0, -1);
    if (closed.length <= this.n) return { name: `T${this.n}`, signal: 'HOLD', confidence: 0, reason: 'warm-up' };
    const r = closed.at(-1).close / closed.at(-1 - this.n).close - 1;
    const signal = r > 0.01 ? 'BUY' : r < -0.01 ? 'SELL' : 'HOLD';
    return { name: `T${this.n}`, signal, confidence: signal === 'HOLD' ? 0 : this.conf, reason: 'fixture' };
  }
}
const COMBO = { T3: () => new Trailing(3, 0.9), T8: () => new Trailing(8, 0.6), T20: () => new Trailing(20, 0.8) };
const build = () => Object.fromEntries(Object.entries(COMBO).map(([n, f]) => [n, f()]));

const m = Object.fromEntries(SYMBOLS.map((s, i) => [s, syntheticMarket(200 + i, 30 + i * 9, { t0: T0, bars: BARS })]));
const c12 = Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c12]));
const { symbolRisk } = buildPerSymbolOverrides(SYMBOLS);
const btConfig = {
  risk: {
    ...(config.risk ?? {}), initialBalance: 1000, basePctOverride: config.risk?.maxPositionPct,
    feePct: 0.001, slippagePct: 0.001, breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
  },
  signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
  maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
  symbolSlippage: SLIPPAGE_TIERS, symbolRisk,
  mtfSymbolCandles: Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c15])),
  mtf4hSymbolCandles: Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c4])),
  confidenceThresholdScale: config.risk?.confidenceThresholdScale,
  ...FULL_LIVE_FILTERS,
  btcDominance: { enabled: false },
  tradeFromTs: T0 + 250 * H12,
};

describe('symbolTrial', () => {
  test('a trial trades exactly like a plain run with the other coins silent', () => {
    const minConfidence = 0.55;
    const plain = new PortfolioBacktester(
      Object.fromEntries(SYMBOLS.map((s) => [s, s === TARGET ? Object.values(build()) : []])),
      { ...btConfig, symbolMinConfidence: { [TARGET]: minConfidence } },
    );
    const want = plain.run(c12);
    plain.destroy();

    const cache = precomputeStrategyResults(c12[TARGET], build());
    const ctx = trialContext({ symbolCandles: c12, btConfig });
    const strategies = Object.keys(COMBO).map((n) => cachedStrategy(n, cache[n]));
    const got = runSymbolTrial(ctx, { symbol: TARGET, strategies, minConfidence });

    assert.ok(want.trades.length >= 3, `fixture should trade (got ${want.trades.length})`);
    assert.deepEqual(got.trades, want.trades);
    assert.deepEqual(got.equityCurve, want.equityCurve);
    assert.deepEqual(got.filtersApplied, want.filtersApplied);
    assert.ok(got.trades.every((t) => t.symbol === TARGET), 'context coins never trade');
    // The gates ran: a full-stack trial blocks some entries a raw vote would take
    const blocked = ['mtf', 'mtf4h', 'momentum', 'bearPolicy'].reduce((s, k) => s + (got.filtersApplied[k] ?? 0), 0);
    assert.ok(blocked > 0, 'the live entry gates should block at least one BUY on this market');
  });

  test('the threshold is scaled like live (risk.confidenceThresholdScale)', () => {
    // Three strategies always BUY at 0.5: the vote is 0.5. Raw 0.70 × 0.65 = 0.455 lets it
    // through; unscaled, 0.70 blocks every entry.
    const always = { analyze: () => ({ name: 'Always', signal: 'BUY', confidence: 0.5, reason: 'fixture' }) };
    const bare = {
      risk: { initialBalance: 1000, stopLossPct: 0.5, takeProfitPct: 5, feePct: 0.001, slippagePct: 0 },
      signals: { minConfidence: 0.7, multiBarConfirmation: false },
      maxOpenPositions: 4,
    };
    const trades = (scale) => {
      const ctx = trialContext({ symbolCandles: c12, btConfig: { ...bare, confidenceThresholdScale: scale } });
      return runSymbolTrial(ctx, { symbol: TARGET, strategies: [always, always, always], minConfidence: 0.7 }).trades.length;
    };
    assert.ok(trades(0.65) > 0);
    assert.equal(trades(1), 0);
  });

  test('shared series from other candles are refused', () => {
    const ctx = trialContext({ symbolCandles: c12, btConfig });
    const other = { ...c12 };
    const bt = new PortfolioBacktester({ [TARGET]: [] }, btConfig);
    assert.throws(() => bt.run(other, { rows: ctx.rows, shared: ctx.shared }), /other candles/);
    bt.destroy();
  });

  test('a cached strategy refuses a bar it was not computed on', () => {
    const s = cachedStrategy('EMA', new Map());
    assert.throws(() => s.analyze(c12[TARGET].slice(0, 60)), /no cached result/);
  });
});

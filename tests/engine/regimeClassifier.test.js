/**
 * Regime classifier tests (Phase 4).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySnapshot,
  classifySeries,
  RegimeTracker,
  REGIME_LABELS,
  DEFAULT_REGIME_CFG,
} from '../../src/engine/regimeClassifier.js';

function makeCandle(close, high = null, low = null, ts = 0) {
  return {
    timestamp: ts,
    open: close * 0.99,
    high: high ?? close * 1.02,
    low: low ?? close * 0.98,
    close,
    volume: 1000,
  };
}

// Build a series with enough warm-up for EMA(200) + ADX(14)
function makeTrend(start, end, count, startTs = 0) {
  const step = (end - start) / Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => makeCandle(start + step * i, null, null, startTs + i * 1000));
}

describe('classifySnapshot', () => {
  test('returns null label when not enough candles', () => {
    const r = classifySnapshot(makeTrend(100, 110, 50));
    assert.equal(r.label, null);
  });

  test('strong uptrend classifies as BULL_TREND', () => {
    // Long uptrend with high directional movement should produce high ADX
    const candles = makeTrend(50000, 100000, 250);
    const r = classifySnapshot(candles);
    assert.ok(r.label === REGIME_LABELS.BULL_TREND || r.label === REGIME_LABELS.BULL_RANGE,
      `expected BULL_*, got ${r.label} (ADX ${r.adx})`);
    assert.equal(r.btcAboveEma, true);
  });

  test('strong downtrend classifies as BEAR_*', () => {
    const candles = makeTrend(100000, 50000, 250);
    const r = classifySnapshot(candles);
    assert.ok(r.label === REGIME_LABELS.BEAR_TREND || r.label === REGIME_LABELS.BEAR_CHOP,
      `expected BEAR_*, got ${r.label} (ADX ${r.adx})`);
    assert.equal(r.btcAboveEma, false);
  });

  test('returns ADX in [0, 100] range and EMA close to last price for short trends', () => {
    const candles = makeTrend(60000, 62000, 250); // mild uptrend
    const r = classifySnapshot(candles);
    assert.ok(r.adx >= 0 && r.adx <= 100, `ADX out of bounds: ${r.adx}`);
    assert.ok(Math.abs(r.ema200 - r.btcClose) / r.btcClose < 0.10,
      `EMA200 should be within 10% of close: ema=${r.ema200} close=${r.btcClose}`);
  });
});

describe('RegimeTracker hysteresis', () => {
  test('initial regime defaults to BULL_RANGE', () => {
    const t = new RegimeTracker();
    assert.equal(t.currentRegime, REGIME_LABELS.BULL_RANGE);
  });

  test('does not change regime until candidate streak ≥ hysteresisBars', () => {
    const t = new RegimeTracker({ hysteresisBars: 3 });
    // Start in BULL_RANGE; feed candles that classify as BEAR_TREND
    const bearCandles = makeTrend(100000, 60000, 250);

    // First update: candidate becomes BEAR_*, streak = 1, regime stays BULL_RANGE
    const r1 = t.update(bearCandles);
    assert.equal(r1.regime, REGIME_LABELS.BULL_RANGE);
    assert.ok(r1.candidate !== REGIME_LABELS.BULL_RANGE);
    assert.equal(r1.streak, 1);
    assert.equal(r1.regimeChanged, false);

    // Second update with the same data: streak = 2, regime still unchanged
    const r2 = t.update(bearCandles);
    assert.equal(r2.regime, REGIME_LABELS.BULL_RANGE);
    assert.equal(r2.streak, 2);
    assert.equal(r2.regimeChanged, false);

    // Third update: streak = 3 → regime flips
    const r3 = t.update(bearCandles);
    assert.notEqual(r3.regime, REGIME_LABELS.BULL_RANGE);
    assert.equal(r3.regimeChanged, true);
  });

  test('candidate streak resets when new candidate differs', () => {
    const t = new RegimeTracker({ hysteresisBars: 3 });
    const bear = makeTrend(100000, 60000, 250);
    const bull = makeTrend(50000, 100000, 250);

    t.update(bear);  // candidate=BEAR_*, streak 1
    t.update(bear);  // streak 2 (still below hysteresis)
    const r = t.update(bull); // different candidate → streak 1
    assert.equal(r.regime, REGIME_LABELS.BULL_RANGE); // unchanged
    assert.equal(r.streak, 1);
  });

  test('toJSON returns serialisable snapshot', () => {
    const t = new RegimeTracker();
    const j = t.toJSON();
    assert.equal(typeof j.currentRegime, 'string');
    assert.ok('cfg' in j);
    assert.ok(Array.isArray(j.history));
  });
});

describe('classifySeries', () => {
  test('returns one entry per candle with regimes filled after warm-up', () => {
    const candles = makeTrend(50000, 100000, 300);
    const series = classifySeries(candles);
    assert.equal(series.length, 300);
    const labeled = series.filter((p) => p.regime != null);
    assert.ok(labeled.length > 0, 'expected at least some labelled bars');
    // First 200 bars should be unlabelled (warmup for EMA200)
    assert.equal(series[0].regime, null);
  });

  test('regime in a steady uptrend is consistently bullish', () => {
    const candles = makeTrend(50000, 100000, 400);
    const series = classifySeries(candles);
    const labeled = series.filter((p) => p.regime != null);
    const bullish = labeled.filter((p) => p.regime?.startsWith('BULL'));
    assert.ok(
      bullish.length / labeled.length > 0.8,
      `expected >80% bullish in pure uptrend, got ${(bullish.length / labeled.length * 100).toFixed(1)}%`,
    );
  });
});

describe('DEFAULT_REGIME_CFG contract', () => {
  test('frozen and contains expected keys', () => {
    assert.equal(Object.isFrozen(DEFAULT_REGIME_CFG), true);
    assert.equal(DEFAULT_REGIME_CFG.emaPeriod, 200);
    assert.equal(DEFAULT_REGIME_CFG.adxPeriod, 14);
    assert.equal(DEFAULT_REGIME_CFG.adxTrendThreshold, 25);
    assert.equal(DEFAULT_REGIME_CFG.hysteresisBars, 3);
  });
});

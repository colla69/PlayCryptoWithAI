/**
 * Regime router tests (Phase 4 + 6a).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBearPolicy,
  resolveStrategyList,
  buildRegimeStrategyMap,
  DEFAULT_REGIME_BUNDLES,
} from '../../src/engine/regimeRouter.js';
import { REGIME_LABELS } from '../../src/engine/regimeClassifier.js';

describe('computeBearPolicy', () => {
  test('disabled policy → pass-through', () => {
    const r = computeBearPolicy({ regime: 'BEAR_TREND', regimeChanged: true, policy: { enabled: false } });
    assert.equal(r.shouldBlockEntries, false);
    assert.equal(r.shouldCashExitOpen, false);
  });

  test('no regime (warmup) → pass-through', () => {
    const r = computeBearPolicy({ regime: null, regimeChanged: false, policy: { enabled: true } });
    assert.equal(r.shouldBlockEntries, false);
  });

  test('BULL regime → pass-through', () => {
    for (const r of [REGIME_LABELS.BULL_TREND, REGIME_LABELS.BULL_RANGE]) {
      const result = computeBearPolicy({ regime: r, regimeChanged: false, policy: { enabled: true } });
      assert.equal(result.shouldBlockEntries, false, `expected pass-through for ${r}`);
    }
  });

  test('default trend_only: BEAR_TREND triggers, BEAR_CHOP does not', () => {
    const trend = computeBearPolicy({ regime: REGIME_LABELS.BEAR_TREND, regimeChanged: false, policy: { enabled: true } });
    assert.equal(trend.shouldBlockEntries, true);
    const chop = computeBearPolicy({ regime: REGIME_LABELS.BEAR_CHOP, regimeChanged: false, policy: { enabled: true } });
    assert.equal(chop.shouldBlockEntries, false);
  });

  test('all_bear: both BEAR_TREND and BEAR_CHOP trigger', () => {
    const trend = computeBearPolicy({ regime: REGIME_LABELS.BEAR_TREND, regimeChanged: false, policy: { enabled: true, restrictTo: 'all_bear' } });
    assert.equal(trend.shouldBlockEntries, true);
    const chop = computeBearPolicy({ regime: REGIME_LABELS.BEAR_CHOP, regimeChanged: false, policy: { enabled: true, restrictTo: 'all_bear' } });
    assert.equal(chop.shouldBlockEntries, true);
  });

  test('cash-exit fires ONLY on regimeChanged=true', () => {
    const policy = { enabled: true };
    const onChange = computeBearPolicy({ regime: REGIME_LABELS.BEAR_TREND, regimeChanged: true, policy });
    const stable  = computeBearPolicy({ regime: REGIME_LABELS.BEAR_TREND, regimeChanged: false, policy });
    assert.equal(onChange.shouldCashExitOpen, true);
    assert.equal(stable.shouldCashExitOpen, false);
    assert.equal(stable.shouldBlockEntries, true,
      'still blocks new entries after the initial transition bar');
  });

  test('cash-exit DOES NOT fire on a BULL→BULL transition', () => {
    // Hypothetical: regime changed from BULL_TREND to BULL_RANGE
    const r = computeBearPolicy({ regime: REGIME_LABELS.BULL_RANGE, regimeChanged: true, policy: { enabled: true } });
    assert.equal(r.shouldCashExitOpen, false);
  });
});

describe('resolveStrategyList', () => {
  const cfg = {
    strategies: ['RSI', 'BB', 'CCI'],
    perSymbol: {
      'BTC/USDC': { strategies: ['EMA', 'PSAR', 'HeikinAshi'] },
      'ETH/USDC': {
        strategies: ['MFI'],
        regimeStrategyBundles: {
          BULL_TREND: ['EMA', 'MACD'],
          BULL_RANGE: ['RSI', 'BB'],
          BEAR_TREND: [],
        },
      },
    },
  };

  test('routing disabled → static list per symbol', () => {
    const r = resolveStrategyList({ symbol: 'BTC/USDC', regime: REGIME_LABELS.BULL_TREND, config: cfg, routingEnabled: false });
    assert.deepEqual(r.names, ['EMA', 'PSAR', 'HeikinAshi']);
    assert.equal(r.source, 'per-symbol-static');
  });

  test('routing enabled + per-symbol bundle wins over global', () => {
    const r = resolveStrategyList({ symbol: 'ETH/USDC', regime: REGIME_LABELS.BULL_TREND, config: cfg, routingEnabled: true });
    assert.deepEqual(r.names, ['EMA', 'MACD']);
    assert.equal(r.source, 'per-symbol-bundle');
  });

  test('routing enabled + missing per-symbol bundle falls back to global', () => {
    const r = resolveStrategyList({ symbol: 'BTC/USDC', regime: REGIME_LABELS.BULL_TREND, config: cfg, bundles: DEFAULT_REGIME_BUNDLES, routingEnabled: true });
    assert.deepEqual(r.names, DEFAULT_REGIME_BUNDLES.BULL_TREND);
    assert.equal(r.source, 'global-bundle');
  });

  test('routing enabled + empty bundle → blocked (null names)', () => {
    const r = resolveStrategyList({ symbol: 'ETH/USDC', regime: REGIME_LABELS.BEAR_TREND, config: cfg, routingEnabled: true });
    assert.equal(r.names, null);
    assert.equal(r.source, 'blocked');
  });

  test('routing enabled + null regime (warmup) → static list', () => {
    const r = resolveStrategyList({ symbol: 'BTC/USDC', regime: null, config: cfg, routingEnabled: true });
    assert.deepEqual(r.names, ['EMA', 'PSAR', 'HeikinAshi']);
  });
});

describe('buildRegimeStrategyMap', () => {
  const cfg = {
    strategies: ['RSI'],
    perSymbol: { 'BTC/USDC': { strategies: ['EMA'] } },
  };

  test('excludes symbols whose resolved list is null/empty', () => {
    const map = buildRegimeStrategyMap({
      symbols: ['BTC/USDC', 'ETH/USDC'],
      regime: REGIME_LABELS.BEAR_TREND,
      config: cfg,
      bundles: { BEAR_TREND: [] },
      routingEnabled: true,
    });
    assert.deepEqual(Object.keys(map), []);
  });

  test('includes symbols when bundle non-empty', () => {
    const map = buildRegimeStrategyMap({
      symbols: ['BTC/USDC', 'ETH/USDC'],
      regime: REGIME_LABELS.BULL_TREND,
      config: cfg,
      bundles: { BULL_TREND: ['MACD', 'OBV'] },
      routingEnabled: true,
    });
    assert.deepEqual(map['BTC/USDC'], ['MACD', 'OBV']);
    assert.deepEqual(map['ETH/USDC'], ['MACD', 'OBV']);
  });
});

describe('DEFAULT_REGIME_BUNDLES contract', () => {
  test('frozen and contains all 4 regime keys', () => {
    assert.equal(Object.isFrozen(DEFAULT_REGIME_BUNDLES), true);
    for (const key of ['BULL_TREND', 'BULL_RANGE', 'BEAR_TREND', 'BEAR_CHOP']) {
      assert.ok(Array.isArray(DEFAULT_REGIME_BUNDLES[key]), `missing ${key}`);
    }
  });

  test('BEAR bundles are empty (no entries)', () => {
    assert.equal(DEFAULT_REGIME_BUNDLES.BEAR_TREND.length, 0);
    assert.equal(DEFAULT_REGIME_BUNDLES.BEAR_CHOP.length, 0);
  });
});

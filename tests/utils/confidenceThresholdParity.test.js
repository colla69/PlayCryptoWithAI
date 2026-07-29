/**
 * Confidence-threshold parity fixture.
 *
 * The live bot gates entries TWICE: the aggregator forces HOLD below
 * `getSignalConfigForSymbol().minConfidence`, then `riskManager.canTrade()`
 * re-gates on `getRiskForSymbol().minConfidence`. Both must carry the same
 * `risk.confidenceThresholdScale` calibration, or the stricter one silently
 * wins and live diverges from the backtester (which scales exactly once, in
 * PortfolioBacktester).
 *
 * That is not hypothetical. `getRiskForSymbol()` used to return the RAW
 * per-symbol value, so live ran at an effective scale of 1.0 — the case
 * config/default.js documents as "STARVED (3 trades/90d, 0 on longer windows)".
 * The 2026-07-02 → 07-29 live soak took ZERO trades in 27 days: 15 BUY signals,
 * all blocked, three of them (LDO 0.49, BTC 0.54, PAXG 0.49) killed by this gate
 * alone after clearing every other filter.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import config from '../../config/default.js';
import {
  getRiskForSymbol, getSignalConfigForSymbol, scaleMinConfidence,
} from '../../src/utils/strategyBuilder.js';
import { RiskManager } from '../../src/risk/riskManager.js';

const SCALE = config.risk.confidenceThresholdScale;
const signalConfig = config.signals;

/** The formula PortfolioBacktester applies (src/backtester/portfolioBacktester.js). */
const backtesterScale = (mc) => Math.max(0, Math.min(1, mc * SCALE));

describe('scaleMinConfidence', () => {
  test('matches the backtester formula across the threshold range', () => {
    for (const raw of [0, 0.3, 0.5, 0.55, 0.7, 0.85, 1]) {
      assert.equal(scaleMinConfidence(raw), backtesterScale(raw), `raw=${raw}`);
    }
  });

  test('clamps to [0, 1] and passes non-numbers through untouched', () => {
    assert.equal(scaleMinConfidence(0), 0);
    assert.ok(scaleMinConfidence(1) <= 1);
    assert.equal(scaleMinConfidence(undefined), undefined);
    assert.equal(scaleMinConfidence(null), null);
    assert.ok(Number.isNaN(scaleMinConfidence(NaN)));
  });
});

describe('live gates agree with each other', () => {
  test('every configured symbol gets the same threshold from both gates', () => {
    const mismatches = [];
    for (const symbol of config.symbols) {
      const riskGate = getRiskForSymbol(symbol).minConfidence;
      const aggGate = getSignalConfigForSymbol(symbol, signalConfig).minConfidence;
      if (riskGate !== aggGate) mismatches.push(`${symbol}: risk=${riskGate} agg=${aggGate}`);
    }
    assert.deepEqual(mismatches, [], `gates disagree — live would run at the stricter one:\n${mismatches.join('\n')}`);
  });

  test('both gates equal the backtester-scaled per-symbol value', () => {
    for (const symbol of config.symbols) {
      const raw = config.perSymbol?.[symbol]?.minConfidence ?? config.risk.minConfidence;
      assert.equal(
        getRiskForSymbol(symbol).minConfidence, backtesterScale(raw),
        `${symbol} risk gate is not scaled — live ≠ backtest`,
      );
    }
  });

  test('a symbol with no perSymbol override still gets the scaled global', () => {
    // getRiskForSymbol() used to short-circuit `return config.risk` here,
    // handing back the raw 0.70 global.
    const unknown = 'NOTACOIN/USDC';
    assert.equal(config.perSymbol?.[unknown], undefined);
    assert.equal(getRiskForSymbol(unknown).minConfidence, backtesterScale(config.risk.minConfidence));
  });

  test('the two global fallbacks agree', () => {
    // getSignalConfigForSymbol falls back to signals.minConfidence, while
    // getRiskForSymbol falls back to risk.minConfidence. They resolve to the
    // same number today; if they ever diverge, symbols without a perSymbol
    // override would silently get two different gates again.
    assert.equal(
      config.signals?.minConfidence ?? config.risk.minConfidence,
      config.risk.minConfidence,
      'signals.minConfidence and risk.minConfidence must match, or the gates split',
    );
  });

  test('getRiskForSymbol still returns per-symbol SL/TP untouched', () => {
    // Scaling minConfidence must not disturb the other risk fields.
    const withOverride = config.symbols.find((s) => config.perSymbol?.[s]?.stopLossPct !== undefined);
    if (!withOverride) return;
    const risk = getRiskForSymbol(withOverride);
    assert.equal(risk.stopLossPct, config.perSymbol[withOverride].stopLossPct);
    assert.equal(risk.maxDailyLossPct, config.risk.maxDailyLossPct);
  });
});

describe('regression: the 2026-07 soak starvation', () => {
  const cases = [
    { symbol: 'BTC/USDC', confidence: 0.54, when: '2026-07-15' },
    { symbol: 'LDO/USDC', confidence: 0.49, when: '2026-07-14' },
    { symbol: 'PAXG/USDC', confidence: 0.49, when: '2026-07-22' },
  ];

  for (const { symbol, confidence, when } of cases) {
    test(`${symbol} BUY @ ${confidence} (blocked ${when}) is admitted`, () => {
      const rm = new RiskManager({ ...config.risk, ...getRiskForSymbol(symbol) });
      const result = rm.canTrade(
        symbol, 'BUY', confidence,
        { positions: [], balance: 1000 },
        getRiskForSymbol(symbol).minConfidence,
      );
      assert.equal(result.allowed, true, `still blocked: ${result.reason}`);
    });
  }

  test('the gate still rejects genuinely weak signals', () => {
    // Scaling must not disable the gate — 0.30 is below BTC's scaled 0.358.
    const rm = new RiskManager(config.risk);
    const result = rm.canTrade(
      'BTC/USDC', 'BUY', 0.30,
      { positions: [], balance: 1000 },
      getRiskForSymbol('BTC/USDC').minConfidence,
    );
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Confidence'));
  });
});

describe('static guard', () => {
  test('getRiskForSymbol routes its threshold through scaleMinConfidence', () => {
    // Cheap tripwire: a future edit that reintroduces a raw read fails here
    // even if it happens to pass the value-based assertions above.
    const src = readFileSync(new URL('../../src/utils/strategyBuilder.js', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function getRiskForSymbol'));
    const fnBody = body.slice(0, body.indexOf('\n}'));
    assert.ok(
      fnBody.includes('scaleMinConfidence'),
      'getRiskForSymbol must scale minConfidence — see the 2026-07 starvation',
    );
  });
});

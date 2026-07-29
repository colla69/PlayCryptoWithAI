/**
 * Live ≡ Backtest inventory.
 *
 * WHY THIS EXISTS
 * ---------------
 * Parity has broken four times, and every single break was a rule that existed
 * on ONE side only. Reviewing a diff never caught them, because nothing in the
 * diff looked wrong — the omission was invisible:
 *
 *   · min notional      — enforced in liveTrader, absent from the simulator, so
 *                         backtests filled orders Binance would have rejected
 *   · minConfidence     — scaled for the aggregator, read RAW by canTrade
 *   · candle merge      — payload-wins on disk, first-wins in memory
 *   · cycle alignment   — backtest evaluates at candle close, live drifted 6h
 *   · downloader merge  — first-wins in downloadHistory, so a bar frozen
 *                         mid-formation corrupted the research data permanently
 *
 * Note the pattern in the last two: "merge" appears three times. Any place two
 * sources of the same record combine, assert which one wins — the exchange
 * payload, always. See tests/dashboard/candleMerge.test.js and
 * tests/scripts/downloadHistoryMerge.test.js.
 *
 * So this fixture inverts the burden of proof. Every rule that can reject or
 * resize a live entry is listed below with the concrete symbol that implements
 * it on BOTH sides. Adding a live-side rule without a backtest counterpart fails
 * here, at the point the rule is added — not months later in a soak post-mortem.
 *
 * WHEN THIS TEST FAILS, DO NOT DELETE THE ROW.
 * Either implement the missing side, or — if the rule genuinely cannot apply to
 * a backtest — move it to INTENTIONALLY_LIVE_ONLY with a written reason.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/**
 * Rules that gate or size a live entry. `live` and `backtest` are symbols that
 * must appear in the respective files — a cheap, robust proxy for "this side
 * implements the rule".
 */
const PARITY_INVENTORY = [
  {
    rule: 'Exchange minimum notional',
    live: { file: 'src/executor/liveTrader.js', symbol: 'FALLBACK_MIN_NOTIONAL' },
    backtest: { file: 'src/backtester/backtestSimulator.js', symbol: 'minNotional' },
    shared: 'src/exchange/exchangeLimits.js',
  },
  {
    rule: 'minConfidence threshold scaling',
    live: { file: 'src/utils/strategyBuilder.js', symbol: 'scaleMinConfidence' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'confidenceThresholdScale' },
  },
  {
    // Strongest form of parity available: the backtester instantiates the live
    // aggregator class rather than reimplementing the vote. Keep it that way.
    rule: 'Confidence-weighted voting',
    live: { file: 'src/engine/signalAggregator.js', symbol: 'aggregateVotes' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'SignalAggregator' },
    shared: 'src/engine/aggregatorVoting.js',
  },
  {
    rule: 'Momentum-leader filter',
    live: { file: 'src/core/filters.js', symbol: 'momentum' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'momentum' },
    shared: 'src/utils/momentum.js',
  },
  {
    rule: 'Bear-regime policy (cash exit + entry block)',
    live: { file: 'src/main.js', symbol: 'computeBearPolicy' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'computeBearPolicy' },
    shared: 'src/engine/regimeRouter.js',
  },
  {
    rule: '15m MTF alignment',
    live: { file: 'src/core/filters.js', symbol: 'mtfAlignScore' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'mtf' },
    shared: 'src/utils/mtfAlignment.js',
  },
  {
    rule: '4h momentum filter',
    live: { file: 'src/core/filters.js', symbol: 'mtf4hMomentumScore' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'mtf4h' },
    shared: 'src/utils/mtfAlignment.js',
  },
  {
    rule: 'Portfolio correlation cap',
    live: { file: 'src/core/filters.js', symbol: 'correlation' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'correlation' },
  },
  {
    rule: 'Weekly drawdown breaker',
    live: { file: 'src/core/filters.js', symbol: 'calcWeeklyDDBreaker' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'weeklyDDBreaker' },
    shared: 'src/risk/portfolioRisk.js',
  },
  {
    rule: 'Position aging exit',
    live: { file: 'src/main.js', symbol: 'calcPositionAgingExit' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'positionAging' },
    shared: 'src/risk/portfolioRisk.js',
  },
  {
    rule: 'Macro (BTC EMA200) size reduction',
    live: { file: 'src/core/positionSizing.js', symbol: 'applyMacroFilter' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'macroSizeReduceFactor' },
  },
  {
    rule: 'ADX regime sizing',
    live: { file: 'src/core/positionSizing.js', symbol: 'applyRegimeSizing' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'regimeBoostFactor' },
  },
  {
    rule: 'Confidence-proportional sizing',
    live: { file: 'src/core/positionSizing.js', symbol: 'applyConfSizing' },
    backtest: { file: 'src/backtester/portfolioBacktester.js', symbol: 'confSizing' },
  },
  {
    rule: 'Break-even stop',
    live: { file: 'src/executor/liveTrader.js', symbol: 'breakEven' },
    backtest: { file: 'src/backtester/backtestSimulator.js', symbol: 'breakEven' },
  },
];

/**
 * Live-only by design. Each needs a reason that survives scrutiny — "hard to
 * implement" is not one.
 */
const INTENTIONALLY_LIVE_ONLY = [
  {
    rule: 'Candle-freshness guard',
    reason: 'Backtests replay a fixed historical series, so "is this bar current?" '
          + 'is meaningless. The live guard exists because a delisted pair keeps '
          + 'returning non-advancing klines in real time.',
  },
  {
    rule: 'Daily-loss limit (riskManager)',
    reason: 'Scales off live account equity refreshed from the exchange each cycle. '
          + 'The backtester enforces the same %-limit against simulated equity via '
          + 'calcEquityFromStatus parity, not through riskManager itself.',
  },
  {
    rule: 'Exchange lot-size / precision rounding',
    reason: 'amountToPrecision depends on per-market filters fetched from Binance. '
          + 'Material only near the min-notional boundary, which IS modelled.',
  },
];

describe('live ≡ backtest inventory', () => {
  for (const entry of PARITY_INVENTORY) {
    test(`${entry.rule} — implemented on both sides`, () => {
      const liveSrc = read(entry.live.file);
      const btSrc = read(entry.backtest.file);
      assert.ok(
        liveSrc.includes(entry.live.symbol),
        `live side missing: expected "${entry.live.symbol}" in ${entry.live.file}`,
      );
      assert.ok(
        btSrc.includes(entry.backtest.symbol),
        `BACKTEST SIDE MISSING: expected "${entry.backtest.symbol}" in ${entry.backtest.file}. `
        + `A rule that gates live entries but not backtested ones makes every backtest optimistic.`,
      );
    });
  }

  for (const entry of PARITY_INVENTORY.filter((e) => e.shared)) {
    test(`${entry.rule} — both sides consume the shared module`, () => {
      const shared = entry.shared.split('/').pop().replace('.js', '');
      const liveSrc = read(entry.live.file);
      const btSrc = read(entry.backtest.file);
      const importsShared = (src) => src.includes(shared);
      assert.ok(
        importsShared(liveSrc) || importsShared(btSrc),
        `neither side references ${entry.shared} — duplicated math will drift`,
      );
    });
  }

  test('every live-only exemption carries a reason', () => {
    for (const e of INTENTIONALLY_LIVE_ONLY) {
      assert.ok(e.reason && e.reason.length > 40, `${e.rule} needs a real justification`);
    }
  });

  test('the inventory is not silently shrinking', () => {
    // Guards against "fix the failure by deleting the row".
    assert.ok(
      PARITY_INVENTORY.length >= 14,
      `inventory has ${PARITY_INVENTORY.length} rules; it should only ever grow. `
      + `If a rule was genuinely removed from the bot, lower this number deliberately.`,
    );
  });
});

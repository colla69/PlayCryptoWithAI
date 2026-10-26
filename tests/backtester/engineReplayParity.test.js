/**
 * The engine live runs (replayed) ≡ PortfolioBacktester — trade for trade.
 *
 * Step 4 of the 2026-10 single-engine rebuild showed the two engines give identical
 * trades on real data (6 / 6 on the live window, 26 / 26 over a year). This pins it on
 * a fixed synthetic market so a change to either side cannot drift silently: six
 * configured symbols (so their real strategies and thresholds), 12h bars with 15m and
 * 4h bars inside them, alternating trends, live sizing, the sleeve off. The gates'
 * thresholds are relaxed on both sides (every gate still runs, but passes) so the
 * fixture trades — on live thresholds a random walk gives these strategies no entry.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../../src/backtester/portfolioBacktester.js';
import { FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides } from '../../src/backtester/baselineFramework.js';
import { replayEngine } from '../../src/backtester/engineReplay.js';
import { buildStrategiesForSymbol } from '../../src/utils/strategyBuilder.js';
import { syntheticMarket } from '../helpers.js';

const H12 = 12 * 60 * 60 * 1000;
const H4 = 4 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 1);
const SYMBOLS = ['BTC/USDC', 'XRP/USDC', 'LINK/USDC', 'SOL/USDC', 'ADA/USDC', 'LTC/USDC'];
const BARS = 600;

describe('engine replay ≡ PortfolioBacktester', () => {
  test('identical trades on a fixed synthetic market', async () => {
    const m = Object.fromEntries(SYMBOLS.map((s, i) => [s, syntheticMarket(100 + i, 24 + i * 7, { t0: T0, bars: BARS })]));
    const c12 = Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c12]));
    const c15 = Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c15]));
    const c4 = Object.fromEntries(SYMBOLS.map((s) => [s, m[s].c4]));
    const fromTs = T0 + 250 * H12;
    const toTs = T0 + (BARS - 1) * H12;
    const relaxed = {
      momentumFilter: { ...config.momentumFilter, minPct: -1 },
      mtfFilter: { ...config.mtfFilter, minAlignScore: 0 },
      mtf4hFilter: { ...config.mtf4hFilter, minScore: 0 },
    };
    const cfg = {
      ...config, ...relaxed, symbols: SYMBOLS,
      tsmCore: { ...(config.tsmCore ?? {}), enabled: false }, btcDominance: { enabled: false },
    };

    const { symbolRisk, symbolMinConfidence } = buildPerSymbolOverrides(SYMBOLS);
    const pb = new PortfolioBacktester(
      Object.fromEntries(SYMBOLS.map((s) => [s, buildStrategiesForSymbol(s)])),
      {
        risk: {
          ...(config.risk ?? {}), initialBalance: 1000, basePctOverride: config.risk?.maxPositionPct,
          feePct: 0.001, slippagePct: 0.001, breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
        },
        signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
        maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
        symbolSlippage: SLIPPAGE_TIERS, symbolRisk, symbolMinConfidence,
        mtfSymbolCandles: c15, mtf4hSymbolCandles: c4,
        confidenceThresholdScale: config.risk?.confidenceThresholdScale,
        ...FULL_LIVE_FILTERS,
        btcDominance: { enabled: false },
        momentumMinPct: -1, mtfMinScore: 0, mtf4hMinScore: 0,
        tradeFromTs: fromTs,
      },
    ).run(c12);

    const replay = await replayEngine({
      symbolCandles: c12, mtf15mCandles: c15, mtf4hCandles: c4,
      fromTs, toTs, initialBalance: 1000, slippage: SLIPPAGE_TIERS, cfg,
    });

    const key = (t) => [t.symbol, t.entryTime, t.exitTime, t.reason, t.entryFillPrice, t.exitPrice, t.qty];
    const a = pb.trades.filter((t) => t.entryTime <= toTs).map(key);
    const b = replay.trades.map((t) => t.raw).filter((t) => t.entryTime <= toTs).map(key);
    assert.ok(a.length >= 3, `the fixture must trade, or the test proves nothing (${a.length} trades)`);
    assert.deepEqual(b, a);
  });
});

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

const H12 = 12 * 60 * 60 * 1000;
const H4 = 4 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2025, 0, 1);
const SYMBOLS = ['BTC/USDC', 'XRP/USDC', 'LINK/USDC', 'SOL/USDC', 'ADA/USDC', 'LTC/USDC'];
const BARS = 600;

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** 12h bars plus their 15m and 4h sub-bars; the trend swings with `period` bars. */
function market(seed, period) {
  const rnd = lcg(seed);
  const c12 = []; const c15 = []; const c4 = [];
  let price = 100;
  for (let g = 0; g < BARS; g++) {
    const drift = 0.005 * Math.sin((2 * Math.PI * g) / period);
    const open = price;
    const steps = 48;
    let p = open; let hi = open; let lo = open;
    const sub = [];
    for (let k = 0; k < steps; k++) {
      const o = p;
      p = o * (1 + drift + (rnd() - 0.5) * 0.025);
      const h = Math.max(o, p) * (1 + rnd() * 0.002);
      const l = Math.min(o, p) * (1 - rnd() * 0.002);
      sub.push({ timestamp: T0 + g * H12 + k * M15, open: o, high: h, low: l, close: p, volume: 10 + rnd() * 10 });
      hi = Math.max(hi, h); lo = Math.min(lo, l);
    }
    c15.push(...sub);
    for (let q = 0; q < 3; q++) {
      const part = sub.slice(q * 16, q * 16 + 16);
      c4.push({
        timestamp: T0 + g * H12 + q * H4, open: part[0].open, close: part.at(-1).close,
        high: Math.max(...part.map((x) => x.high)), low: Math.min(...part.map((x) => x.low)),
        volume: part.reduce((s, x) => s + x.volume, 0),
      });
    }
    c12.push({ timestamp: T0 + g * H12, open, high: hi, low: lo, close: p, volume: sub.reduce((s, x) => s + x.volume, 0) });
    price = p;
  }
  return { c12, c15, c4 };
}

describe('engine replay ≡ PortfolioBacktester', () => {
  test('identical trades on a fixed synthetic market', async () => {
    const m = Object.fromEntries(SYMBOLS.map((s, i) => [s, market(100 + i, 24 + i * 7)]));
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

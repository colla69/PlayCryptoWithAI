/**
 * Satellite strategies — signal, ranking, RSI, tier exit, sizing and entry plan.
 *
 * Live scenarios covered: a 4h breakout on a volume spike (and the near misses: no new
 * high, no spike, a close at the bottom of its range), the 7-day ranking that ignores a
 * frozen pair, a strongest-coin entry only inside the top N, hourly RSI that never reads
 * a part hour, the profit tiers, an entry refused for a stop that risks over 10%, and the
 * shared exit rules on single price ticks (how PaperTrader and LiveTrader call them).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  satelliteKey, satelliteKind, isSatelliteSymbol, isTrendUp, detectBreakout, rankByReturn,
  detectStrongest, hourlyRsiByClose, tierExitThreshold, shouldTierExit, satelliteOrderSize, planSatelliteEntry,
  stepSatellitePosition, satellitePositionPlan,
} from '../../src/engine/satellites.js';

const H4 = 4 * 3_600_000;
// Flat bars around 100 with a small range, then one last bar of our choosing.
function flatBars(n, { start = 0, step = H4, price = 100, volume = 10 } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: start + i * step, open: price, high: price + 1, low: price - 1, close: price, volume,
  }));
}

describe('satellites: keys', () => {
  test('satelliteKey / satelliteKind / isSatelliteSymbol', () => {
    assert.equal(satelliteKey('BTC/USDC', 'breakout'), 'BTC/USDC#bo');
    assert.equal(satelliteKey('ETH/USDC', 'strongest'), 'ETH/USDC#rs');
    assert.equal(satelliteKind('BTC/USDC#bo'), 'breakout');
    assert.equal(satelliteKind('BTC/USDC#rs'), 'strongest');
    assert.equal(satelliteKind('BTC/USDC#core'), null);
    assert.equal(isSatelliteSymbol('BTC/USDC'), false);
  });
});

describe('satellites: isTrendUp', () => {
  test('a steady rise is an uptrend; a fall is not; short history is not', () => {
    const up = Array.from({ length: 260 }, (_, i) => ({ close: 100 + i }));
    const down = Array.from({ length: 260 }, (_, i) => ({ close: 400 - i }));
    assert.equal(isTrendUp(up), true);
    assert.equal(isTrendUp(down), false);
    assert.equal(isTrendUp(up.slice(0, 150)), false);
  });
});

describe('satellites: detectBreakout', () => {
  const base = flatBars(60);
  test('a close above the 48-bar high on 2× volume, near its high → signal, stop 1.5 ATR under', () => {
    const bars = [...base, { timestamp: 60 * H4, open: 100, high: 104, low: 99.5, close: 103.8, volume: 20 }];
    const s = detectBreakout(bars);
    assert.ok(s);
    assert.equal(s.level, 101);
    assert.ok(s.stopPrice < 103.8 && s.stopPrice > 95);
  });
  test('no new high → null', () => {
    const bars = [...base, { timestamp: 60 * H4, open: 100, high: 101, low: 99, close: 100.5, volume: 20 }];
    assert.equal(detectBreakout(bars), null);
  });
  test('no volume spike → null', () => {
    const bars = [...base, { timestamp: 60 * H4, open: 100, high: 104, low: 99.5, close: 103.8, volume: 12 }];
    assert.equal(detectBreakout(bars), null);
  });
  test('a close in the bottom of its range → null', () => {
    const bars = [...base, { timestamp: 60 * H4, open: 100, high: 110, low: 99, close: 102, volume: 20 }];
    assert.equal(detectBreakout(bars), null);
  });
});

describe('satellites: rankByReturn and detectStrongest', () => {
  test('ranks by return; a series whose newest bar is old does not rank', () => {
    const mk = (end, n = 20) => Array.from({ length: n }, (_, i) => ({ timestamp: i, close: 100 + (end - 100) * (i / (n - 1)) }));
    const frozen = mk(500).slice(0, 15); // newest bar older than the others
    const ranks = rankByReturn({ A: mk(150), B: mk(120), C: mk(90), F: frozen }, 14);
    assert.equal(ranks.get('A'), 1);
    assert.equal(ranks.get('B'), 2);
    assert.equal(ranks.get('C'), 3);
    assert.equal(ranks.has('F'), false);
  });
  test('a new 24-bar high enters only inside the top N', () => {
    const bars = [...flatBars(30), { timestamp: 30 * H4, open: 100, high: 103, low: 99.8, close: 102.5, volume: 10 }];
    assert.ok(detectStrongest(bars, 2, { topN: 3 }));
    assert.equal(detectStrongest(bars, 4, { topN: 3 }), null);
  });
});

describe('satellites: hourlyRsiByClose', () => {
  test('one value per complete hour, keyed by the hour close; a part hour is left out', () => {
    const bars = [];
    for (let i = 0; i < 4 * 20 + 2; i++) bars.push({ timestamp: i * 900_000, close: 100 + (i % 7) });
    const rsi = hourlyRsiByClose(bars, 14);
    const keys = [...rsi.keys()];
    assert.equal(keys.at(-1), 20 * 3_600_000); // hour 19 closes at 20:00; the two bars of hour 20 are a part hour
    assert.equal(keys.length, 20 - 14);
    for (const v of rsi.values()) assert.ok(v >= 0 && v <= 100);
  });
});

describe('satellites: tiered exit', () => {
  const tiers = [{ minProfit: 0.01, rsiBelow: 35 }, { minProfit: 0.02, rsiBelow: 45 }, { minProfit: 0.04, rsiBelow: 55 }];
  test('the level loosens as profit grows', () => {
    assert.equal(tierExitThreshold(0.005, tiers), null);
    assert.equal(tierExitThreshold(0.015, tiers), 35);
    assert.equal(tierExitThreshold(0.03, tiers), 45);
    assert.equal(tierExitThreshold(0.08, tiers), 55);
  });
  test('exit only under the tier level', () => {
    assert.equal(shouldTierExit({ profitPct: 0.03, rsi: 44, tiers }), true);
    assert.equal(shouldTierExit({ profitPct: 0.03, rsi: 46, tiers }), false);
    assert.equal(shouldTierExit({ profitPct: 0.005, rsi: 10, tiers }), false);
    assert.equal(shouldTierExit({ profitPct: 0.03, rsi: 40, tiers: null }), false);
  });
});

describe('satellites: sizing and entry plan', () => {
  const kindCfg = { limitOffsetPct: 0.005, entryValidMs: H4, maxStopPct: 0.10, perTradePct: 0.125, breakEvenAtR: 1, targetR: null, timeLimitMs: 48 * 3_600_000, tiers: null };
  test('12.5% of equity, capped at free cash, null under the $11 floor', () => {
    assert.equal(satelliteOrderSize({ equity: 1000, freeBalance: 500, perTradePct: 0.125 }), 125);
    assert.equal(satelliteOrderSize({ equity: 1000, freeBalance: 60, perTradePct: 0.125 }), 60);
    assert.equal(satelliteOrderSize({ equity: 80, freeBalance: 80, perTradePct: 0.125 }), null);
  });
  test('a limit 0.5% under the reference, resting one bar', () => {
    const p = planSatelliteEntry({ signal: { stopPrice: 97 }, refPrice: 100, kindCfg, equity: 1000, freeBalance: 1000, now: 0 });
    assert.equal(p.limitPrice, 99.5);
    assert.equal(p.validUntil, H4);
    assert.equal(p.sizeUsd, 125);
    assert.equal(p.plan.timeLimitMs, 48 * 3_600_000);
  });
  test('refused: stop over 10% under the limit, or not under it', () => {
    assert.equal(planSatelliteEntry({ signal: { stopPrice: 85 }, refPrice: 100, kindCfg, equity: 1000, freeBalance: 1000, now: 0 }).refused, 'stop too far');
    assert.equal(planSatelliteEntry({ signal: { stopPrice: 99.5 }, refPrice: 100, kindCfg, equity: 1000, freeBalance: 1000, now: 0 }).refused, 'stop not under the limit');
  });
});

describe('satellites: stepSatellitePosition on price ticks', () => {
  const tick = (t, p, extra = {}) => ({ t, open: p, low: p, high: p, close: p, ...extra });
  const fresh = (plan = {}) => ({ entryPrice: 100, ...satellitePositionPlan({ fillPrice: 100, stopPrice: 97, plan: { breakEvenAtR: 1, targetR: null, timeLimitMs: 48 * 3_600_000, ...plan }, filledAt: 0 }) });
  test('the plan from the fill: R = 3, break-even at 103, no target, 48 h limit', () => {
    const p = fresh();
    assert.equal(p.breakEvenAt, 103);
    assert.equal(p.takeProfit, Infinity);
    assert.equal(p.timeLimitAt, 48 * 3_600_000);
  });
  test('a tick under the stop exits at that tick price', () => {
    assert.deepEqual(stepSatellitePosition(fresh(), tick(1, 96.5)), { reason: 'sat_stop', price: 96.5 });
  });
  test('after +1R the stop is at entry: a fall back exits as break-even', () => {
    const p = fresh();
    assert.equal(stepSatellitePosition(p, tick(1, 103.2)), null);
    assert.equal(p.stopLoss, 100);
    assert.equal(stepSatellitePosition(p, tick(2, 99.9)).reason, 'sat_breakeven');
  });
  test('the target with a 2R plan, the time limit, and a tier exit at the next tick', () => {
    assert.equal(stepSatellitePosition(fresh({ targetR: 2 }), tick(1, 106.1)).reason, 'sat_target');
    assert.equal(stepSatellitePosition(fresh(), tick(48 * 3_600_000, 101)).reason, 'sat_time');
    const p = fresh({ tiers: [{ minProfit: 0.01, rsiBelow: 35 }] });
    assert.equal(stepSatellitePosition(p, tick(1, 101.5, { rsi: 30, hourClosed: true })), null);
    assert.deepEqual(stepSatellitePosition(p, tick(2, 101.4)), { reason: 'sat_tier', price: 101.4 });
  });
});

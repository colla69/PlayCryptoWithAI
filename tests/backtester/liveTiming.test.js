/**
 * The backtester meets prices when live does (follow-ups items 1, 2, 4 and 8).
 *
 * Live decides at the cycle on bar T's open from bars closed by T and fills seconds
 * later, so a fill is at the open of bar T, not of bar T + 1. Between cycles its
 * 2-minute risk loop meets every price, so stops and targets act inside the bar,
 * through the shared helpers in traderUtils.js. Found by the 2026-10 live
 * reconciliation: INJ stopped at break-even live (−0.1%) and at the next 12h close in
 * the backtest (−13.7%); LDO took its +12.7% target live and never did in the backtest.
 *
 * Decisions come from stub strategies that read a per-bar schedule.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PortfolioBacktester } from '../../src/backtester/portfolioBacktester.js';

const H12 = 12 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1);
const ts = (g) => T0 + g * H12;
const RISK = { initialBalance: 1000, stopLossPct: 0.05, takeProfitPct: 0.10, feePct: 0, slippagePct: 0, minNotional: 0 };

class ScheduleStrategy {
  constructor(entries = []) {
    this.schedule = new Map(entries.map(([g, signal, confidence]) => [ts(g), { signal, confidence }]));
  }

  analyze(rows) {
    const hit = this.schedule.get(rows.at(-1).timestamp);
    return { name: 'Schedule', signal: hit?.signal ?? 'HOLD', confidence: hit?.confidence ?? 0, reason: 'schedule' };
  }
}

/** Flat 12h bars at 100, except `overrides[g] = { open, high, low, close }`. */
function bars12h(n, overrides = {}) {
  return Array.from({ length: n }, (_, g) => ({
    timestamp: ts(g), open: 100, high: 100, low: 100, close: 100, volume: 100, ...(overrides[g] ?? {}),
  }));
}

/** 48 flat 15m bars at the 12h bar's open per bar, except `path[g] = [[k, {o,h,l,c}], ...]`. */
function bars15m(twelve, path = {}) {
  const out = [];
  for (let g = 0; g < twelve.length; g++) {
    const marks = new Map(path[g] ?? []);
    for (let k = 0; k < 48; k++) {
      const p = twelve[g].open;
      out.push({ timestamp: ts(g) + k * M15, open: p, high: p, low: p, close: p, volume: 1, ...(marks.get(k) ?? {}) });
    }
  }
  return out;
}

function run({ c12, c15, schedule, risk = RISK, config = {} }) {
  const strategies = { 'AAA/USDC': schedule.map((entries) => new ScheduleStrategy(entries)) };
  return new PortfolioBacktester(strategies, {
    maxOpenPositions: 2,
    risk,
    signals: { minConfidence: 0.45 },
    mtfSymbolCandles: c15 ? { 'AAA/USDC': c15 } : {},
    ...config,
  }).run({ 'AAA/USDC': c12 });
}

describe('fills at the cycle (item 1)', () => {
  test('a BUY and a SELL fill at the open of the bar whose cycle decided them', () => {
    const c12 = bars12h(200, { 100: { open: 101, close: 120 }, 101: { open: 120 }, 150: { open: 103, close: 90 } });
    const r = run({ c12, schedule: [[[100, 'BUY', 1], [150, 'SELL', 1]]], risk: { ...RISK, stopLossPct: 0.5, takeProfitPct: 5 } });
    assert.equal(r.trades.length, 1);
    const [t] = r.trades;
    assert.equal(t.entryTime, ts(100));
    assert.equal(t.entryFillPrice, 101, 'the open of bar 100, not of bar 101 (120)');
    assert.equal(t.exitTime, ts(150));
    assert.equal(t.exitPrice, 103, 'the open of bar 150, not its close (90)');
  });
});

describe('stops inside the bar (item 4)', () => {
  const schedule = [[[100, 'BUY', 1], [190, 'SELL', 1]]];

  test('a stop crossed inside the period fills at the stop, at that 15m bar', () => {
    const c12 = bars12h(200);
    const c15 = bars15m(c12, { 101: [[20, { low: 94 }]] }); // the 12h close never moves
    const r = run({ c12, c15, schedule });
    const [t] = r.trades;
    assert.equal(t.reason, 'stop_loss');
    assert.equal(t.exitPrice, 95);
    assert.equal(t.exitTime, ts(101) + 20 * M15);
  });

  test('a gap through the stop fills at the open', () => {
    const c12 = bars12h(200);
    const c15 = bars15m(c12, { 101: [[20, { open: 90, high: 90, low: 89, close: 90 }]] });
    const [t] = run({ c12, c15, schedule }).trades;
    assert.equal(t.reason, 'stop_loss');
    assert.equal(t.exitPrice, 90);
  });

  test('when one 15m bar touches both, the stop counts first', () => {
    const c12 = bars12h(200);
    const c15 = bars15m(c12, { 101: [[5, { low: 94, high: 120 }]] });
    const [t] = run({ c12, c15, schedule }).trades;
    assert.equal(t.reason, 'stop_loss');
    assert.equal(t.exitPrice, 95);
  });

  test('a target reached inside the period fills at the target', () => {
    const c12 = bars12h(200);
    const c15 = bars15m(c12, { 102: [[30, { high: 112 }]] });
    const [t] = run({ c12, c15, schedule }).trades;
    assert.equal(t.reason, 'take_profit');
    assert.equal(t.exitPrice, 110);
  });

  test('break-even locks at +5% inside the bar, then exits at entry + fees', () => {
    const c12 = bars12h(200);
    const c15 = bars15m(c12, { 101: [[10, { high: 106 }], [30, { low: 98 }]] });
    const [t] = run({ c12, c15, schedule, config: { breakEvenTriggerPct: 0.05 } }).trades;
    assert.equal(t.reason, 'stop_loss');
    assert.equal(t.exitPrice, 100.2, 'live locks the stop at entry × 1.002');
  });

  test('break-even measures from the fill without the fee, as live does', () => {
    // Fee 0.1%: the simulator's entryPrice is 100.1, but live's entryPrice is the market
    // fill, 100, so its break-even sits at 100.2, not 100.1 × 1.002 = 100.3002.
    // From bar 101 the price holds at 106 (break-even locks), with one dip to 100.25.
    const later = Object.fromEntries(Array.from({ length: 99 }, (_, k) => [101 + k, { open: 106, high: 106, low: 106, close: 106 }]));
    const c12 = bars12h(200, later);
    const c15 = bars15m(c12, { 101: [[30, { low: 100.25 }]] });
    const r = run({ c12, c15, schedule, risk: { ...RISK, feePct: 0.001 }, config: { breakEvenTriggerPct: 0.05 } });
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].reason, 'strategy_sell', 'a dip to 100.25 must not stop out a lock at 100.2');
    assert.equal(r.trades[0].exitTime, ts(190));
  });

  test('without 15m data the 12h bar itself is replayed', () => {
    const c12 = bars12h(200, { 101: { low: 94 } });
    const [t] = run({ c12, schedule }).trades;
    assert.equal(t.reason, 'stop_loss');
    assert.equal(t.exitPrice, 95);
    assert.equal(t.exitTime, ts(101));
  });
});

describe('equity marks every open position (item 2)', () => {
  test('two positions both 10% down are both in the equity point', () => {
    const c12 = Array.from({ length: 200 }, (_, g) => ({
      timestamp: ts(g), open: g > 110 ? 90 : 100, high: 100, low: 90, close: g >= 110 ? 90 : 100, volume: 100,
    }));
    const strategies = {
      'AAA/USDC': [new ScheduleStrategy([[100, 'BUY', 1]])],
      'BBB/USDC': [new ScheduleStrategy([[100, 'BUY', 1]])],
    };
    const r = new PortfolioBacktester(strategies, {
      maxOpenPositions: 2, risk: { ...RISK, stopLossPct: 0.5, takeProfitPct: 5 }, signals: { minConfidence: 0.45 },
    }).run({ 'AAA/USDC': c12, 'BBB/USDC': c12.map((c) => ({ ...c })) });
    // Sizing takes half the FREE balance: 500, then 250. Both marked at 90 lose 10% of
    // 750 → 925. The old curve valued one of them at entry, so it never showed 925.
    assert.equal(r.finalBalance, 925);
    const last = r.equityCurve.at(-1);
    assert.equal(last.balance, 925);
    assert.equal(r.equityCurve.filter((p) => p.timestamp === last.timestamp).length, 1, 'one point per step');
  });
});

describe('asymmetric exit (item 8)', () => {
  test('a held symbol with a SELL majority exits at 0.7× its entry threshold', () => {
    // Two SELL votes at 0.6 and one HOLD: confidence 0.4 < 0.45 → the aggregator says HOLD,
    // but 0.4 ≥ 0.7 × 0.45 = 0.315 and SELL is the majority → live sells.
    const c12 = bars12h(200);
    const r = run({
      c12,
      schedule: [
        [[100, 'BUY', 1], [120, 'SELL', 0.6]],
        [[100, 'BUY', 1], [120, 'SELL', 0.6]],
        [[100, 'BUY', 1]],
      ],
      risk: { ...RISK, stopLossPct: 0.5, takeProfitPct: 5 },
    });
    assert.deepEqual(r.trades.map((t) => [t.exitTime, t.reason]), [[ts(120), 'strategy_sell']]);
    assert.equal(r.filtersApplied.asymmetricExit, 1);
  });

  test('without a position the lowered bar does nothing', () => {
    const c12 = bars12h(200);
    const r = run({ c12, schedule: [[[120, 'SELL', 0.6]], [[120, 'SELL', 0.6]], []] });
    assert.equal(r.trades.length, 0);
    assert.equal(r.filtersApplied.asymmetricExit ?? 0, 0);
  });
});

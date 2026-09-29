/**
 * PortfolioBacktester steps by timestamp, not by array index.
 *
 * run() used to read every symbol's precomputed row at the same array index
 * (`allData[sym][step]`) while the regime and macro gates read BTC at that index.
 * A symbol listed later than BTC, or with a hole in its history, was therefore
 * traded against a different date from the rest of the portfolio: in the deep
 * 2020 → 2026 data 34 of 37 symbols were misaligned, and at BTC-time 2021-01-01
 * the engine traded NEAR's 2024-07-13 bar. Slots, regime, macro, weekly DD and
 * the equity curve all mixed bars from different times. Live evaluates every
 * symbol at the same candle close; the engine now does too.
 *
 * Two one-sided rules found alongside it are covered here too: the correlation
 * cap's matrix (a static first-half-of-history matrix instead of live's trailing
 * window) and the weekly DD breaker (never fired on simulator trades).
 *
 * Decisions come from a stub strategy that reads a per-symbol timestamp
 * schedule, so each test controls exactly when a symbol signals.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PortfolioBacktester } from '../../src/backtester/portfolioBacktester.js';
import { mtf4hMomentumScore, buildMtf4hIndex } from '../../src/utils/mtfAlignment.js';
import config from '../../config/default.js';

const H12 = 12 * 60 * 60 * 1000;
const H4 = 4 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1);
// g = bar index on the one wall-clock grid every symbol shares
const ts = (g) => T0 + g * H12;

// Wide stops so only the schedule closes positions, unless a test says otherwise.
const RISK = { initialBalance: 1000, stopLossPct: 0.5, takeProfitPct: 5, feePct: 0.001, slippagePct: 0 };

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 12h candles for grid bars [from, to), skipping `holes`; priceAt(g) is the close. */
function candles(from, to, priceAt, holes = new Set()) {
  const out = [];
  for (let g = from; g < to; g++) {
    if (holes.has(g)) continue;
    const close = priceAt(g);
    const open = g > from ? priceAt(g - 1) : close;
    out.push({
      timestamp: ts(g),
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 100,
    });
  }
  return out;
}

/** Sub-bars (4h or 15m) inside each 12h candle, walking open → close. */
function subCandles(twelveH, stepMs, closeAt = null) {
  const out = [];
  const n = H12 / stepMs;
  for (const c of twelveH) {
    let prev = c.open;
    for (let k = 0; k < n; k++) {
      const t = c.timestamp + k * stepMs;
      const close = closeAt ? closeAt(t, c, k) : c.open + ((c.close - c.open) * (k + 1)) / n;
      out.push({ timestamp: t, open: prev, high: Math.max(prev, close), low: Math.min(prev, close), close, volume: 10 });
      prev = close;
    }
  }
  return out;
}

class ScheduleStrategy {
  constructor(entries = []) {
    this.schedule = new Map(entries.map(([g, signal, confidence]) => [ts(g), { signal, confidence }]));
  }

  // Keyed on the row's own bar, so a schedule reads in grid time.
  analyze(rows) {
    const hit = this.schedule.get(rows.at(-1).timestamp);
    return { name: 'Schedule', signal: hit?.signal ?? 'HOLD', confidence: hit?.confidence ?? 0, reason: 'schedule' };
  }
}

const strategiesFor = (schedules) => Object.fromEntries(
  Object.entries(schedules).map(([sym, entries]) => [sym, [new ScheduleStrategy(entries)]]),
);

const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// BTC rises for 400 bars, then falls: bull + BULL_TREND at bar 260, bear + BEAR_TREND by bar 450.
const btcPath = (g) => (g < 400 ? 100 + 0.75 * g : 400 - 1.5 * (g - 400));
const flat = () => 100;

describe('PortfolioBacktester time alignment', () => {
  test('a later-listed symbol competes for slots at the same wall-clock time', () => {
    // Both BUY at bar 200; AAA has the higher confidence and must take the only slot.
    // Stepping by index put BBB's bar 200 sixty steps earlier, so BBB took the slot alone.
    const data = { 'AAA/USDC': candles(0, 300, flat), 'BBB/USDC': candles(60, 300, flat) };
    const strategies = strategiesFor({
      'AAA/USDC': [[200, 'BUY', 0.9], [280, 'SELL', 0.9]],
      'BBB/USDC': [[200, 'BUY', 0.8], [280, 'SELL', 0.9]],
    });
    const r = new PortfolioBacktester(strategies, { maxOpenPositions: 1, risk: RISK }).run(data);
    assert.deepEqual(
      r.trades.map((t) => [t.symbol, t.entryTime, t.exitTime]),
      [['AAA/USDC', ts(200), ts(280)]],
    );
  });

  test('the equity curve is in time order when symbols start late or have holes', () => {
    const holes = new Set(Array.from({ length: 50 }, (_, k) => 150 + k));
    const data = {
      'BTC/USDC': candles(0, 300, flat),
      'LATE/USDC': candles(100, 300, flat),
      'GAP/USDC': candles(0, 300, flat, holes),
    };
    const strategies = strategiesFor({
      'BTC/USDC': [[80, 'BUY', 0.9], [240, 'SELL', 0.9]],
      'LATE/USDC': [[170, 'BUY', 0.9], [260, 'SELL', 0.9]],
      'GAP/USDC': [[220, 'BUY', 0.9], [250, 'SELL', 0.9]],
    });
    const r = new PortfolioBacktester(strategies, { maxOpenPositions: 4, risk: RISK }).run(data);
    const times = r.equityCurve.map((p) => p.timestamp);
    const backwards = times.findIndex((t, i) => i > 0 && t < times[i - 1]);
    assert.equal(backwards, -1, `equity curve steps back in time at point ${backwards}`);
    assert.deepEqual(
      r.trades.map((t) => [t.symbol, t.entryTime, t.exitTime]).sort(),
      [
        ['BTC/USDC', ts(80), ts(240)],
        ['GAP/USDC', ts(220), ts(250)],
        ['LATE/USDC', ts(170), ts(260)],
      ],
    );
  });

  test('the macro filter reads BTC at the signal time, not at the same array index', () => {
    // LATE buys at bar 560, when BTC is below its EMA200. By index, LATE's bar 560 was
    // matched with BTC's bar 260 (bull), so the entry was never halved.
    const data = { 'BTC/USDC': candles(0, 600, btcPath), 'LATE/USDC': candles(300, 600, flat) };
    const schedules = { 'BTC/USDC': [], 'LATE/USDC': [[560, 'BUY', 1.0], [580, 'SELL', 1.0]] };
    const run = (macroFilter) => new PortfolioBacktester(
      strategiesFor(schedules),
      { maxOpenPositions: 4, risk: RISK, macroFilter, macroEMAPeriod: 200, macroSizeReduceFactor: 0.5 },
    ).run(data);
    const [withMacro] = run(true).trades;
    const [without] = run(false).trades;
    assert.equal(withMacro.entryTime, ts(560));
    assert.ok(
      Math.abs(withMacro.costBasis / without.costBasis - 0.5) < 0.01,
      `bear-time entry must be halved: ${withMacro.costBasis} vs ${without.costBasis}`,
    );
  });

  test('the BTC regime label is read at the signal time, not at the same array index', () => {
    const data = { 'BTC/USDC': candles(0, 600, btcPath), 'LATE/USDC': candles(300, 600, flat) };
    const strategies = strategiesFor({ 'BTC/USDC': [], 'LATE/USDC': [[560, 'BUY', 1.0], [580, 'SELL', 1.0]] });
    const r = new PortfolioBacktester(strategies, {
      maxOpenPositions: 4,
      risk: RISK,
      skipBearTrendEntries: true,
      regimeClassifier: config.regimeClassifier,
    }).run(data);
    assert.equal(r.trades.length, 0, 'a BUY in BTC BEAR_TREND must be skipped');
    assert.equal(r.filtersApplied.bearTrendSkip, 1);
  });

  test("the 4h filter reads the symbol's own 4h bars at the signal time", () => {
    // LATE's 4h closes fall hard through 12h bars 190–200 and rise everywhere else,
    // so the BUY at 200 must be filtered and the BUY at 260 must pass.
    const late12h = candles(100, 400, flat);
    const inDip = (t) => t >= ts(190) && t < ts(201);
    const late4h = subCandles(late12h, H4, (t) => (inDip(t) ? 100 - (t - ts(190)) / H4 : 100 + (t - ts(100)) / H4 * 0.05));
    const idx = buildMtf4hIndex(late12h, late4h);
    const scoreAt = (g) => mtf4hMomentumScore(late4h, idx[g - 100], 21);
    assert.ok(scoreAt(200) < 0.45 && scoreAt(260) >= 0.45, 'fixture: dip at 200, recovered by 260');

    const data = { 'BTC/USDC': candles(0, 400, flat), 'LATE/USDC': late12h };
    const strategies = strategiesFor({
      'BTC/USDC': [],
      'LATE/USDC': [[200, 'BUY', 1.0], [210, 'SELL', 1.0], [260, 'BUY', 1.0], [280, 'SELL', 1.0]],
    });
    const r = new PortfolioBacktester(strategies, {
      maxOpenPositions: 4,
      risk: RISK,
      mtf4hFilter: true,
      mtf4hMinScore: 0.45,
      mtf4hLookback: 21,
      mtf4hSymbolCandles: { 'LATE/USDC': late4h },
    }).run(data);
    assert.deepEqual(r.trades.map((t) => [t.symbol, t.entryTime]), [['LATE/USDC', ts(260)]]);
    assert.equal(r.filtersApplied.mtf4h, 1);
  });

  test("the 15m filter and early exit read the symbol's own 15m bars at the signal time", () => {
    // LATE's 15m candles are green except through 12h bars 200 and 240. The BUY at 200 must
    // be filtered, the BUY at 210 must fill, and the 5%-losing position must exit early at
    // 240. On an aligned run step === row index, so only a late-listed symbol shows a
    // leftover `step + MIN_WARMUP` in either 15m path.
    const late12h = candles(100, 400, (g) => (g < 230 ? 100 : 95));
    const red = (t) => (t >= ts(200) && t < ts(201)) || (t >= ts(240) && t < ts(241));
    let level = 100;
    const late15m = subCandles(late12h, M15, (t) => (level += red(t) ? -0.01 : 0.01));

    const data = { 'BTC/USDC': candles(0, 400, flat), 'LATE/USDC': late12h };
    const strategies = strategiesFor({
      'BTC/USDC': [],
      'LATE/USDC': [[200, 'BUY', 1.0], [210, 'BUY', 1.0], [280, 'SELL', 1.0]],
    });
    const r = new PortfolioBacktester(strategies, {
      maxOpenPositions: 4,
      risk: RISK,
      mtfFilter: true,
      mtfEarlyExit: true,
      mtfSymbolCandles: { 'LATE/USDC': late15m },
    }).run(data);
    assert.deepEqual(r.trades.map((t) => [t.symbol, t.entryTime, t.exitTime]), [['LATE/USDC', ts(210), ts(240)]]);
    assert.equal(r.filtersApplied.mtf, 1);
    assert.equal(r.filtersApplied.mtfEarlyExit, 1);
  });

  describe('correlation cap reads a trailing window as of the signal time', () => {
    // AAA is a random walk. BBB copies AAA's bar-to-bar moves (r = 1) on the bars where
    // `lockstep(g)` holds and walks independently elsewhere. AAA is open when BBB signals
    // at bar 280, so the cap decides BBB's entry. Live rebuilds the matrix every cycle from
    // the last `correlation.period` bars; the old static matrix used the first half of each
    // symbol's history instead, i.e. the wrong period for every signal in this test.
    const pair = (lockstep) => {
      const a = lcg(7);
      const b = lcg(8);
      const aaa = [100];
      const bbb = [100];
      for (let g = 1; g < 300; g++) {
        aaa.push(aaa[g - 1] * Math.exp(0.06 * (a() - 0.5)));
        bbb.push(lockstep(g) ? bbb[g - 1] * (aaa[g] / aaa[g - 1]) : bbb[g - 1] * Math.exp(0.06 * (b() - 0.5)));
      }
      return { 'AAA/USDC': candles(0, 300, (g) => aaa[g]), 'BBB/USDC': candles(0, 300, (g) => bbb[g]) };
    };
    const run = (data) => new PortfolioBacktester(
      strategiesFor({
        'AAA/USDC': [[270, 'BUY', 1.0], [295, 'SELL', 1.0]],
        'BBB/USDC': [[280, 'BUY', 0.9], [290, 'SELL', 0.9]],
      }),
      { maxOpenPositions: 4, risk: RISK, correlationFilter: true, correlationThreshold: 0.85, correlationPeriod: 60 },
    ).run(data);

    test('blocks an entry that moves in lockstep with an open position now', () => {
      const r = run(pair((g) => g >= 200));
      assert.deepEqual(r.trades.map((t) => t.symbol), ['AAA/USDC']);
      assert.equal(r.filtersApplied.correlation, 1);
    });

    test('allows an entry that was correlated only in the distant past', () => {
      const r = run(pair((g) => g < 150));
      assert.deepEqual(r.trades.map((t) => t.symbol).sort(), ['AAA/USDC', 'BBB/USDC']);
      assert.equal(r.filtersApplied.correlation, 0);
    });
  });

  test('the weekly DD breaker counts simulator trades', () => {
    // calcWeeklyDDBreaker reads live's trade log: SELL records keyed by `timestamp`.
    // Simulator trades are round trips (side 'LONG', exitTime) and were all filtered
    // out, so the backtest breaker never fired. AAA loses ~10% of the book by bar 112;
    // BBB's BUY two bars later falls inside the 72h cooldown, its BUY at 130 does not.
    const data = {
      'AAA/USDC': candles(0, 200, (g) => (g <= 110 ? 100 : 90)),
      'BBB/USDC': candles(0, 200, flat),
    };
    const strategies = strategiesFor({
      'AAA/USDC': [[100, 'BUY', 1.0], [112, 'SELL', 1.0]],
      'BBB/USDC': [[114, 'BUY', 1.0], [130, 'BUY', 1.0], [140, 'SELL', 1.0]],
    });
    const r = new PortfolioBacktester(strategies, {
      maxOpenPositions: 1,
      risk: { ...RISK, weeklyDDBreaker: { enabled: true, lossThreshold: 0.05, cooldownHours: 72 } },
    }).run(data);
    assert.deepEqual(
      r.trades.map((t) => [t.symbol, t.entryTime, t.exitTime]),
      [['AAA/USDC', ts(100), ts(112)], ['BBB/USDC', ts(130), ts(140)]],
    );
    assert.equal(r.filtersApplied.weeklyDDBreaker, 1);
  });

  test('aligned inputs give the same result as index stepping did (golden)', () => {
    // Every symbol shares one grid, so the fix must be an identity here. Expected
    // values were produced by the index-stepping engine (e6d269d) on this scenario,
    // which exercises the per-step gates: slots, swap, macro, regime + bear policy
    // (block and cash exit), aging, MTF 15m/4h filters and early exit, and
    // ATR/Kelly/confidence/ADX sizing.
    const symbols = ['BTC/USDC', 'AAA/USDC', 'BBB/USDC', 'CCC/USDC'];
    const data = {};
    const mtf15m = {};
    const mtf4h = {};
    const schedules = {};
    symbols.forEach((sym, n) => {
      const rnd = lcg(1000 + n);
      const path = [];
      for (let g = 0; g < 600; g++) {
        const prev = path[g - 1] ?? 100;
        path.push(sym === 'BTC/USDC'
          ? btcPath(g) * (1 + 0.01 * (rnd() - 0.5))
          : prev * Math.exp(0.06 * (rnd() - 0.5)));
      }
      data[sym] = candles(0, 600, (g) => path[g]);
      const noise = lcg(2000 + n);
      mtf15m[sym] = subCandles(data[sym], M15, (t, c, k) => c.open + ((c.close - c.open) * (k + 1)) / 48 + c.close * 0.004 * (noise() - 0.5));
      mtf4h[sym] = subCandles(data[sym], H4, (t, c, k) => c.open + ((c.close - c.open) * (k + 1)) / 3 + c.close * 0.01 * (noise() - 0.5));
      const pick = lcg(3000 + n);
      schedules[sym] = [];
      for (let g = 50; g < 600; g++) {
        const r = pick();
        if (r < 0.12) schedules[sym].push([g, 'BUY', 0.6 + 0.1 * Math.floor(pick() * 5)]);
        else if (r < 0.16) schedules[sym].push([g, 'SELL', 0.8]);
      }
    });

    const r = new PortfolioBacktester(strategiesFor(schedules), {
      maxOpenPositions: 2,
      swapEnabled: true,
      swapMinConfidence: 0.9,
      swapMinHoldBars: 3,
      atrPositionSizing: true,
      kellyEnabled: true,
      kellyWindow: 10,
      confSizing: true,
      regimeSizing: true,
      macroFilter: true,
      momentumMinPct: -0.2,
      breakEvenTriggerPct: 0.05,
      mtfFilter: true,
      mtfEarlyExit: true,
      mtfSymbolCandles: mtf15m,
      mtf4hFilter: true,
      mtf4hMinScore: 0.45,
      mtf4hSymbolCandles: mtf4h,
      regimeClassifier: config.regimeClassifier,
      bearPolicy: { enabled: true },
      risk: {
        initialBalance: 1000,
        stopLossPct: 0.05,
        takeProfitPct: 0.12,
        feePct: 0.001,
        slippagePct: 0.001,
        positionAgingExit: { enabled: true, maxAgeBars: 14 },
      },
    }).run(data);

    const digest = {
      trades: r.trades.length,
      finalBalance: r.finalBalance,
      equityPoints: r.equityCurve.length,
      filtersApplied: r.filtersApplied,
      tradesSha: sha(r.trades),
      equitySha: sha(r.equityCurve),
    };
    assert.deepEqual(digest, GOLDEN);
  });
});

// Index-stepping engine at e6d269d on the aligned scenario above.
const GOLDEN = {
  trades: 40,
  finalBalance: 1273.14,
  equityPoints: 2273,
  filtersApplied: {
    regime: 0, volume: 0, fearGreed: 0, correlation: 0, mtfEarlyExit: 7, positionAging: 19,
    weeklyDDBreaker: 0, btcDominance: 0, bearPolicy: 67, bearCashExit: 1, minNotional: 0,
    mtf: 79, mtf4h: 23,
  },
  tradesSha: 'a655d531bffb373e',
  equitySha: '2a27a8313787fa0b',
};

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import config from '../../config/default.js';
import { replayEngine } from '../../src/backtester/engineReplay.js';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';

const H = 3_600_000;
const M15 = 900_000;
const T = Date.UTC(2026, 9, 25);
const SYMBOLS = ['AAA/USDC', 'BBB/USDC'];

function inputs({ satellites = true, core = false } = {}) {
  const c12 = Array.from({ length: 450 }, (_, k) => {
    const close = 103.8 * 1.002 ** (k - 449);
    return { timestamp: T - (449 - k) * 12 * H, open: close, high: close * 1.002, low: close * 0.998, close, volume: 100 };
  });
  const c4 = [
    ...Array.from({ length: 70 }, (_, k) => ({
      timestamp: T - (70 - k) * 4 * H,
      ...(k === 69
        ? { open: 100, high: 104, low: 99.5, close: 103.8, volume: 30 }
        : { open: 100, high: 101, low: 99, close: 100, volume: 10 }),
    })),
    ...Array.from({ length: 4 }, (_, k) => ({
      timestamp: T + k * 4 * H, open: 103.8, high: 103.8, low: 103.8, close: 103.8, volume: 10,
    })),
  ];
  const c15 = Array.from({ length: 48 }, (_, k) => ({
    timestamp: T + k * M15, open: 103.5, high: 103.6, low: k === 0 ? 103.1 : 103.4, close: 103.5, volume: 10,
  }));
  const each = (bars) => Object.fromEntries(SYMBOLS.map((s) => [s, bars.map((b) => ({ ...b }))]));
  return {
    symbolCandles: each(c12), mtf15mCandles: each(c15), mtf4hCandles: each(c4),
    fromTs: T, toTs: T, initialBalance: 1000,
    cfg: {
      ...config, symbols: SYMBOLS,
      risk: { ...config.risk, maxOpenPositions: 0 },
      btcDominance: { enabled: false },
      tsmCore: {
        ...config.tsmCore, enabled: core, equityLadder: [], symbols: [SYMBOLS[0]],
        lookbackBars: [1], enterVotes: 1, stayVotes: 1, deploymentPct: 0.5,
        volTarget: null, macroOverlay: { enabled: false }, impliedVol: { enabled: false },
      },
      satellites: {
        ...config.satellites, enabled: satellites, symbols: SYMBOLS,
        strongest: { ...config.satellites.strongest, enabled: false },
      },
    },
  };
}

describe('engine replay event time', () => {
  test('concurrent positions consume bars in time order, not one whole position at a time', async (t) => {
    const p = inputs();
    p.mtf15mCandles[SYMBOLS[0]][12].low = 90;
    p.mtf15mCandles[SYMBOLS[1]][4].low = 90;
    const timestamps = [];
    const original = BacktestSimulator.prototype.setTimestamp;
    t.mock.method(BacktestSimulator.prototype, 'setTimestamp', function (ts) {
      timestamps.push(Number(ts));
      return original.call(this, ts);
    });
    const r = await replayEngine(p);
    assert.equal(r.sim.satelliteStats.filled, 2, 'both concurrent positions must actually fill');
    assert.equal(r.trades.length, 2);
    assert.equal(r.trades[0].symbol, `${SYMBOLS[1]}#bo`, 'the earlier stop must be processed first');
    assert.equal(r.trades[1].symbol, `${SYMBOLS[0]}#bo`);
    assert.ok(timestamps.every((ts, i) => i === 0 || ts >= timestamps[i - 1]), 'the execution clock must never rewind');
  });

  test('core positions and equity use the same closed-bar price and observation timestamp', async () => {
    const p = inputs({ satellites: false, core: true });
    p.mtf15mCandles[SYMBOLS[0]][2] = {
      timestamp: T + 2 * M15, open: 103.5, low: 103.5, high: 120, close: 120, volume: 10,
    };
    const r = await replayEngine(p);
    const pos = r.sim.positions.get(`${SYMBOLS[0]}#core`);
    assert.ok(pos, 'the fixture must hold a core position');
    const peak = r.equity.find((e) => e.timestamp === T + 3 * M15);
    const final = r.equity.find((e) => e.timestamp === T + 12 * H);
    assert.ok(peak, 'the intrabar valuation must not disappear into a cycle-end sample');
    assert.ok(final);
    assert.ok(Math.abs(peak.balance - (r.sim.balance + pos.qty * 120)) < 0.01);
    assert.ok(Math.abs(final.balance - (r.sim.balance + pos.qty * 103.5)) < 0.01);
    assert.equal(pos.lastPrice, 103.5);
  });

  test('a deposit between signal cycles arrives at its own time and never beyond the replay interval', async () => {
    const p = inputs({ satellites: false });
    p.deposits = [{ ts: T + 7 * 60_000, amount: 100 }, { ts: T + 13 * H, amount: 900 }];
    const r = await replayEngine(p);
    assert.equal(r.sim.balance, 1100);
    assert.equal(r.equity.find((e) => e.timestamp === p.deposits[0].ts)?.balance, 1100);
    assert.ok(r.equity.every((e) => e.timestamp <= p.toTs + 12 * H));
  });
});

/**
 * Satellite orders in the backtest simulator — the order model of the satellite strategies.
 *
 * Live scenarios covered: a resting limit buy locks its cash (equity still counts it) and
 * frees it on expiry; a fill at the limit price, also under a lower open; a stop inside the fill bar;
 * the 2R target and the stop (both sold into the bid: fee + slippage), the break-even step,
 * the time limit, the RSI-tier exit at the next bar, and the scalper's risk check leaving
 * satellite positions alone.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BacktestSimulator } from '../../src/backtester/backtestSimulator.js';
import { calcEquityFromStatus } from '../../src/risk/portfolioRisk.js';

const M15 = 900_000;
const H = 3_600_000;
const T0 = 1_700_000_000_000 - (1_700_000_000_000 % H); // on an hour
const bar = (k, o, h, l, c) => ({ timestamp: T0 + k * M15, open: o, high: h, low: l, close: c });
const plan = (over = {}) => ({ breakEvenAtR: 1, targetR: 2, timeLimitMs: 48 * H, tiers: null, ...over });

function sim() {
  const s = new BacktestSimulator({ initialBalance: 1000, feePct: 0.001, slippagePct: 0.001 });
  s.setTimestamp(T0);
  return s;
}
const place = (s, over = {}) => s.placeSatelliteOrder('BTC/USDC#bo', {
  limitPrice: 99, validUntil: T0 + 4 * H, sizeUsd: 125, stopPrice: 96, plan: plan(), slippagePct: 0.001, ...over,
});

describe('satellite orders: resting limit', () => {
  test('placing locks the cash; equity still counts it; expiry frees it with no position', () => {
    const s = sim();
    assert.ok(place(s));
    const st = s.getStatus();
    assert.equal(st.balance, 875);
    assert.equal(st.reserved, 125);
    assert.equal(calcEquityFromStatus(st), 1000);
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(1, 100, 101, 99.5, 100.5)), null); // not down to 99
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(16, 100, 101, 98, 100)), null);     // at validUntil: expired
    assert.equal(s.getStatus().balance, 1000);
    assert.equal(s.positions.size, 0);
    assert.equal(s.satelliteStats.expired, 1);
  });

  test('fills at the limit, fee only — also when the bar opens below it', () => {
    const s = sim(); place(s);
    const f = s.replaySatelliteBar('BTC/USDC#bo', bar(1, 100, 100.2, 98.5, 99.8));
    assert.equal(f.side, 'BUY');
    assert.equal(f.entryPrice, 99);
    assert.equal(f.costBasis, 125); // the reserved $125 buys qty at 99 × (1 + fee)
    const s2 = sim(); place(s2);
    assert.equal(s2.replaySatelliteBar('BTC/USDC#bo', bar(1, 98, 99, 97.5, 98.5)).entryPrice, 99);
  });

  test('a stop inside the fill bar stops the trade at the stop', () => {
    const s = sim(); place(s);
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(1, 100, 100, 95, 97));
    assert.equal(t.reason, 'sat_stop');
    assert.equal(t.exitPrice, 96);
  });
});

describe('satellite orders: exits after the fill', () => {
  const filled = (over) => { const s = sim(); place(s, over); s.replaySatelliteBar('BTC/USDC#bo', bar(1, 100, 100, 98.9, 99.5)); return s; };

  test('2R target: sold into the bid, fee + slippage', () => {
    const s = filled();
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(2, 100, 106, 99.5, 105));
    assert.equal(t.reason, 'sat_target');
    assert.equal(t.exitPrice, 105); // 99 + 2 × 3
    assert.equal(t.exitFillPrice, Number((105 * 0.998).toFixed(8)));
  });

  test('stop: fee + slippage; a gap under it fills at the open', () => {
    const s = filled();
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(2, 95, 95.5, 94, 94.5));
    assert.equal(t.reason, 'sat_stop');
    assert.equal(t.exitPrice, 95);
    assert.equal(t.exitFillPrice, Number((95 * 0.998).toFixed(8)));
  });

  test('break-even after +1R: a fall back to entry exits there', () => {
    const s = filled();
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(2, 100, 102.5, 99.5, 102)), null); // high ≥ 99 + 3 = 102
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(3, 101, 101, 98, 98.5));
    assert.equal(t.reason, 'sat_breakeven');
    assert.equal(t.exitPrice, 99);
  });

  test('time limit: sold at the open of the first bar past it, fee + slippage', () => {
    const s = filled({ plan: plan({ timeLimitMs: 2 * H }) });
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(5, 100, 100.5, 99.5, 100)), null);
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(9, 100.3, 101, 100, 100.8));
    assert.equal(t.reason, 'sat_time');
    assert.equal(t.exitPrice, 100.3);
    assert.equal(t.exitFillPrice, Number((100.3 * 0.998).toFixed(8)));
  });

  test('tier exit: an hour close at +1.5% with RSI under 35 sells at the next open', () => {
    const tiers = [{ minProfit: 0.01, rsiBelow: 35 }];
    const s = filled({ plan: plan({ targetR: null, tiers }) });
    // bar 3 closes the first hour (its start + 15m is on the hour)
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(3, 100.4, 100.6, 100.2, 100.5), { rsi: 30 }), null);
    const t = s.replaySatelliteBar('BTC/USDC#bo', bar(4, 100.4, 100.7, 100.1, 100.6));
    assert.equal(t.reason, 'sat_tier');
    assert.equal(t.exitPrice, 100.4);
  });

  test('no tier exit under the first tier, or with RSI above the level', () => {
    const tiers = [{ minProfit: 0.01, rsiBelow: 35 }];
    const s = filled({ plan: plan({ targetR: null, tiers }) });
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(3, 99.5, 99.8, 99.2, 99.6), { rsi: 20 }), null);   // +0.6%
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(7, 100.4, 100.6, 100.2, 100.5), { rsi: 50 }), null); // RSI 50
    assert.equal(s.replaySatelliteBar('BTC/USDC#bo', bar(8, 100.4, 100.7, 100.1, 100.6)), null);
  });

  test("the scalper's risk check leaves satellite positions alone", () => {
    const s = filled();
    assert.equal(s.checkRisk('BTC/USDC#bo', 50), null);
    assert.ok(s.positions.has('BTC/USDC#bo'));
    assert.equal(s.getStatus().positions[0].isSatellite, true);
  });
});

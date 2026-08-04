/**
 * Core-sleeve wallet claims — regression tests.
 *
 * The wallet asset is fungible: free ETH may back BOTH a TSM core leg and a
 * scalper position on the same market. Every core leg must reserve its coins
 * before the scalper restore attributes the remainder.
 *
 * Live incident 2026-08-03: the reservation was skipped for core legs already
 * live in memory (the restore loop `continue`d on `positions.has(key)` before
 * reserving). The 5-minute balance poll then restored a phantom scalper
 * ETH/USDC position backed by the sleeve's own 0.0321 ETH — double-counting it
 * into equity ($188.79 real vs $235.36 believed, +25%), which resized the
 * sleeve up by $12.87 against capital that did not exist, and armed a stop-loss
 * that would have sold 78% of the core leg.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calcCoreClaims } from '../../src/executor/traderUtils.js';

const ONE_HOUR_AGO = new Date(Date.now() - 3_600_000).toISOString();

describe('calcCoreClaims — in-memory core legs (the 2026-08-03 regression)', () => {
  test('core leg live in memory reserves its coins', () => {
    const livePositions = new Map([
      ['ETH/USDC#core', { qty: 0.0321, entryPrice: 1872.95, isCore: true }],
    ]);
    const { claimsByBase } = calcCoreClaims({
      savedState: {},
      livePositions,
      freeBalances: { ETH: 0.0320695 },
    });
    // Clamped to what the wallet actually holds.
    assert.equal(claimsByBase.get('ETH'), 0.0320695);
  });

  test('scalper cannot claim the sleeve\'s coins — leftover is zero', () => {
    const livePositions = new Map([
      ['ETH/USDC#core', { qty: 0.0321, entryPrice: 1872.95, isCore: true }],
    ]);
    const freeEth = 0.0320695;
    const { claimsByBase } = calcCoreClaims({
      savedState: {},
      livePositions,
      freeBalances: { ETH: freeEth },
    });
    const leftoverForScalper = freeEth - (claimsByBase.get('ETH') ?? 0);
    assert.equal(
      leftoverForScalper,
      0,
      'the scalper restore must see nothing left — this is the phantom position bug',
    );
  });

  test('a live core leg is not re-restored, only reserved', () => {
    const livePositions = new Map([
      ['ETH/USDC#core', { qty: 0.0321, isCore: true }],
    ]);
    const { restorable, claimsByBase } = calcCoreClaims({
      savedState: {
        'ETH/USDC#core': {
          qty: 0.0321, entryPrice: 1872.95, isCore: true, openedAt: ONE_HOUR_AGO,
        },
      },
      livePositions,
      freeBalances: { ETH: 0.0320695 },
    });
    assert.equal(restorable.length, 0, 'already in memory — must not restore twice');
    assert.equal(claimsByBase.get('ETH'), 0.0320695, 'but its coins are still reserved');
  });

  test('genuine scalper excess above the core leg survives', () => {
    const livePositions = new Map([
      ['ETH/USDC#core', { qty: 0.0321, isCore: true }],
    ]);
    const freeEth = 0.0521; // sleeve 0.0321 + a real scalper 0.02
    const { claimsByBase } = calcCoreClaims({
      savedState: {},
      livePositions,
      freeBalances: { ETH: freeEth },
    });
    assert.ok(
      Math.abs((freeEth - claimsByBase.get('ETH')) - 0.02) < 1e-9,
      'a real scalper position must still restore',
    );
  });
});

describe('calcCoreClaims — persisted core legs', () => {
  test('persisted core leg not in memory is reserved and restorable', () => {
    const { claimsByBase, restorable } = calcCoreClaims({
      savedState: {
        'ETH/USDC#core': {
          qty: 0.03, entryPrice: 1872.95, isCore: true, openedAt: ONE_HOUR_AGO,
        },
      },
      livePositions: new Map(),
      freeBalances: { ETH: 0.05 },
    });
    assert.equal(claimsByBase.get('ETH'), 0.03);
    assert.equal(restorable.length, 1);
    assert.equal(restorable[0].market, 'ETH/USDC');
    assert.equal(restorable[0].base, 'ETH');
    assert.equal(restorable[0].entryPrice, 1872.95);
  });

  test('claim is clamped to the wallet after a manual sell', () => {
    const { claimsByBase } = calcCoreClaims({
      savedState: {
        'ETH/USDC#core': {
          qty: 0.03, entryPrice: 1872.95, isCore: true, openedAt: ONE_HOUR_AGO,
        },
      },
      livePositions: new Map(),
      freeBalances: { ETH: 0.004 },
    });
    assert.equal(claimsByBase.get('ETH'), 0.004, 'never reserve coins the wallet lacks');
  });

  test('invalid openedAt is dropped and claims nothing', () => {
    for (const openedAt of [undefined, '', 'not-a-date', new Date(Date.now() + 86_400_000).toISOString()]) {
      const { claimsByBase, restorable, dropped } = calcCoreClaims({
        savedState: {
          'ETH/USDC#core': { qty: 0.03, entryPrice: 1872.95, isCore: true, openedAt },
        },
        livePositions: new Map(),
        freeBalances: { ETH: 0.05 },
      });
      assert.equal(claimsByBase.get('ETH'), undefined, `openedAt=${openedAt} must not claim coins`);
      assert.equal(restorable.length, 0);
      assert.equal(dropped.length, 1);
      assert.equal(dropped[0].key, 'ETH/USDC#core');
    }
  });

  test('non-core and malformed records are ignored', () => {
    const { claimsByBase, restorable } = calcCoreClaims({
      savedState: {
        'ETH/USDC': { qty: 0.03, entryPrice: 1872.95, isCore: false, openedAt: ONE_HOUR_AGO },
        'BTC/USDC#core': { qty: 0, entryPrice: 60000, isCore: true, openedAt: ONE_HOUR_AGO },
        'SOL/USDC#core': { qty: 1, entryPrice: 0, isCore: true, openedAt: ONE_HOUR_AGO },
      },
      livePositions: new Map(),
      freeBalances: { ETH: 0.05, BTC: 0.01, SOL: 5 },
    });
    assert.equal(claimsByBase.size, 0);
    assert.equal(restorable.length, 0);
  });
});

describe('calcCoreClaims — shape and edge cases', () => {
  test('empty inputs are safe', () => {
    const { claimsByBase, restorable, dropped } = calcCoreClaims();
    assert.equal(claimsByBase.size, 0);
    assert.deepEqual(restorable, []);
    assert.deepEqual(dropped, []);
  });

  test('missing wallet balance claims nothing', () => {
    const { claimsByBase } = calcCoreClaims({
      livePositions: new Map([['ETH/USDC#core', { qty: 0.03, isCore: true }]]),
      freeBalances: {},
    });
    assert.equal(claimsByBase.get('ETH'), undefined);
  });

  test('distinct core markets reserve independently', () => {
    const { claimsByBase } = calcCoreClaims({
      livePositions: new Map([
        ['ETH/USDC#core', { qty: 0.03, isCore: true }],
        ['BTC/USDC#core', { qty: 0.001, isCore: true }],
      ]),
      freeBalances: { ETH: 0.05, BTC: 0.002 },
    });
    assert.equal(claimsByBase.get('ETH'), 0.03);
    assert.equal(claimsByBase.get('BTC'), 0.001);
  });

  test('accepts livePositions as a plain array of entries', () => {
    const { claimsByBase } = calcCoreClaims({
      livePositions: [['ETH/USDC#core', { qty: 0.03, isCore: true }]],
      freeBalances: { ETH: 0.05 },
    });
    assert.equal(claimsByBase.get('ETH'), 0.03);
  });
});

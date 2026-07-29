---
name: testing
description: >-
  Skill for writing tests for the playAIStocks trading bot — node:test suite
  layout, invariant fixtures, and the manual validation steps that complete it.
---

# Testing Skill

## Current State

The suite runs on Node's built-in `node:test` (no external runner):

```bash
npm test                                         # expect ≥297 pass, 0 fail (covers tests/ AND src/tests/)
```

Tests live in `tests/<area>/<subject>.test.js`, mirroring `src/` (`tests/engine/`,
`tests/risk/`, `tests/executor/`, `tests/core/`, `tests/utils/`, `tests/dashboard/`, …).
Shared helpers are in `tests/helpers.js`. Put new tests there.

⚠️ One legacy file sits outside that tree: `src/tests/dashboardState.test.js`. `npm test` globs
both roots, but a bare `node --test 'tests/**/*.test.js'` **silently misses it** — always use
`npm test` when reporting a pass count.

Automated tests do **not** replace these — run both:
- `node --check <file>` — syntax validation
- `SMOKE_TEST=false PAPER_MODE=true node src/main.js` — boot validation
- `PAPER_MODE=true node src/scripts/runBaseline.mjs` — metrics, for strategy/risk changes

## Invariant Fixtures (keep green — they encode real outages)

| Fixture | Protects against |
|---|---|
| `tests/engine/aggregatorParity.test.js` | Live / backtester / optimizer voting math drifting apart |
| `tests/utils/confidenceThresholdParity.test.js` | A threshold read raw instead of `scaleMinConfidence()` — this starved live to 0 trades for 27 days |
| `tests/dashboard/candleMerge.test.js` | A first-wins candle merge freezing partial bars into history |
| `tests/core/cycleScheduler.test.js` | The cycle drifting off candle close and never re-aligning |
| `tests/utils/candleFreshness.test.js` | Trading on a frozen series from a delisted/thin pair |

When a bug is fixed, add the test that would have caught it **and reference the incident
in the file docstring** — the fixtures above are the reason these bugs can't return silently.

## When to Add Tests

Add a test when:
- A bug is fixed (write a test that would have caught it)
- A strategy function is added or changed (pure function — easy to unit test)
- A risk calculation is added or changed (deterministic — easy to assert)
- Two code paths must agree (write a parity fixture, not two separate tests)

## Test Style

Use Node.js built-in `node:test` (no external package needed):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignal } from '../src/strategies/rsi.js';

test('RSI overbought returns SELL', () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    timestamp: i * 3600000,
    open: 100, high: 105, low: 98,
    close: 100 + i * 0.5, // rising
    volume: 1000
  }));
  const result = computeSignal(candles, { period: 14, overbought: 70, oversold: 30 });
  assert.equal(result.signal, 'SELL');
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.ok(typeof result.reason === 'string');
});
```

Run with: `node --test tests/strategies/rsi.test.js`

## What to Test

- **Strategy functions**: pure input → output, including edge cases (insufficient data, flat market, extreme values)
- **Risk calculations**: position size, daily loss accumulation, correlation filter threshold
- **Formatter functions** in `public/index.html`: extract them to a `src/utils/format.js` first if testing is needed

- **Merge / dedup logic**: whenever two sources of the same record combine, assert *which one wins*
- **Scheduling**: inject the clock and timer (`now`, `setTimeoutFn`) rather than waiting on real time

## What Not to Test

- Exchange API calls (mock or skip; don't call testnet in CI)
- SSE or HTTP endpoints without a running server
- Candle cache **file I/O** — but the in-memory merge in `dashboardState.updateCandles` **is**
  unit-tested and must stay that way; it feeds every strategy

## Candle Fixture Pattern

```js
function makeCandles(closes) {
  return closes.map((close, i) => ({
    timestamp: i * 3600000,
    open: close - 1, high: close + 2, low: close - 2,
    close, volume: 1000
  }));
}
```

## Checklist

- [ ] Test file placed in `tests/` mirroring `src/` structure
- [ ] Only tests behaviour, not implementation details
- [ ] No real exchange calls
- [ ] `node --test tests/<file>` passes

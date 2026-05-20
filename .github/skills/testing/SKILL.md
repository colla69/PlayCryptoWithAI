---
name: testing
description: >-
  Skill for writing tests for the playAIStocks trading bot. No test framework is
  configured yet — covers both unit test setup and manual validation patterns.
---

# Testing Skill

## Current State

No automated test runner is configured. Validation is currently done via:
- `node --check <file>` — syntax validation
- Manual bot startup in paper mode — runtime validation
- Smoke test via dashboard button (POST `/api/smoke-test`) — end-to-end trade cycle

## When to Add Tests

Add a test when:
- A bug is fixed (write a test that would have caught it)
- A strategy function is added or changed (pure function — easy to unit test)
- A risk calculation is added or changed (deterministic — easy to assert)

## Recommended Test Setup (if adding)

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

## What Not to Test

- Exchange API calls (mock or skip; don't call testnet in CI)
- SSE or HTTP endpoints without a running server
- Candle cache (file I/O; test manually)

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

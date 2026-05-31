# Tester Agent

Write and maintain unit tests for the playAIStocks trading bot.

## Philosophy

Tests replicate **real live trading scenarios** — not abstract unit logic.
Every test answers: "If this happened in production, would the bot behave correctly?"

## Scenario Categories

1. **Position lifecycle** — BUY→hold→SELL through SL/TP/strategy/break-even
2. **Edge cases** — insufficient balance, zero price, max positions reached, dust amounts
3. **Risk gates** — daily loss limit, confidence threshold, correlation block, regime block
4. **Signal aggregation** — ties, all-HOLD, mixed votes, external signals
5. **State transitions** — position restore after restart, day rollover, deposit changes balance
6. **Market conditions** — flash crash (price gaps below SL), low liquidity, flat market

## Framework

- Node.js built-in `node:test` + `node:assert/strict` (zero dependencies)
- Run: `npm test` or `node --test tests/**/*.test.js`
- Files: `tests/<module>/<topic>.test.js` mirroring `src/` structure

## Conventions

```js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
```

- Use `describe()` to group scenarios by category
- Test names should read like incident reports: "SELL triggers when price gaps below SL"
- Use helper `makeCandles(closes)` for candle fixtures
- Mock exchange calls — never hit real APIs
- Each test is self-contained (no shared mutable state between tests)

## Helpers (tests/helpers.js)

```js
export function makeCandles(closes, { startTime = 0, interval = 43200000 } = {}) {
  return closes.map((close, i) => ({
    timestamp: startTime + i * interval,
    open: close * 0.99,
    high: close * 1.02,
    low: close * 0.98,
    close,
    volume: 1000 + Math.random() * 500,
  }));
}
```

## When to Add Tests

- Bug fixed → write a test that would have caught it
- New scenario discovered in live trading → encode it
- Strategy or risk logic changed → cover the new behavior
- User reports unexpected behavior → reproduce as a test first

## Quality Rules

- No exchange calls, no file I/O, no network
- Deterministic — same input always produces same output
- Fast — entire suite runs in < 5 seconds
- No testing of implementation details (private methods, internal state)
- Test the public interface: `execute()`, `checkRisk()`, `canTrade()`, `aggregate()`

## Checklist Before Committing Tests

- [ ] `npm test` passes with zero failures
- [ ] No flaky tests (run 3× to confirm)
- [ ] Test names describe the scenario, not the method
- [ ] Edge cases included (zero, negative, NaN, missing fields)
- [ ] No mocking of the module under test — only its dependencies

---
name: trading-strategy
description: >-
  Skill for creating, modifying, or tuning trading strategies in the playAIStocks bot.
  Covers src/strategies/, signal aggregator voting, confidence scoring, and per-symbol config.
---

# Trading Strategy Skill

## What This Skill Covers

- Adding a new strategy to `src/strategies/`
- Modifying an existing strategy's signal logic
- Adjusting aggregator weighting in `src/engine/signalAggregator.js`
- Tuning per-symbol parameters in `config/default.js`

## Strategy Contract

Every strategy must export a function with this signature:

```js
/**
 * @param {Array<{timestamp: number, open: number, high: number, low: number, close: number, volume: number}>} candles
 * @param {object} params — strategy-specific parameters from config
 * @returns {{ signal: 'BUY' | 'SELL' | 'HOLD', confidence: number, reason: string }}
 */
export function computeSignal(candles, params) { … }
```

- `candles` — array of closed OHLCV candles, newest last. **Never use the last (forming) candle.**
- `confidence` — float in `[0, 1]`. Higher = stronger conviction.
- `reason` — human-readable string for dashboard display.
- Must always return a result; never throw or return null/undefined.

## No Lookahead Rule

**Never use a candle that hasn't closed yet.** For a 4h timeframe, the most recent candle in the array is the current forming candle — use `candles[candles.length - 2]` as the last confirmed close, or slice with `candles.slice(0, -1)`.

## Signal Aggregator Integration

- Strategies are registered in `src/strategies/index.js`.
- Weights are set per-strategy in `config/default.js` under `strategies`.
- The aggregator calls each strategy, weights the votes, and returns a final signal if the weighted confidence exceeds `config.entryThreshold`.

## Parameter Naming Conventions

| Name | Meaning |
|---|---|
| `period` | Rolling lookback window |
| `overbought` | Upper threshold (e.g. RSI 70) |
| `oversold` | Lower threshold (e.g. RSI 30) |
| `fastPeriod` / `slowPeriod` | For crossover strategies |
| `weight` | Aggregator vote weight (0–2) |

## Example Minimal Strategy

```js
// src/strategies/ema.js
export function computeSignal(candles, { fastPeriod = 9, slowPeriod = 21 } = {}) {
  const closes = candles.slice(0, -1).map(c => c.close); // exclude forming candle
  if (closes.length < slowPeriod) return { signal: 'HOLD', confidence: 0, reason: 'Insufficient data' };

  const ema = (data, n) => {
    const k = 2 / (n + 1);
    return data.reduce((acc, v, i) => i === 0 ? v : acc * (1 - k) + v * k);
  };

  const fast = ema(closes.slice(-fastPeriod), fastPeriod);
  const slow = ema(closes.slice(-slowPeriod), slowPeriod);

  if (fast > slow) return { signal: 'BUY',  confidence: 0.6, reason: `EMA${fastPeriod}>${slow.toFixed(2)}` };
  if (fast < slow) return { signal: 'SELL', confidence: 0.6, reason: `EMA${fastPeriod}<${slow.toFixed(2)}` };
  return { signal: 'HOLD', confidence: 0.3, reason: 'EMA crossover flat' };
}
```

## Checklist Before Merging a New Strategy

- [ ] No lookahead (excludes forming candle)
- [ ] Returns `{ signal, confidence, reason }` for all inputs
- [ ] Handles insufficient candle data gracefully
- [ ] Registered in `src/strategies/index.js`
- [ ] Enabled and weighted in `config/default.js`
- [ ] `node --check src/strategies/<file>.js` passes

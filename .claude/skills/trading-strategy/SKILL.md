---
name: trading-strategy
description: >-
  Skill for creating, modifying, or tuning trading strategies in the playAIStocks bot.
  Covers src/strategies/, signal aggregator voting, confidence scoring, and per-symbol config.
---

# Trading Strategy Skill

## Strategy contract

A strategy is a class in `src/strategies/<name>.js`, shaped like `rsi.js`:

- `constructor(config)` receives its parameter block — `config.<key>` in `config/default.js`
  (e.g. `config.rsi`), overridable per symbol as `config.perSymbol[symbol].<key>`.
- `analyze(candles)` takes `{ timestamp, open, high, low, close, volume }` objects, oldest first,
  and returns `{ name, signal: 'BUY'|'SELL'|'HOLD', value, confidence, reason }`.
- The newest candle is still forming. Compute on `candles.slice(0, -1)` (or read
  `candles[candles.length - 2]` as the last confirmed close); reading the last bar is lookahead.
- `confidence` is in [0, 1] — higher means stronger conviction — and becomes the strategy's vote
  weight. `reason` is shown on the dashboard.
- Short series return `HOLD` with confidence 0 and a reason — `analyze()` never throws and never
  returns `null`/`undefined`.
- Stateless: `analyze()` mutates nothing on the instance.

Parameter names follow the existing blocks in `config/default.js`: `period` (lookback),
`oversold` / `overbought` (thresholds, e.g. RSI 30/70, Stoch 20/80), `fast` / `slow` (crossovers —
EMA, MACD), `signal` / `signalPeriod` (smoothing), `stdDev` (Bollinger width), `threshold`
(ADX trend strength). There is no per-strategy weight: confidence is the vote weight.

```js
export class ExampleStrategy {
  constructor(config) { this.config = config; }

  analyze(candles) {
    const closed = candles.slice(0, -1);   // exclude forming candle
    if (closed.length < this.config.period + 1) {
      return { name: 'EX', signal: 'HOLD', value: NaN, confidence: 0, reason: 'EX: insufficient data' };
    }
    // …compute the indicator on `closed`, map it to signal + confidence…
  }
}

export default ExampleStrategy;
```

Registration: follow Strategy Registration in `project.md` — four entries in
`src/utils/strategyBuilder.js` (a missing one throws `Unknown strategy:` at startup), the export
in `src/strategies/index.js`, and dashboard metadata in `src/strategies/registry.js`.

## How votes become a decision

- A symbol's strategy list is `config.perSymbol[symbol].strategies`, falling back to
  `config.strategies`.
- The voting math lives only in `src/engine/aggregatorVoting.js`, shared by the live
  `signalAggregator.js`, `PortfolioBacktester` and the optimizer's `aggregate()`. HOLD counts in
  the denominator: `confidence = winner_weight / total_voters`.
- The entry threshold is the symbol's `minConfidence` (fallback `risk.minConfidence`) scaled by
  `risk.confidenceThresholdScale` — always read it through `scaleMinConfidence()`.
- Borderline entries need the previous bar to agree (`signals.multiBarConfirmation`). External
  signals vote with fixed weights from `config.signals`.

## Tuning per-symbol parameters

`config.perSymbol[symbol]` holds `strategies`, `stopLossPct`, `takeProfitPct`, `minConfidence` and
indicator overrides. The optimizer is `src/scripts/perSymbolOptimizer.mjs`; its holdout rules
(`MIN_TRADES ≥ 8`, deflated Sharpe ≥ 0.5, Y2 selection / Y1 validation) are in `project.md` →
Backtest Integrity, together with the full filter stack every portfolio backtest runs.

## Before merging a strategy

- [ ] Uses closed candles only
- [ ] Returns the full result shape for every input, including short and flat series
- [ ] Registered, added to the `strategies` list of each symbol it should run on (or to
      `config.strategies`), and the boot test passes
- [ ] `node --check src/strategies/<file>.js` passes
- [ ] Unit test under `tests/strategies/`
- [ ] Two-window portfolio backtest with the full filter stack; an adopt/keep decision also needs
      forward-only walk-forward + DSR

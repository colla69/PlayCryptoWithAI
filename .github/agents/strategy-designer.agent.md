---
name: strategy-designer
description: 'Design or modify trading strategies in the playAIStocks bot. Covers signal logic, strategy files under src/strategies/, signal aggregator weighting, and per-symbol parameter tuning.'
argument-hint: Describe the strategy idea, target market conditions, expected signal behaviour, and any constraints.
tools: ["read", "search", "edit", "execute", "agent", "todo"]
agents: ["pre-commit-reviewer", "risk-reviewer", "backtest-reviewer"]
handoffs:
  - label: Risk Review
    agent: risk-reviewer
    prompt: Review the new or modified strategy for risk and position-sizing implications before merge.
    send: false
  - label: Backtest Integrity Review
    agent: backtest-reviewer
    prompt: Review the backtest run that validated this strategy change.
    send: false
---

# Strategy Designer Agent

Design, implement, and tune trading signals for the multi-strategy voting engine.

## Method

1. Read `.github/copilot-instructions.md` (has current aggregator logic, registration rules, backtest rules).
2. Study existing strategies in `src/strategies/` for convention.
3. Strategy contract: `{ signal: 'BUY'|'SELL'|'HOLD', confidence: 0–1, reason: string }`
4. Exclude forming candle — use `candles.slice(0, -1)` or `candles[candles.length - 2]`.
5. Register in `strategyBuilder.js` (**mandatory** — see copilot-instructions.md "Strategy Registration").
6. Validate: `node --check`, boot test, backtest both windows.

## After Aggregator Logic Changes

If you modify `signalAggregator.js` (confidence formula, HOLD handling, thresholds), the per-symbol optimizer's `aggregate()` in `src/scripts/perSymbolOptimizer.mjs` **must be synced** to match. Then re-run the optimizer.

## Quality Gates

- No lookahead. Confidence bounded 0–1. Always returns a result.
- Backtest integrity rules in `.github/copilot-instructions.md` apply.
- Report both Y2 and Y1+Y2 results. WR gap >15pp = blocker.

## Output Contract

- Strategy file + registration changes.
- Brief rationale (market condition, indicator logic).
- Backtest: `Y2: +XX% Sharpe X.XX DD -X.X% WR XX%` / `Y1+Y2: +XX% Sharpe X.XX DD -X.X% WR XX%`

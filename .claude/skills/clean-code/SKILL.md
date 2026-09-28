---
name: clean-code
description: >-
  Skill for maintaining code quality, module cohesion, and readability in the playAIStocks bot.
  Use when refactoring, extracting helpers, or reviewing code structure.
---

# Clean Code Skill

## Module Responsibility Map

| Module | Owns |
|---|---|
| `src/main.js` | Startup, wiring, smoke test, price poller, per-cycle correlation matrix refresh |
| `src/core/` | `cycleScheduler.js` candle-close alignment · `positionSizing.js` sizing chain · `filters.js` entry filters |
| `src/engine/` | `signalAggregator.js` + `aggregatorVoting.js` voting · `regimeClassifier.js` / `regimeRouter.js` regime + bear policy · `tsmCore.js` core sleeve |
| `src/strategies/` | Individual indicator logic, one vote each |
| `src/risk/` | `riskManager.js` entry gate + daily loss (re-exported by `index.js`) · `portfolioRisk.js` correlation cap, weekly DD, aging, equity |
| `src/executor/` | `paperTrader.js` / `liveTrader.js` position state and order execution · `traderUtils.js` shared stop/target/trailing/break-even maths |
| `src/exchange/` | `binanceClient.js` all exchange calls · `exchangeLimits.js` min notional · `candleCache.js` on-disk candles |
| `src/dashboard/` | `dashboardState.js` in-memory state + persistence · `dashboardServer.js` HTTP, SSE, API endpoints |
| `src/utils/` | Shared pure helpers — `strategyBuilder.js`, `mergeCandles.js`, `candleFreshness.js`, `indicators.js`, `logger.js` … |
| `public/index.html` | All dashboard UI — CSS, HTML, JS in one file |
| `config/default.js` | All tunable parameters |

## Ownership rules

- `main.js` orchestrates: scheduling, startup, wiring. Logic it grows moves into a module under
  `src/core/`, `src/engine/`, `src/risk/` or `src/utils/`.
- `src/dashboard/dashboardState.js` is the only writer of `dashboard_persist.json`; dashboard
  modules hold no trading logic.
- `src/exchange/binanceClient.js` is the only module that calls the exchange.
- Strategies are stateless: candles in, vote out.

## When to extract a module

**When two code paths must agree, the rule lives in one module both import** — live and backtest,
live and optimizer, in-memory and on-disk. `aggregatorVoting.js`, `exchangeLimits.js`,
`candleFreshness.js` and `mergeCandles.js` exist for exactly this; each replaced a pair of copies
that drifted apart and broke live ≡ backtest. Two callers are enough.

Otherwise, extract repeated logic into a named helper in the same module first, and keep existing
function signatures when refactoring — not every caller is visible from one file.

## Checklist

- [ ] Changed module still owns only its responsibilities
- [ ] No business logic leaked into `main.js` or dashboard modules
- [ ] No state mutated inside a strategy's `analyze()`
- [ ] Logic shared by live and backtest lives in one module both import
- [ ] Dead code removed (commented-out blocks, unused variables)
- [ ] `node --check` passes on all changed files

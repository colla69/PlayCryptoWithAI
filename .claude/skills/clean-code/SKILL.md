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
| `main.js` | Cycle scheduling, startup, smoke test, price poller, correlation matrix |
| `src/engine/signalAggregator.js` | Multi-strategy voting, confidence aggregation |
| `src/strategies/` | Individual indicator logic, signal vote output |
| `src/risk/index.js` | RiskManager: daily limits, position size, regime filter |
| `src/executor/paperTrader.js` | Position state, stop/target/trailing execution |
| `src/exchange/binanceClient.js` | All exchange API calls |
| `src/dashboard/dashboardState.js` | In-memory dashboard state, persistence |
| `src/dashboard/dashboardServer.js` | HTTP server, SSE, API endpoints |
| `public/index.html` | All dashboard UI — CSS, HTML, JS in one file |
| `config/default.js` | All tunable parameters |

## Key Rules

- Keep `main.js` as an orchestrator — no inline business logic.
- Keep `dashboardState.js` as the only writer of `dashboard_persist.json`.
- Keep strategies stateless — they receive candles and return a vote, no internal mutation.
- Keep `binanceClient.js` as the only module making direct exchange calls.
- Do not mix trading logic into dashboard modules.

## Refactoring Guidelines

- Extract repeated logic into a named helper in the same module.
- Do not create new modules unless the extracted logic is used by 3+ callers.
- Preserve existing function signatures when refactoring — callers may not be visible.
- Always syntax-check after refactoring: `node --check <file>`.

## Comment Policy

- Comment the *why*, not the *what*.
- Remove debug comments and `console.log` before committing.
- JSDoc on exported functions is welcome, not mandatory.

## Checklist

- [ ] Changed module still owns only its documented responsibilities
- [ ] No business logic leaked into `main.js` or dashboard modules
- [ ] No state mutations in strategy functions
- [ ] Removed dead code (commented-out blocks, unused variables)
- [ ] `node --check` passes on all changed files

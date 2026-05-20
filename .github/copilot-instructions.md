# playAIStocks — Copilot Instructions

Use this file as the primary source of truth for this repository.
Trust it first; search the codebase only when the task depends on details not covered here or the code clearly contradicts these instructions.

## What This App Does

- An automated crypto trading bot targeting Binance spot markets.
- Supports three operating modes: **PAPER** (simulated, no real money), **TESTNET** (Binance testnet exchange), and **LIVE** (real Binance exchange).
- Analyses OHLCV candle data using a multi-strategy signal aggregator and manages a shared portfolio budget across multiple coins.
- Protects capital via stop-loss, take-profit, trailing stop, break-even stop, a regime (ADX) filter, and a correlation filter.
- Exposes a real-time dashboard at `http://localhost:3001` with SSE-based live updates.

## Tech Stack

- Runtime: Node.js 20, ES modules (`"type": "module"` in `package.json`).
- Exchange: Binance via `ccxt` library (`src/exchange/binanceClient.js`).
- Execution: `src/executor/paperTrader.js` (paper/testnet) and `src/executor/liveTrader.js` (live).
- Signal engine: `src/engine/signalAggregator.js` fed by `src/strategies/` (RSI, BB, CCI, EMA, MACD, ADX, Stochastic).
- Risk: `src/risk/index.js` — daily loss limits, max open positions, confidence thresholds.
- Dashboard: Express server in `src/dashboard/dashboardServer.js` + SSE events + `public/index.html` (single-file, vanilla JS).
- Config: `config/default.js` — symbols, timeframe, strategies, risk params, per-symbol overrides.
- Logging: Winston (`src/utils/logger.js`), logs to `logs/app.log`.

## Repository Layout

```
src/
  main.js                    # Entry point; cycle scheduling, smoke test, correlation matrix
  engine/signalAggregator.js # Multi-strategy voting
  strategies/                # RSI, BB, CCI, EMA, MACD, ADX, Stochastic + index.js
  executor/
    paperTrader.js            # Paper/testnet execution + position tracking
    liveTrader.js             # Live Binance execution
  risk/index.js               # RiskManager
  exchange/binanceClient.js   # CCXT wrapper (fetchOHLCV, fetchTicker, createOrder…)
  exchange/candleCache.js     # Candle persistence
  dashboard/
    dashboardServer.js        # Express + SSE endpoints
    dashboardState.js         # In-memory state, metrics, persistence
    persistence.js            # Load/save dashboard_persist.json
    index.js                  # Re-exports
  signals/                    # External signal sources (Telegram, Twitter, webhooks)
  utils/logger.js
config/default.js
public/index.html             # Single-file dashboard (CSS + HTML + JS, ~1700 lines)
data/
  dashboard_persist.json      # Persisted trade history + signal feed
  candle_cache/               # OHLCV cache files
logs/app.log
```

## Coding Guidelines

- All files use ES module syntax (`import`/`export`); never use `require()`.
- Follow existing patterns before introducing new structure.
- Keep `main.js` for orchestration only; business logic belongs in the relevant module.
- Dashboard state lives in `dashboardState.js` only; never read `dashboard_persist.json` directly elsewhere.
- `public/index.html` is intentionally a single file; keep JS and CSS inline there.
- Smoke-test trades are tagged `note: '🔬 smoke-test'`; do not remove or re-purpose this field.
- Trading decisions must only use past/closed candle data — no lookahead.
- Price data for positions must come from live tickers (`fetchTicker`), not candle closes, between cycles.
- Strategy signals use majority voting in `signalAggregator.js`; strategies vote independently.
- Never commit secrets (`BINANCE_API_KEY`, `BINANCE_API_SECRET`, `.env` files).
- Use `.github/skills/` when the task touches strategy logic, risk management, security, or testing.

## Agent Routing

- Use `analyst` when a task needs clarifying scope, risk, or market behaviour impact before coding.
- Use `developer` when the design is clear and the change is concrete enough to implement.
- Use `strategy-designer` when a task adds or modifies a trading strategy or the signal aggregator.
- Use `risk-reviewer` when a task touches stop-loss, take-profit, position sizing, daily limits, or correlation/regime filters.
- Use `reviewer` for general code review and `security-reviewer` for exchange credentials, API keys, or order execution paths.
- Use `pre-commit-reviewer` before committing to check staged changes for correctness and regression risk.

## Build and Validation

- Install dependencies: `npm install`
- Start (paper mode): `npm run start` or `node src/main.js`
- Syntax check a file: `node --check <file>`
- No test runner is configured yet; validate by syntax-checking changed files and confirming the bot starts cleanly.
- Lint: not yet configured; follow existing style.

## Known Constraints

- Binance testnet requires a separate API key from `testnet.binance.vision`.
- The minimum notional for a Binance order is $10; smoke tests use $11 in live/testnet mode.
- Candle alignment: the bot waits for the next UTC candle-close boundary + 3s before running a cycle.
- `dashboard_persist.json` stores up to 100 trades and 50 signals; older entries are dropped.
- The SSE heartbeat in `dashboardServer.js` pushes a full `cycle` event every 15s; live prices push a `prices` event every 5s via `main.js`.
- Two bot instances on the same port will silently shadow each other; always kill the old process before restarting.

## Key Environment Variables

| Variable | Purpose |
|---|---|
| `BINANCE_API_KEY` | Exchange API key |
| `BINANCE_API_SECRET` | Exchange API secret |
| `BINANCE_TESTNET=true` | Use Binance testnet |
| `PAPER_MODE=true` | Paper trading (no exchange calls for orders) |
| `DASHBOARD_PORT` | Dashboard port (default 3001) |

Set these in a `.env` file (never committed) or via the shell.

## Useful References

- Exchange client: `src/exchange/binanceClient.js`
- Strategy registry: `src/strategies/index.js`
- Signal aggregator: `src/engine/signalAggregator.js`
- Risk manager: `src/risk/index.js`
- Config (symbols, risk params): `config/default.js`
- Dashboard state and metrics: `src/dashboard/dashboardState.js`

Trust this file first. Search the codebase only when it is incomplete or contradicted by reality.

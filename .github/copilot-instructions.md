# playAIStocks — Copilot Instructions

Primary source of truth. Trust this first; search code only when details aren't covered here.

## App Summary

Automated crypto trading bot on Binance spot (USDC pairs, EU-compliant). 37-coin portfolio, 12h timeframe, 4 max concurrent positions. Modes: PAPER, TESTNET, LIVE.

## Token Efficiency Rules

**These apply to ALL agents and all conversations in this repo:**

- Be concise. Aim for <100 words in routine responses.
- Batch file reads — request multiple in one turn, not sequentially.
- Suppress verbose command output: pipe to `| tail -20`, use `--quiet`, `grep` for relevant lines.
- Don't re-read files you've already seen in this conversation.
- Don't echo back large code blocks the user already knows about.
- Skip preamble ("I'll now...", "Let me...") — just do the work.
- When running backtests, grep for the result line — don't dump full output.
- For validation: `node --check <file>` + quick startup test. Don't run full backtests for non-strategy changes.

## Tech Stack

- Node.js 22+, ES modules only (`import`/`export`, never `require()`)
- Binance via `ccxt` (`src/exchange/binanceClient.js`)
- Config: `config/default.js` — 37 symbols, per-symbol strategy combos, risk params
- Dashboard: Express + SSE at `:3001`, single-file `public/index.html`
- Logging: Winston → `logs/app.log`

## Critical Files (read these first when debugging)

| File | Role |
|---|---|
| `src/main.js` | Entry point, trading loop, filters, position restore |
| `src/engine/signalAggregator.js` | HOLD-suppressed voting engine |
| `src/utils/strategyBuilder.js` | Maps config keys → strategy instances (**crash if missing**) |
| `src/executor/liveTrader.js` | Live orders, position restore, exchange limits |
| `config/default.js` | All config, per-symbol overrides |

## Architecture Rules

- `main.js` = orchestration only. Business logic → relevant module.
- `dashboardState.js` = sole writer of `dashboard_persist.json`.
- `binanceClient.js` = sole exchange caller.
- Strategies are stateless — no mutation between calls.
- All trading decisions use past/closed candles only. **No lookahead.**
- Smoke-test trades tagged `note: '🔬 smoke-test'` — never remove.
- Never commit secrets. Keys from `.env` only.

## Signal Engine (current state)

- **15 strategies**: RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR, StochRSI, HeikinAshi, S&R
- **HOLD suppression**: HOLD votes excluded from denominator. `1 BUY + 2 HOLD = 100%` confidence, not 33%.
- **Asymmetric exit**: open positions exit at 70% of normal threshold when SELL majority exists.
- **MTF filter**: 15m recency-weighted alignment score blocks entries when score < 0.5.
- **S&R pin-bar confirmation**: without rejection candle, confidence capped at 0.62.

## Strategy Registration (mandatory)

Every strategy name in `config/default.js` MUST exist in `src/utils/strategyBuilder.js`:
1. Import in the import block
2. Entry in `STRATEGY_BUILDERS`
3. Entry in `STRATEGY_REASON_PREFIX`
4. Entry in `STRATEGY_TRIGGER_HINTS`

**Missing = crash on startup.** Always verify: `SMOKE_TEST=false PAPER_MODE=true node src/main.js`

## Backtest Integrity (shared rules)

These apply whenever backtest/optimizer code is touched:

- **Fill model**: BUY fills at next candle's open (`d.nextOpen`), not signal close
- **Slippage tiers**: Large 0.10%, Mid 0.20%, Micro 0.35% — never flat
- **Optimizer MIN_TRADES ≥ 3** on holdout; reject `[0t]`/`[1t]`/`[2t]` upgrades
- **Two-window reporting**: always report both Y2 (in-sample) and Y1+Y2 (full OOS)
- **WR gap**: >10pp = warning, >15pp = blocker
- **Optimizer aggregator must match live** — if aggregator logic changes, re-run optimizer

## Agent Routing

| Agent | When to use |
|---|---|
| `analyst` | Scope unclear, need requirements before coding |
| `developer` | Design is clear, implement it |
| `strategy-designer` | Strategy logic, aggregator, optimizer |
| `risk-reviewer` | SL/TP, sizing, limits, filters |
| `security-reviewer` | API keys, order paths, credential exposure |
| `pre-commit-reviewer` | Final gate before commit |
| `backtest-reviewer` | Validate backtest statistical integrity |
| `docs-updater` | After code changes, sync docs |

## Validation

```bash
node --check <file>                              # syntax
SMOKE_TEST=false PAPER_MODE=true node src/main.js  # boot test (kill after "Initialising")
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --candles 730   # Y2
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --candles 1460  # full OOS
PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs                # dry-run optimizer
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `BINANCE_API_KEY` | — | Exchange API key |
| `BINANCE_API_SECRET` | — | Exchange API secret |
| `PAPER_MODE` | `true` | Simulate orders |
| `BINANCE_TESTNET` | `false` | Testnet endpoints |
| `SMOKE_TEST` | `true` | `false` = skip startup check |
| `DASHBOARD_PORT` | `3001` | Dashboard HTTP port |
| `LOG_LEVEL` | `info` | Winston level |

## Key Constraints

- Min notional: $10 Binance, bot uses $11 fallback. Position restore threshold: $5.
- Candle alignment: waits for UTC candle-close + 3s before cycle.
- `dashboard_persist.json`: max 100 trades, 50 signals.
- Two instances on same port shadow each other — always kill old first.

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
| `src/engine/signalAggregator.js` | Confidence-weighted voting engine (consumes `aggregatorVoting.js`) |
| `src/engine/aggregatorVoting.js` | Pure voting math — **parity-locked** across live/backtester/optimizer |
| `src/engine/regimeClassifier.js` | BTC regime (EMA200×ADX, hysteresis); `regimeRouter.js` = bear policy + bundles |
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
- **Docs live in `docs/`.** All project documentation (`STRATEGY.md`, `TECHNICAL.md`, `TESTNET.md`, `WORKFLOW.md`, etc.) lives under `docs/`; `README.md` is the only `.md` at the repo root. New docs go in `docs/` and are linked from `README.md`. Do **not** move toolchain config that happens to be Markdown — `CLAUDE.md` (root + `public/` + `src/dashboard/`) and everything under `.claude/` and `.github/` must stay where the tooling loads them.

## Signal Engine (current state — post robustness overhaul)

- **20 strategies**: RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR, StochRSI, HeikinAshi, S&R + Donchian, VWAP-σ, VolumeSurge, Ichimoku, PinBar.
- **Confidence-weighted voting** (`src/engine/aggregatorVoting.js`, shared by live/backtester/optimizer): each strategy's confidence is its vote weight; **HOLD is counted in the denominator** so `confidence = winner_weight / total_voters`. `2/3 BUY + 1 HOLD = 0.67` (not 1.00) — fixes the old resolution bug. Parity enforced by `tests/engine/aggregatorParity.test.js`.
- **Calibration**: `risk.confidenceThresholdScale = 0.65` scales legacy per-symbol thresholds for the new formula. Phase 4 retune **measured** this: 1.0 starves the bot, 0.65 is best risk-adjusted (validated forward-only). Keep at 0.65 unless a from-scratch per-symbol retune replaces the thresholds.
- **Multi-bar confirmation**: borderline entries (within ~0.10 of minConf) need the previous bar to agree.
- **Regime gate** (`engine/regimeClassifier.js`): BTC EMA200×ADX 2×2 with 3-bar hysteresis; bear policy closes all + blocks entries on transition into `BEAR_TREND` (`bearPolicy.mode='trend_only'`). Regime routing infra exists but is OFF.
- **Cross-asset context** (`data/marketContext.js`): BTC.D gate (CoinGecko), ETHBTC sizing, Fear & Greed minConf modulator.
- **Portfolio risk gates** (`risk/portfolioRisk.js`): correlation cap (0.85), weekly DD breaker (−10%→72h), position-aging exit (14 bars).
- **Asymmetric exit**: open positions exit at 70% of normal threshold when SELL majority exists.
- **MTF filter**: 15m recency-weighted alignment score blocks entries when score < 0.5.
- **Disabled infra**: ATR-based stops and two-stage exit shipped but OFF (A/B net-negative vs tuned per-symbol fixed stops).

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
- **Optimizer MIN_TRADES ≥ 8** on holdout; reject `[0t]`/`[1t]`/`[2t]` upgrades; reject deflated-Sharpe < 0.5
- **Validation tooling**: `runBaseline.mjs` (multi-window + deflated Sharpe), `runWalkForward.mjs` (forward-only + Monte Carlo). Revert any change that worsens risk-adjusted metrics vs the committed baseline.
- **Two-window reporting**: always report both Y2 (in-sample) and Y1+Y2 (full OOS)
- **WR gap**: >10pp = warning, >15pp = blocker
- **Optimizer aggregator must match live** — if aggregator logic changes, re-run optimizer

### ⚠️ MANDATORY: Full Filter Stack in ALL Backtests

**Every portfolio-level backtest and optimizer MUST enable the same filters as the live bot.**
Presenting results without filters is MISLEADING. The live bot uses these — backtests must match.

Required filter config for `PortfolioBacktester`:
```js
mtfFilter: true,          // 15m alignment (load 15m candles per symbol)
mtf4hFilter: true,        // 4h EMA+RSI momentum (load 4h candles per symbol)
regimeSizing: true,       // ADX-based sizing (boost trends, penalise chop)
macroFilter: true,        // BTC EMA200 bear filter (halve size below)
confSizing: true,         // confidence-proportional sizing (0.6×–1.5×)
breakEvenTriggerPct: 0.05 // break-even stop at +5%
```

**Data requirements**: Before running any portfolio backtest, ensure ALL symbols have:
- `data/candles/{COIN}_USDC_4h.json` — 4h candles (for mtf4hFilter)
- `data/candles/{COIN}_USDC_15m.json` — 15m candles (for mtfFilter)

If a new coin lacks MTF data, **download it first** before reporting results.
Results without full filter coverage are invalid for decision-making.

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

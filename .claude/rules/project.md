# playAIStocks — project rules

Primary source of truth, imported by `CLAUDE.md`. Trust this first; search code only when
details aren't covered here. There is exactly one copy of this file — see the single-copy
rule in `docs/WORKFLOW.md`.

## App Summary

Automated crypto trading bot on Binance spot (USDC pairs, EU-compliant). 37-coin portfolio, 12h timeframe, 4 max concurrent positions. Modes: PAPER, TESTNET, LIVE.

## Token Efficiency Rules

**Always — these cost nothing in accuracy:**

- Batch file reads — request multiple in one turn, not sequentially.
- Suppress verbose command output: pipe to `| tail -20`, use `--quiet`, `grep` for relevant lines.
- When running backtests, grep for the result line — don't dump full output.
- Don't echo back large code blocks the user already knows about.
- Skip preamble ("I'll now...", "Let me...") — just do the work.
- For validation: `node --check <file>` + `npm test` + quick startup test. Don't run full backtests
  for non-strategy changes.

**Routine work only — brevity that must yield when correctness is at stake:**

- Be concise; aim for <100 words in routine responses.
- Don't re-read files you've already seen in this conversation.

### When these are suspended

Brevity is a default, not a constraint on rigour. **Suspend both rules above** when the task is:

- debugging a live/backtest divergence, or any parity question
- touching the order path, risk gates, credentials, or sizing
- auditing logs or reconciling live behaviour against a backtest
- deciding whether something is a bug or working as intended

In those cases, re-read the file, quote the exact lines, and show the evidence. The 2026-07 audit
found four parity breaks, and every one of them was invisible until someone read the *specific*
lines of both implementations side by side.

**The trap this codebase sets:** noticing a gap, describing it accurately, and then working around it
instead of fixing it. That happened during the audit itself — "the backtester has no min-notional
check" was written down, then hand-corrected in a throwaway script, while the repo's top rule says
live ≡ backtest. If you catch yourself writing "I'll account for that in the analysis", stop: the
fix belongs in the engine.

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
| `src/utils/strategyBuilder.js` | Maps config keys → strategy instances (**crash if missing**); `scaleMinConfidence()` — the single source of truth for the entry threshold |
| `src/executor/liveTrader.js` | Live orders, position restore, exchange limits |
| `src/dashboard/dashboardState.js` | Holds the candle series every strategy analyses — **merge is payload-wins** |
| `src/core/cycleScheduler.js` | Candle-close alignment; re-derives each fire time from the clock |
| `src/utils/candleFreshness.js` | Frozen-series detection (live guard + backtest stale-data warning) |
| `config/default.js` | All config, per-symbol overrides |

## Architecture Rules

- `main.js` = orchestration only. Business logic → relevant module.
- `dashboardState.js` = sole writer of `dashboard_persist.json`.
- `binanceClient.js` = sole exchange caller.
- Strategies are stateless — no mutation between calls.
- All trading decisions use past/closed candles only. **No lookahead.**
- **Candle merges are payload-wins.** The exchange payload overwrites any overlapping
  timestamp, in memory (`dashboardState.updateCandles`) and on disk (`saveCachedCandles`).
  Every cycle fetches a window containing the still-forming bar; a first-wins merge freezes
  that partial bar into history and discards its closed version, silently corrupting every
  indicator downstream. This shipped and went unnoticed for months — see Live ≡ Backtest below.
- Smoke-test trades tagged `note: '🔬 smoke-test'` — never remove.
- Never commit secrets. Keys from `.env` only.
- **External signals are votes.** Anything reaching the signal bus votes in the live aggregator
  (webhook weight 0.8) and exits fire at a lowered 0.7× threshold. The webhook is OFF by default
  and `startWebhookServer` refuses to run without `WEBHOOK_TOKEN` (header `x-webhook-token`).
  Never reintroduce an unauthenticated path to the signal bus — it ran open on host-networked
  port 3000 from the first commit until 2026-07-29.
- **Docs live in `docs/`.** All project documentation (`STRATEGY.md`, `TECHNICAL.md`, `TESTNET.md`, `WORKFLOW.md`, etc.) lives under `docs/`; `README.md` is the only `.md` at the repo root. New docs go in `docs/` and are linked from `README.md`. Do **not** move toolchain config that happens to be Markdown — `CLAUDE.md` (root + `public/` + `src/dashboard/`) and everything under `.claude/` must stay where the tooling loads them.

## Signal Engine (current state — post robustness overhaul)

- **20 strategies**: RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR, StochRSI, HeikinAshi, S&R + Donchian, VWAP-σ, VolumeSurge, Ichimoku, PinBar.
- **Confidence-weighted voting** (`src/engine/aggregatorVoting.js`, shared by live/backtester/optimizer): each strategy's confidence is its vote weight; **HOLD is counted in the denominator** so `confidence = winner_weight / total_voters`. `2/3 BUY + 1 HOLD = 0.67` (not 1.00) — fixes the old resolution bug. Parity enforced by `tests/engine/aggregatorParity.test.js`.
- **Calibration**: `risk.confidenceThresholdScale = 0.65` scales legacy per-symbol thresholds for the new formula. Phase 4 retune **measured** this: 1.0 starves the bot, 0.65 is best risk-adjusted (validated forward-only). Keep at 0.65 unless a from-scratch per-symbol retune replaces the thresholds.
- **Multi-bar confirmation**: borderline entries (within ~0.10 of minConf) need the previous bar to agree.
- **Regime gate** (`engine/regimeClassifier.js`): BTC EMA200×ADX 2×2 with 3-bar hysteresis; bear policy closes all + blocks entries on transition into `BEAR_TREND` (`bearPolicy.mode='trend_only'`). Regime routing infra exists but is OFF.
- **Cross-asset context** (`data/marketContext.js`): BTC.D gate (CoinGecko), ETHBTC sizing, Fear & Greed minConf modulator.
- **Portfolio risk gates** (`risk/portfolioRisk.js`): correlation cap (0.85), weekly DD breaker (−10%→72h), position-aging exit (14 bars). Daily-loss + weekly-DD %-limits scale off LIVE equity (`calcEquityFromStatus`), not static `initialBalance` (fallback only).
- **Asymmetric exit**: open positions exit at 70% of normal threshold when SELL majority exists.
- **MTF filter**: 15m recency-weighted alignment score blocks entries when score < 0.5.
- **TSM core sleeve** (`engine/tsmCore.js`): majors trending overlay (default OFF, `TSM_CORE` env var; simulates in paper, REAL market orders in live) — majority-vote trailing momentum with slow-in hysteresis, long-only while positive, exit on vote flip; failed live closes alert + retry via fast risk loop.
- **Sleeve sizing = HWM equity ladder** (`tsmCore.equityLadder`, 2026-07-29): rungs select between
  individually validated static profiles by the account's all-time-high equity (from
  `data/equity_history.json`). **Never key sizing off current equity — that is martingale** (sizes
  up after losses). Rungs: $0+ 2@0.50 · $320+ 2@0.30 · $970+ 4@0.20; combined account maxDD
  measured −17.4% / −10.1% / ~−7% (ρ=0.025 vs scalper). `sleeveFeasibility()` is advisory-only;
  order-time $11-floor enforcement lives in the trader AND the simulator.
- **Disabled infra**: ATR-based stops and two-stage exit shipped but OFF (A/B net-negative vs tuned per-symbol fixed stops).

## Live ≡ Backtest (hard invariant — four ways it has actually broken)

The cardinal rule is that live and backtest produce identical decisions from identical inputs.
Parity has broken four times in ways that were invisible for weeks. Check these on any change
touching signals, thresholds, or candle handling:

| Break | Symptom | Guard |
|---|---|---|
| **Threshold read raw instead of scaled** | Aggregator gated at `raw × 0.65`, `riskManager.canTrade()` re-gated at raw → live ran at the "STARVED" calibration and took **0 trades in 27 days** | Every threshold read goes through `scaleMinConfidence()`; `tests/utils/confidenceThresholdParity.test.js` |
| **In-memory candle merge first-wins** | Forming bar frozen into history, closed version discarded → live scored TIA CCI 49.1 vs backtest 76.7 on *identical on-disk data* | Payload-wins merge; `tests/dashboard/candleMerge.test.js` |
| **Cycle drifted off candle close** | A host suspend left the loop firing 6h09m late for 48 consecutive cycles — different MTF/regime inputs than the backtester models | `createAlignedScheduler` re-derives from the clock; `tests/core/cycleScheduler.test.js` |
| **Min notional enforced live only** | The simulator filled orders Binance would reject, so the deployment sweep reported an identical trade count at every position size | Shared `exchangeLimits.js`; `tests/backtester/minNotional.test.js` |
| **Downloader merge first-wins** | The last cached bar was still forming when written; it froze and the corrected version was discarded on every later run — corrupting the research data itself. BTC's 2026-06-24 04:00 4h bar closed at 62839.11 while the next opened at 62591.50, with ~40% of its true volume | Payload-wins merge + `--repair`; `tests/scripts/downloadHistoryMerge.test.js` |

**Three of the five were merges.** Wherever two sources of the same record combine — in memory, on
disk, or in a downloader — state which one wins, and it is always the exchange payload. A frozen
partial bar is silent: it corrupts every indicator computed from it and nothing errors. Repair with
`npm run download-history -- --timeframe <tf> --repair`, then verify with `rebuildDeepHistory.mjs`.

**The structural guard: `tests/backtester/liveParityInventory.test.js`.** Every rule that can reject
or resize a live entry is listed there with the symbol implementing it on *both* sides. Adding a
live-side rule without a backtest counterpart fails that fixture immediately, instead of surfacing
months later in a soak post-mortem. **When it fails, do not delete the row** — implement the missing
side, or move it to `INTENTIONALLY_LIVE_ONLY` with a written reason. Every one of the four breaks
above was a rule that existed on one side only; reviewing the diff never caught them, because the
omission is invisible in a diff.

Two rules that follow: **a second gate is a bug unless it reads the same scaled value**, and
**anything that feeds the strategies must be reproducible from disk.** When live and a backtest
disagree, suspect the in-memory path before suspecting the data.

## Stale / frozen market data

Thin or delisted pairs keep returning klines that never advance — Binance had no 12h candles for
LSK past 2026-06-12, TON past 06-30, GMX past 07-10 (LSK's last bar has volume 0.0). An empty-fetch
check does **not** catch this. `checkCandleFreshness()` skips a symbol whose newest bar is older
than `config.maxCandleStalenessPeriods` (default 2 periods = 24h); it guards the signal cycle, the
startup seed, and the TSM sleeve. Never bypass it to "get more symbols trading".

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
- **Exchange minimum notional is enforced** (`exchangeLimits.js`, shared with liveTrader). Rejections
  are reported as `filtersApplied.minNotional` — a run showing rejections is a run whose trade count
  the live bot would not reproduce. `riskOverrides: { minNotional: 0 }` exists for research only.
  Immaterial at the $1000 research budget (0 rejections; identical metrics), material below ~$400.
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
npm test                                         # expect ≥383 pass, 0 fail (covers tests/ AND src/tests/)
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
| `TSM_CORE` | `false` | Enable TSM majors trending sleeve (REAL orders in live mode) |

## Key numbers that keep biting

- **Min notional $11** (`FALLBACK_MIN_NOTIONAL`). `allocation = freeQuote × finalPositionPct`, and
  the multiplier chain (macro bear ×0.5, ADX chop ×0.5, confidence taper) routinely lands a small
  account under it. From 2,109 logged live sizing decisions: ~$600 clears the floor on ~99% of
  signals, $400 on ~89%, $189 on only ~42%. Backtests do **not** model this floor.
- **Docker on a laptop suspends.** The 2026-07 soak lost 6h11m to a host sleep; queued Binance
  requests fired on wake carrying signature timestamps from six hours earlier.

## Key Constraints

- Min notional: $10 Binance, bot uses $11 fallback. Position restore threshold: $5.
- Candle alignment: waits for UTC candle-close + 3s before cycle.
- `dashboard_persist.json`: max 100 trades, 50 signals.
- Two instances on same port shadow each other — always kill old first.

# playAIStocks — project rules

Automated crypto trading bot on Binance spot (USDC pairs, EU-compliant). 37-coin portfolio, 12h timeframe, 4 max concurrent positions. Modes: PAPER, TESTNET, LIVE.

Primary source of truth, loaded in every session and subagent. There is exactly one copy of this
file — see the single-copy rule in `docs/WORKFLOW.md`. When this file and the code disagree, the
code is right: fix this file in the same change.

## Working efficiently

- Backtest and optimizer scripts print thousands of lines: send the output to a file and grep for
  the result line. Pipe other verbose commands through `tail` or `grep`.
- Validation scope: `node --check` + `npm test` + a boot test for every change; backtests only for
  strategy, risk or sizing changes.
- Keep routine answers short, and don't paste back code the user already has.

**Evidence over recall.** For parity questions, the order path, risk gates, credentials, sizing,
log audits, and "bug or working as intended?" calls, re-read the specific lines of both
implementations and quote them. Every parity break in the table below was invisible until someone
read both sides side by side.

**The trap this codebase sets:** noticing a gap, describing it accurately, and then working around it
instead of fixing it. That happened during the 2026-07 parity audit itself (it found four of the
breaks below) — "the backtester has no min-notional
check" was written down, then hand-corrected in a throwaway script, while the repo's top rule says
live ≡ backtest. If you catch yourself writing "I'll account for that in the analysis", stop: the
fix belongs in the engine.

## Tech Stack

- Node.js 22+, ES modules only (`import`/`export`, never `require()`); Binance via `ccxt` (`src/exchange/binanceClient.js`)
- Config: `config/default.js` — 37 symbols, per-symbol strategy combos, risk params
- Dashboard: Express + SSE at `:3001`, single-file `public/index.html`
- Logging: Winston, daily files `logs/app-YYYY-MM-DD.log` (errors also in `logs/error-YYYY-MM-DD.log`)

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
- **Bot state paths go through `runtimeDir()`** (`src/utils/runtimePaths.js`). The live container
  bind-mounts this checkout's `data/` and `logs/`, so anything that writes there from a dev shell
  writes the live bot's state. In any test process (`node --test`, `--test-isolation=none`,
  `node x.test.js`, vitest) the resolver points at a temp dir, and it throws if a test would resolve
  inside the checkout. On 2026-09-28, before it existed, `npm test` deleted the live
  `dashboard_persist.json` and its fixture trades seeded +$438 into the daily-loss brake.
  `tests/utils/runtimePaths.test.js` probes every launch mode and fails on any new direct
  `data/`/`logs/` path.
- `binanceClient.js` = sole exchange caller.
- Strategies are stateless — no mutation between calls.
- All trading decisions use past/closed candles only. **No lookahead.**
- **Candle merges are payload-wins — and never hand-rolled.** The exchange payload overwrites
  any overlapping timestamp. The single copy of the rule is `src/utils/mergeCandles.js`
  (used by `dashboardState.updateCandles` and the startup seed; `saveCachedCandles` applies
  the same direction on disk). Every fetch window contains the still-forming bar; a first-wins
  merge freezes that partial bar into history and discards its closed version, silently
  corrupting every indicator downstream. Four separately hand-rolled merges have gotten the
  direction wrong — see Live ≡ Backtest below. New merge = call `mergeCandles()`, not a fifth copy.
- Smoke-test trades tagged `note: '🔬 smoke-test'` — never remove.
- Never commit secrets. Keys from `.env` only.
- **External signals are votes.** Anything reaching the signal bus votes in the live aggregator
  (webhook weight 0.8) and exits fire at a lowered 0.7× threshold. The webhook is OFF by default
  and `startWebhookServer` refuses to run without `WEBHOOK_TOKEN` (header `x-webhook-token`).
  Never reintroduce an unauthenticated path to the signal bus — it ran open on host-networked
  port 3000 from the first commit until 2026-07-29.
- **Docs live in `docs/`.** All project documentation (`STRATEGY.md`, `TECHNICAL.md`, `TESTNET.md`, `WORKFLOW.md`, etc.) lives under `docs/`; `README.md` is the only `.md` at the repo root. New docs go in `docs/` and are linked from `README.md`. Do **not** move toolchain config that happens to be Markdown — `CLAUDE.md` and everything under `.claude/` must stay where the tooling loads them.

## Signal Engine (current state — post robustness overhaul)

- **20 strategies**: RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR, StochRSI, HeikinAshi, S&R + Donchian, VWAP-σ, VolumeSurge, Ichimoku, PinBar.
- **Confidence-weighted voting** (`src/engine/aggregatorVoting.js`, shared by live/backtester/optimizer): each strategy's confidence is its vote weight; **HOLD is counted in the denominator** so `confidence = winner_weight / total_voters`. `2/3 BUY + 1 HOLD = 0.67` (not 1.00) — fixes the old resolution bug. Parity enforced by `tests/engine/aggregatorParity.test.js`.
- **Calibration**: `risk.confidenceThresholdScale = 0.65` scales legacy per-symbol thresholds for the new formula. Phase 4 retune **measured** this: 1.0 starves the bot, 0.65 is best risk-adjusted (validated forward-only). Keep at 0.65 unless a from-scratch per-symbol retune replaces the thresholds.
- **Multi-bar confirmation**: borderline entries (within ~0.10 of minConf) need the previous bar to agree.
- **Regime gate** (`engine/regimeClassifier.js`): BTC EMA200×ADX 2×2 with 3-bar hysteresis; bear policy closes all + blocks entries on transition into `BEAR_TREND` (`bearPolicy.mode='trend_only'`). Regime routing infra exists but is OFF and known-buggy — don't enable it without a fix and a forward-only test.
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

## Live ≡ Backtest (hard invariant — nine ways it has actually broken)

The cardinal rule is that live and backtest produce identical decisions from identical inputs.
Parity has broken nine times in ways that were invisible for weeks. Check these on any change
touching signals, thresholds, or candle handling:

| Break | Symptom | Guard |
|---|---|---|
| **Threshold read raw instead of scaled** | Aggregator gated at `raw × 0.65`, `riskManager.canTrade()` re-gated at raw → live ran at the "STARVED" calibration and took **0 trades in 27 days** | Every threshold read goes through `scaleMinConfidence()`; `tests/utils/confidenceThresholdParity.test.js` |
| **In-memory candle merge first-wins** | Forming bar frozen into history, closed version discarded → live scored TIA CCI 49.1 vs backtest 76.7 on *identical on-disk data* | Payload-wins merge; `tests/dashboard/candleMerge.test.js` |
| **Cycle drifted off candle close** | A host suspend left the loop firing 6h09m late for 48 consecutive cycles — different MTF/regime inputs than the backtester models | `createAlignedScheduler` re-derives from the clock; `tests/core/cycleScheduler.test.js` |
| **Min notional enforced live only** | The simulator filled orders Binance would reject, so the deployment sweep reported an identical trade count at every position size | Shared `exchangeLimits.js`; `tests/backtester/minNotional.test.js` |
| **Downloader merge first-wins** | The last cached bar was still forming when written; it froze and the corrected version was discarded on every later run — corrupting the research data itself. BTC's 2026-06-24 04:00 4h bar closed at 62839.11 while the next opened at 62591.50, with ~40% of its true volume | Payload-wins merge + `--repair`; `tests/scripts/downloadHistoryMerge.test.js` |
| **Startup seed merge first-wins** | `initializeHistoricalData`'s `!seen.has(ts)` filter dropped the exchange's corrected copy of the newest cached bar on every boot — and the seed re-persists what it loads, so each restart re-froze the previous boot's partial bar. 36 of 37 symbols carried frozen 12h bars on the 2026-07-02/07-29/07-30 restart dates | Shared `mergeCandles()`; `tests/utils/mergeCandles.test.js` |
| **Backtester stepped by array index** | `PortfolioBacktester` read every symbol's row *k* at step *k* while regime/macro read BTC's bar *k*, so a late-listed or gapped symbol traded on a different date from the rest of the book — slots, regime, macro and the equity curve mixed times. 34 of 37 symbols were misaligned on the 2020→2026 deep data (NEAR's 2024-07-13 bar traded at BTC-time 2021-01-01), 6–8 on the baseline's long windows | Step over the union of timestamps, rows looked up by time, BTC read as of the step; `tests/backtester/timeAlignment.test.js` |
| **Correlation matrix static in backtests** | Live rebuilds the cap's matrix every cycle from the last `correlation.period` (60) bars; the backtester built one matrix from the first half of each symbol's history (future bars for half the run) and ignored the period. The inventory row passed on the word "correlation" | Backtester calls live's `buildCorrelationMatrix` as of each step; inventory row pinned to it; `timeAlignment.test.js` |
| **Weekly DD breaker inert in backtests** | `calcWeeklyDDBreaker` sums SELL records keyed by `timestamp` (live's trade log); simulator trades are round trips (`side: 'LONG'`, `exitTime`), so every one was filtered out and the breaker never fired in any backtest | Trades mapped to the live shape at the call; `timeAlignment.test.js` |

**Three of the nine were merges** — plus a fourth hand-rolled site, `saveCachedCandles`' blind
overwrite, which truncated backfilled disk history without breaking decisions (see the merge rule
under Architecture Rules). A frozen partial bar is silent: it corrupts every indicator computed
from it and nothing errors. Repair with `npm run download-history -- --timeframe <tf> --repair`,
then verify with `rebuildDeepHistory.mjs`.

**The structural guard: `tests/backtester/liveParityInventory.test.js`.** Every rule that can reject
or resize a live entry is listed there with the symbol implementing it on *both* sides. Adding a
live-side rule without a backtest counterpart fails that fixture immediately, instead of surfacing
months later in a soak post-mortem. **When it fails, do not delete the row** — implement the missing
side, or move it to `INTENTIONALLY_LIVE_ONLY` with a written reason. Every break above was a rule
that existed on one side only; reviewing the diff never caught them, because the omission is
invisible in a diff.

Two rules that follow: **a second gate is a bug unless it reads the same scaled value**, and
**anything that feeds the strategies must be reproducible from disk.** When live and a backtest
disagree, suspect the in-memory path before suspecting the data.

**What the breaks look like in a diff** — the checklist every reviewer runs:
- a `minConfidence` compared without going through `scaleMinConfidence()` — a second gate on the raw value silently overrides the first;
- a candle merge that keeps the existing record on a timestamp collision (`seen.has(ts) → skip`, the existing array spread first), or any merge not done by `mergeCandles()`;
- cycle timing from a fixed `setInterval` instead of re-deriving the next fire time from the clock — started after an awaited run, it bakes in a permanent phase offset;
- a candle-availability check that tests `length > 0` but not freshness — a fetch can return stale bars forever;
- a new live-side rejection or sizing rule with no row in `liveParityInventory.test.js`;
- a per-symbol array index used as a clock across symbols — anything cross-sectional steps by timestamp;
- a series or matrix computed once and consulted at every step, where live rebuilds it each cycle;
- a shared helper fed records of a different shape than live feeds it — a filter that drops every
  record fails silently, and a presence check (`liveParityInventory`) cannot see it.

## Stale / frozen market data

Thin or delisted pairs keep returning klines that never advance — Binance had no 12h candles for
LSK past 2026-06-12, TON past 06-30, GMX past 07-10 (LSK's last bar has volume 0.0). An empty-fetch
check does **not** catch this. `checkCandleFreshness()` skips a symbol whose newest bar is older
than `config.maxCandleStalenessPeriods` (default 2 periods = 24h); it guards the signal cycle, the
startup seed, and the TSM sleeve. Never bypass it to "get more symbols trading".

## Strategy Registration

Strategies are classes in `src/strategies/` (`analyze(candles)` → `{ name, signal, value, confidence, reason }`).
A strategy name used in `config/default.js` needs four entries in `src/utils/strategyBuilder.js` —
the import, `STRATEGY_BUILDERS`, `STRATEGY_REASON_PREFIX`, `STRATEGY_TRIGGER_HINTS` — or the bot
crashes on startup. Also export it from `src/strategies/index.js` and describe it in
`src/strategies/registry.js` (dashboard metadata). Verify with the boot test.

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

```bash
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --candles 730   # Y2
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs --candles 1460  # full OOS
PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs                # dry-run optimizer
```

### Full filter stack in every portfolio backtest

Portfolio backtests and the optimizer run the same filters as the live bot; a result without them
overstates performance and is not valid for decisions. Required `PortfolioBacktester` config:
```js
mtfFilter: true,          // 15m alignment (load 15m candles per symbol)
mtf4hFilter: true,        // 4h EMA+RSI momentum (load 4h candles per symbol)
regimeSizing: true,       // ADX-based sizing (boost trends, penalise chop)
macroFilter: true,        // BTC EMA200 bear filter (halve size below)
confSizing: true,         // confidence-proportional sizing (0.6×–1.5×)
breakEvenTriggerPct: 0.05 // break-even stop at +5%
```

Every tested symbol needs `data/candles/{COIN}_USDC_4h.json` and `data/candles/{COIN}_USDC_15m.json`;
download missing MTF data before reporting results.

## Key numbers that keep biting

- **Min notional $11** (`FALLBACK_MIN_NOTIONAL`; Binance's own floor is $10). `allocation =
  freeQuote × finalPositionPct`, and the multiplier chain (macro bear ×0.5, ADX chop ×0.5,
  confidence taper) routinely lands a small account under it. From 2,109 logged live sizing
  decisions: ~$600 clears the floor on ~99% of signals, $400 on ~89%, $189 on only ~42%. The
  backtester enforces the same floor, but the $1000 research budget never hits it — check any
  sizing change at live equity.
- **Docker on a laptop suspends.** The 2026-07 soak lost 6h11m to a host sleep; queued Binance
  requests fired on wake carrying signature timestamps from six hours earlier.
- Position restore threshold: $5. Cycles fire at UTC candle-close + 3s. `dashboard_persist.json`
  keeps max 100 trades, 50 signals. Two instances on one port shadow each other — kill the old one first.
- Env vars: `README.md` § Environment Variables. `TSM_CORE=true` in live mode places real orders.

# Bear-side study first, weekly review later

## Context

Two requests after the agentic-setup PR merged:

1. **Re-open the shorting / bear-market question (do first).** `docs/SHORTING_FEASIBILITY.md` ends
   with an unanswered checklist (is margin/perps available to this account? accept leverage
   risk?) and only analysed perps, never spot margin. Decided: measure **every** bear-side angle,
   singly and in sensible combinations, and answer availability from Binance's own sources.
   Constraint: **Europe, no USDT** — anything traded is USDC.
2. **A weekly review (later, on the live PC)** that checks the bot's health, reviews what happened
   and proposes improvements or new angles. Decided: private report + Telegram summary, run
   locally on the live PC.

The work moves to **another PC** to run tests; the live PC keeps running the bot.

**Status (2026-09-28):** Phase 1 done — run on the live PC after all, inside a separate git worktree
(`../PlayCryptoWithAI-research`, own `data/` and `node_modules`, `PLAYCRYPTO_RUNTIME_DIR` outside the
checkout, jobs under `nice`/`ionice`); the live bot's state files were verified unchanged. Results:
[`docs/BEAR_SIDE_STUDY.md`](../BEAR_SIDE_STUDY.md) — shorting rejected; idle-cash yield pending the
read-only probe run (needs a read-only API key in `.env.probe`). Phase 2 not started.

## Facts established while planning

- The repo is **public** → no balances, trades or account data in commits, PRs or reports in git.
- **Venue (Binance, sources to be cited in the feasibility doc):**
  - Futures/derivatives are **unavailable in Germany, Italy, Netherlands** (Binance announcement
    "Unavailability of Futures and Derivatives Products in Germany, Italy, and the Netherlands").
    Germany is assumed (Europe/Berlin host) → the USDC-perp route is very likely closed.
  - Binance's MiCA stablecoin notice: EEA **margin stays available with USDC** (USDC borrowing in
    Cross/Isolated Margin; USDT borrowing halted).
  - Binance has **no MiCA authorisation** since the 2026-07-01 deadline; reports conflict on what
    EU users keep (France lost spot/margin/futures; others cite reverse solicitation, disputed by
    ESMA). Live spot orders on this account still fill as of late September 2026. Venue risk for
    the whole bot — becomes a standing item in the weekly review.
  - Sources: binance.com announcements above; cryptonomist.ch 2026-09-08 "Binance EU MiCA
    licensing"; zyphe.com "Binance MiCA licence EU lockout July 2026"; casptracker.eu/exchange/binance.
- Account-level margin access can't be read from docs → a read-only API probe (Phase 1, step 1).
- On the **live PC only**: `data/candles` is shared with the running container and
  `src/exchange/candleCache.js` hard-codes that path, and the dashboard exposes live-acting POST
  endpoints (`/api/smoke-test`, `/api/close-position/:symbol`, `/api/reset-history`). The research
  PC has neither problem.

---

## Phase 1 — Bear-side study (research PC; research only, no live trading code)

### Research PC setup
- `git clone` + `git pull`, Node 22+, `npm ci`, `npm test` (expect ≥432 pass).
- Create a **new read-only Binance API key** (reading enabled; no trading, no withdrawals, no
  transfers) for the probe; put it in that PC's `.env`. Never copy the live trading key.
- `PAPER_MODE=true` for everything except the probe.

### Step 1 — Is margin/perps available to the account? (read-only probe)
- Add read-only `fetchMarginAccessReport()` to `src/exchange/binanceClient.js` (sole exchange
  caller): ccxt implicit **GET** calls only — API-key restrictions (`enableMargin`,
  `enableFutures`), isolated-margin pair list (is `BTC/USDC`, `ETH/USDC` there, which alts),
  isolated margin account for BTCUSDC/ETHUSDC, BTC/ETH borrow-interest history, futures balance.
  Keep every error verbatim — the codes are the evidence.
- `src/scripts/probeMarginAccess.mjs` prints the table. `security-reviewer` reviews the diff
  before it runs. With a read-only key it cannot trade even if the code were wrong.
- The result picks the cost model: isolated-margin borrow interest (expected) vs perp funding
  (only if futures are open).

### Step 2 — Data (USDC-first)
- Add a `--symbols` override to `src/scripts/downloadHistory.js` (merge logic untouched — still
  `mergeCandles()` payload-wins).
- **Primary results use USDC pairs only**: 2020+ via `rebuildDeepHistory.mjs` (4h → 12h), which
  covers the 2022 bear up to the 2022-09 → 2023-03 USDC gap, and the 2026 May–June drop.
- **"No USDT" handled explicitly:** nothing is traded in USDT. As a clearly labelled robustness
  check only, public USDT-pair *price history* stands in where no USDC pair existed (2018 bear,
  the 2022 gap), as `docs/TREND_CORE_STUDY.md` did. Drop this check if you want it out.

### Step 3 — Pre-registered study: `src/scripts/runBearSide.mjs`
Sim-only, on the `src/scripts/runTrendCore.mjs` pattern: decide on closed bar i, fill at bar i+1
open, 0.1% fee per leg + tiered slippage, no lookahead, DSR via
`src/backtester/deflatedSharpe.js` deflated for **all** trials so far (prior studies' count plus
every new cell). Grid and adoption gate go into the script header *before* the first run.

| Cell | What it does | Reuses |
|---|---|---|
| S1 Short BTC+ETH, 1× isolated | Mirror of the TSM sleeve: short at 0/3 positive votes, stay while ≤1/3; gated on `BEAR_TREND` (+ ungated variant) | `computeTsmVote` (`src/engine/tsmCore.js`), `RegimeTracker` (`src/engine/regimeClassifier.js`) |
| S2 Short alts on scalper SELLs | Scalper SELL decisions in `BEAR_TREND` opened as shorts, mirrored per-symbol SL/TP, only symbols with an isolated USDC margin pair | New read-only public accessor on `PortfolioBacktester` for its precomputed decisions (`#precomputeData`; no behaviour change) |
| S3 PAXG rotation | Idle bear capital held in PAXG while `BEAR_TREND` | regime series |
| S4 Yield on idle USDC | APR bands on bear-time cash; flagged: Binance Earn reportedly suspended for EU since 2026-07-01 | — |
| Combos | S1+S3, S1+S4, S3+S4, S1+S2, S1+S3+S4, all four | — |

- Each cell is evaluated **added to today's book** (scalper + TSM sleeve), combined the way
  `src/scripts/runSleeveCorrelation.mjs` combines the two existing sleeves.
- Costs: real recent borrow rates from the probe plus 2/5/10/20% APR bands as sensitivity; 1×
  and 2× liquidation modelled (event count, worst squeeze / max adverse excursion).
- Windows: full history, each bear separately, forward-only holdout split, worst-entry robustness.
- **Gate (pre-registered):** "worth building" only if combined-account Sharpe rises, combined max
  DD does not worsen, DSR ≥ 0.5, no liquidation at 1×, and the probe confirms the venue.
  Everything else is recorded as rejected (revert-don't-patch).
- `backtest-reviewer` reviews the script and the numbers before any conclusion is written.

### Step 4 — Write-up
- New `docs/BEAR_SIDE_STUDY.md` (linked from README): grid, per-cell and per-combo results, verdicts.
- `docs/SHORTING_FEASIBILITY.md`: venue facts with sources and dates, the missing spot-margin
  route, probe results, checklist answered.
- `docs/STRATEGY.md` "What Was Tested & Decided": one row per angle.

**Out of scope:** live short/rotation/margin code. If a cell passes the gate, building it
(`MarginTrader`, parity fixtures, `liveParityInventory` rows, dashboard, default-OFF flag) is a
separate plan.

---

## Phase 2 — Weekly review (later, on the live PC)

**Safety design:** Claude never touches the live system. A deterministic wrapper snapshots live
state first; Claude works on the copies inside a sandboxed worktree; the wrapper delivers the
report and the Telegram message.

- `ops/weekly-review/run.sh`:
  1. Research worktree `~/.cache/playcrypto-research` (`git worktree add --detach`), updated to
     `origin/master`, `npm ci` when the lockfile changed.
  2. Snapshot into `<wt>/run/<date>/` (read-only, no LLM): `docker inspect` / `stats
     --no-stream` / `logs --since 8d playcrypto-bot`; `GET localhost:3001/api/status` and
     `/api/performance`; the last 8 `logs/app-*.log` + `error-*.log`, `logs/trades.csv`,
     `data/equity_history.json`, `data/position_state.json`, `data/dashboard_persist.json`;
     `git log --since 8.days`; previous reports.
  3. rsync `data/candles/` → `<wt>/data/candles/` (the live dir is never written).
  4. `claude -p "Run the weekly review in .claude/skills/weekly-review/SKILL.md for run/<date>"
     --model claude-opus-5-5 --effort high --permission-mode dontAsk
     --settings ops/weekly-review/settings.json --output-format json`, cwd = worktree.
  5. Copy the report to `reports/weekly/<date>.md` in the main checkout (gitignored).
  6. `node src/scripts/notifyReport.mjs <report>` sends the `## Summary`; on any failure it sends
     a failure notice instead — a silent failed run is not allowed.
- `ops/weekly-review/settings.json`: sandbox on (bubblewrap; `bwrap` + `socat` present); writes
  only inside the worktree; network allowlist `api.binance.com`, `data-api.binance.vision`,
  `registry.npmjs.org` — no localhost, so no dashboard; `autoAllowBashIfSandboxed`; allow
  `WebSearch`/`WebFetch` for the venue watch; deny reading `.env`.
- `.claude/skills/weekly-review/SKILL.md` (`disable-model-invocation: true`; also `/weekly-review`).
  Report sections: **Summary** (Telegram text) · **Health** (uptime/restarts, cycles vs 14/week,
  watchdog, grouped errors, exchange timeouts, halted/stale symbols, MTF coverage, disk) ·
  **Trading week** (trades, P&L, equity vs last report, open positions, blocked entries by reason,
  min-notional rejections, regime changes, TSM actions, `[DRIFT]` lines) · **Venue & regulatory
  watch** (Binance EU/Germany, MiCA, `BREAK`/delisted symbols) · **Since last report** ·
  **Ideas** (hypothesis, cheapest measurement, expected effect; checked against STRATEGY.md "What
  Was Tested & Decided"; at most one time-boxed measurement per run; suggestions only).
- `src/notifications/telegramNotifier.js`: add `notifyInfo(text)`, export it from
  `src/notifications/index.js`; `src/scripts/notifyReport.mjs` uses it.
- `ops/systemd/playcrypto-weekly-review.{service,timer}`: `OnCalendar=Sun *-*-* 03:17`
  (Europe/Berlin), `Persistent=true`. Install into `~/.config/systemd/user/`, `systemctl --user
  enable --now playcrypto-weekly-review.timer`, and run `loginctl enable-linger $USER` once.
- `.gitignore` adds `reports/`; `docs/WORKFLOW.md` gets a "Weekly review" section; README link.

---

## Verification

- Every change: `node --check` on new/changed scripts; `npm test` (≥432 pass). Boot tests use
  `PLAYCRYPTO_RUNTIME_DIR=$(mktemp -d)` (see `CLAUDE.md`) so they never write bot state.
- Phase 1: probe output captured verbatim in the feasibility doc; `runBearSide.mjs` twice gives
  identical numbers; the printed DSR trial count equals prior + new cells; `backtest-reviewer` PASS.
- Phase 2: `systemd-analyze --user verify` on the units; one manual `systemctl --user start
  playcrypto-weekly-review.service` → report in `reports/weekly/`, Telegram summary arrives,
  `journalctl --user -u playcrypto-weekly-review` clean; from inside a run, a harmless
  `curl localhost:3001/api/status` is blocked and reading `.env` is denied; `git status` in the
  main checkout is clean.
- Each phase lands on its own branch → PR.

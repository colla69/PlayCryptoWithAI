# Plan: one engine for backtest and live — handoff (2026-10-24)

**Status: not started.** Prepared on the live PC on 2026-10-24; the work continues on the research
machine. Background: [EXTERNAL_BOTS_REVIEW.md](../EXTERNAL_BOTS_REVIEW.md) (NautilusTrader section)
and item 4 of [the backtester follow-ups](2026-09-backtester-parity-followups.md).

## Decisions already made

Agreed with the user on 2026-10-24. Do not reopen them without new evidence.

- **Goal:** backtest and live run the same decision code, the way NautilusTrader does. Only the
  data source and the order handler differ.
- **No big-bang rewrite.** Work in steps, one PR per step, each with a before/after baseline.
- **The live bot is the reference.** It is doing well and stays untouched until the reconciliation
  (step 1) shows that the backtest reproduces it. Steps 1–3 change only backtester code.
- **No paper-shadow runs** (user decision). After a backtest, the next test is promoting one change
  at a time to live, with the previous config kept for a rollback.
- **Overfitting** stays handled by the existing checks (walk-forward, deflated Sharpe, MIN_TRADES ≥ 8
  on the holdout). An accurate backtest does not remove it.
- **Paths that never ran live** (bear-regime switch, weekly DD breaker, a gap down through a stop)
  cannot be reconciled. Parity there comes only from shared code plus the parity tests.
- **The bot should keep improving.** This work is what makes improving it safe, not a freeze.

## What the live bot runs

Checked on the live PC on 2026-10-24:

- Container `playcrypto-bot` runs **commit `833c393`** (2026-08-10). `docker cp` of `/app/src` and
  `/app/config` out of the container matches `git archive 833c393 src config` with 0 differing
  files. The container was last started 2026-10-17 15:06 UTC, with 0 restarts.
- `master` (`401e898`) differs from it in backtester files, test isolation and `runtimeDir()` paths
  only. `config/default.js` is unchanged. So `master`'s live-side logic is what trades.
- Mode settings in `.env`: `PAPER_MODE=false`, `BINANCE_TESTNET=false`, `SMOKE_TEST=false`,
  `TSM_CORE=true`. Secrets were not copied.

## The snapshot

`~/playcrypto-rebuild-snapshot-2026-10-24.tar.gz` on the live PC, 74 MB, cut 2026-10-24 16:30 UTC,
sha256 `87d482f82fcbb2cefa826cf0fe204c7e83206700c8d6b9eaca8e7c023e377da8`.

| Content | Covers | Use |
|---|---|---|
| `data/dashboard_persist.json` | 32 trades, 2026-08-03 → 2026-10-23, with `reason`, `entryPrice`, `exitPrice`, `openedAt` | trade-by-trade comparison |
| `logs/trades.csv` | the same 32 trades (`timestamp,symbol,side,price,qty,pnl,balance`) | cross-check |
| `data/signal_history.json` | 5000 per-symbol decisions, 2026-08-20 → 2026-10-24 12:00, with `confidence`, `blockReason`, `strategies` | **cycle-by-cycle comparison** — far more evidence than 32 trades |
| `logs/app-*.log`, `logs/error-*.log` | 2026-09-25 → 2026-10-24 (older logs rotated out) | exit reasons, sizing, rejections |
| `data/deposits.json` | deposits 2026-07-02 ($189.43), 2026-08-19 ($24.92), 2026-09-28, … | live sizing scales off equity |
| `data/equity_history.json`, `data/position_state.json` | equity curve, open positions at the cut | starting and ending state |
| `data/candles/` (126 USDC files) | 12h 2024-08-05 → 2026-10-17 12:00; 4h and 15m **end 2026-08-10** | what live booted with on 2026-10-17 |
| `data/marketContext/`, `fearGreed.json`, `nasdaqTrend.json`, `qualifying_symbols.json` | context inputs | gates |

`data/backups/` is left out on purpose: it holds the 2026-09-28 test-pollution backup with fixture
trades.

Candle fingerprint of the archive (the one-liner from
[the fix-status doc](2026-09-backtester-fix-status.md#the-data-snapshot)): `126
762e13cca76e3bdff83462fd24cb384f915300a22489bd4c811c3978cca41058`. The live bot persists 12h
candles only when it boots, and the 4h and 15m caches stopped at the last research download. So the
candles must be extended to the cut on the research machine (step 0). The deep 2019+ history is in
the 2026-08-10 snapshot from the fix-status doc.

## Steps

**0. Set up the research machine.**

```bash
git fetch origin && git switch docs/external-bot-review && npm ci   # or branch off it
scp <live-pc>:playcrypto-rebuild-snapshot-2026-10-24.tar.gz .
mkdir -p rebuild-snapshot && tar -xzf playcrypto-rebuild-snapshot-2026-10-24.tar.gz -C rebuild-snapshot
sha256sum playcrypto-rebuild-snapshot-2026-10-24.tar.gz              # → 87d482f8…
cp -r rebuild-snapshot/data/candles data/   # then extend 12h, 4h, 15m to the cut, payload-wins:
npm run download-history -- --timeframe 12h   # repeat for 4h and 15m
npm test                                      # must be green before anything else
```

Freeze the extended candles and record their fingerprint here, so every later run uses the same
inputs.

**1. Reconciliation (new script, backtester side only).** Replay 2026-08-03 → the cut with the live
config, `TSM_CORE=true`, live sizing (the deposits in `deposits.json` added on their dates) and the
live starting balance. Then compare:

- **Per cycle:** the decision, confidence and `blockReason` per symbol against
  `signal_history.json` (from 2026-08-20).
- **Per trade:** entries, exits, prices and exit reasons against `dashboard_persist.json`.

The TSM core sleeve (`#core` symbols) is simulated by `runTrendCore`, not `PortfolioBacktester`, so
compare it separately. Load 12h history from the same start live has (2024-08-05) so that EMA200 and
ADX start from the same bar. Loading the 2019+ history as well measures how much the indicator start
matters (Freqtrade's `recursive-analysis` idea).

Expected mismatches before any fix: follow-ups item 1 (fills one bar later than live), item 2
(equity marks one position at a time), item 4 (stops at bar close only). Report each mismatch with
its cause. An unexplained mismatch is a new parity gap: add it to the follow-ups plan.

Rerun the reconciliation on a schedule (for example with the weekly review job) on fresh live
history. Each new live period checks more of the code.

**2. Fix the gaps, largest mismatch first.** One PR per follow-ups item, in the order the
reconciliation ranks them. Each PR reruns the reconciliation, `runBaseline.mjs` and the walk-forward.
If the baseline gets worse, that is the measurement getting honest, not a regression to revert.
After item 4 (stops), rerun the optimizer: the per-symbol stops were chosen under close-only exits.

For item 4, the simulator calls `calcTrailingStop` and `calcBreakEven` from `traderUtils.js`. Keep
the arm-after-profit check (`trailArmPct`) in the simulator, around the shared call, so
`traderUtils.js` and live do not change.

**3. One decision core.** Move every per-cycle decision (aggregate, gate, size, exit check) into
pure functions that both live and the backtester call. Pin `liveParityInventory.test.js` to those
functions, not to substrings. This touches live code, so prove "no behaviour change": the
reconciliation and a replay of `signal_history.json` must give identical decisions before and after.
Then run the boot test and deploy as its own release.

**4. Later: one event loop and one order interface.** A replay source emits the same "bar closed"
and "price tick" events as the live scheduler and price poll. `paperTrader`, `liveTrader` and
`BacktestSimulator` become order handlers behind one interface. Plan this only after step 3 is
live and stable.

## Constraints

- Nothing in this plan writes to the live PC. The snapshot is a copy.
- On a machine with limited RAM, run full-filter backtests one at a time (the 2026-09-29 incident in
  the fix-status doc).
- Validation for every code change: `node --check`, `npm test`, boot test; backtests for anything
  touching strategy, risk or sizing (`CLAUDE.md`).

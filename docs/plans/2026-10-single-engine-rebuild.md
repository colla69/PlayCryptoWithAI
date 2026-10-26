# Plan: one engine for backtest and live — handoff (2026-10-24)

**Status: step 0 done; step 1 in progress — layer 1 (per-cycle signals) done 2026-10-24, layers 2–3
open.** Prepared on the live PC on 2026-10-24; the work continues on the research machine.
Background: [EXTERNAL_BOTS_REVIEW.md](../EXTERNAL_BOTS_REVIEW.md) (NautilusTrader section)
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

**Step 0 result (research Mac, 2026-10-24).** Done with two changes to the commands above:

- **Do not `cp -r` over `data/candles`.** The research machine's `data/candles` already held the deep
  2019+ set (BTC 12h: 4,689 bars) that the old-engine baseline was measured on. The snapshot's 12h
  files are the live bot's shallower copy (from 2024-08-05). The two sets now live side by side:
  `data/candles` = the live set, extended and frozen; `data/candles_deep_2026-08-10/` = the
  baseline set, untouched (fingerprint `126 36a73a13…`, as in the fix-status doc). The code reads
  only `data/candles` (`candleCache.js` has no override), so **swap the two directories by
  renaming before any run that must match the old baseline**, and swap back.
- **Extend to the cut, not to now.** The downloader also fetches the still-forming bar. Every file
  was trimmed to bars closed by `2026-10-24T12:00Z` (the last logged cycle), so no partial bar is
  frozen into the set:

  ```bash
  node -e "const fs=require('fs');const CUT=Date.parse('2026-10-24T12:00:00Z');const TF={'12h':43200000,'4h':14400000,'15m':900000};for(const f of fs.readdirSync('data/candles')){const m=f.match(/_USDC_(12h|4h|15m)\.json\$/);if(!m)continue;const p='data/candles/'+f;const a=JSON.parse(fs.readFileSync(p));const k=a.filter(c=>c.timestamp+TF[m[1]]<=CUT);if(k.length!==a.length)fs.writeFileSync(p,JSON.stringify(k))}"
  ```

- **Frozen fingerprint** (same one-liner as the fix-status doc): `126
  56c35002f40f1f220be1558bc65d5757a7764ddd53ad06d03df643164ece8596`. 12h still starts
  2024-08-05 and ends 2026-10-24 00:00; 4h ends 08:00; 15m ends 11:45. A protected copy is at
  `~/Sandbox/frozen-candles-2026-10-24/` — a paper boot of `src/main.js` rewrites `data/candles`,
  so restore from it after any boot test and re-check the fingerprint.
- **Integrity check against the snapshot.** No bar was lost or changed except at each file's tail.
  The 33 changed 12h bars are one per active symbol: the live bot's 2026-10-17 12:00 bar, persisted
  at its boot while still forming, now corrected payload-wins. `npm test`: 443 pass, 0 fail.

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

**Layer 1 result — per-cycle signals (2026-10-24).** `src/scripts/runReconciliation.mjs --snapshot
<dir>` (about 40 s). It builds strategies and thresholds with live's own functions
(`buildStrategiesForSymbol`, `getSignalConfigForSymbol`) and asserts the backtester's effective
threshold equals live's for every symbol (it does). 132 cycles, 2026-08-20 → 10-24, 33 symbols:

| | Signals |
|---|---|
| Compared (live record with a backtest row) | 4,307 |
| Exact match (decision, and confidence within live's 4-decimal rounding) | 4,270 (99.14%) |
| Live decided on a series that ended one bar early | 36 |
| Same cause, carried through the aggregator's multi-bar memory | 1 |
| **Unexplained** | **0** |

- **Live parity gap, found: the cycle can run on a stale bar.** The cycle fires 3–5 s after the
  close. A thin pair may not have printed its first trade yet, so the exchange returns no bar for
  the new period and the series ends at the bar that just closed. Every strategy then drops its
  last bar (`slice(0, -1)`) — the one that just closed — and decides one bar older than the
  backtester, which always has the bar. Log evidence: `[CYCLE] ENS/USDC: starting cycle,
  candles=1588 … lastTs=2026-10-07T12:00:00.000Z` at `2026-10-08T00:00:04Z`. Over the 1,974 cycles in
  the logs, the 1,943 whose series included the forming bar had **0** mismatches; of the 31 that
  did not, 23 mismatch (the rest agree by chance). All 37 mismatches are in five thin pairs: ENS 15,
  JUP 10, THETA 9, MANTA 2, BNB 1. Proof without logs: each live value equals the backtester's
  *previous* row (36 of 37). The 37th (MANTA 09-21 12:00: same confidence 0.5167, SELL live vs HOLD
  backtest) is borderline (threshold 0.455, so the ceiling is 0.555) and the previous cycle was a stale-bar SELL, which
  the multi-bar gate (`lastDecisions`) then confirmed on live only. That last link is consistent with
  the numbers, and the item-5 replay confirms it.
  **Exposure:** no order was affected in this window (34 HOLD/HOLD, 3 SELL/HOLD, none held, no BUY
  on either side), but a BUY on a thin pair would be. The fix is on the live side (decide on bars
  closed by timestamp, or wait for or synthesise the new bar) and is a behaviour change, so it is its
  own release. Item 5 of [the follow-ups](2026-09-backtester-parity-followups.md) — fixed the same day with `withFormingBar()`; a replay on the frozen candles turns all 37 mismatches into matches.
- **Asymmetric exit (live-only 0.7× SELL rule): not tested by this data.** It never fired — 0 log
  lines in `app-*.log`, 0 live SELL records inside a held interval. `main.js` implements it; nothing
  in `src/backtester/` does, and `liveParityInventory.test.js` has no row for it. Left as a
  hypothesis until live has a period where it fires.
- **Skipped cycles (16 backtest rows with no live record):** 5 are the first cycle (the 5000-record
  cap cut it to 28 of 33 symbols); 6 are `klines` calls that failed at the close (HTTP 500 or
  `-1001`, 8–10 s after the boundary) — the symbol's cycle is lost and not retried for 12 h; 1 is the
  position-aging exit, which returns before logging a signal; 4 predate the retained logs.
- **Trade exit reasons are mostly missing** in `dashboard_persist.json` (12 of 13 closed scalper
  trades have `reason` undefined), so layer 3 reads reasons from `logs/trades.csv` and the app log.

**Layer 2 result — entry filters on each live BUY (2026-10-24).** Same script. Live logs the value
that blocked a BUY (`blockReason`). For each of the 32 live BUYs (31 blocked by MTF 15m, 4h or
momentum, or passed; 1 blocked by BTC.D, not modelled) the script computes each filter three ways:

| Method | Same pass/block as live | Same reason | Same logged value |
|---|---|---|---|
| Backtester as coded — last 15m/4h bar inside `[T, T+12h)`, momentum to bar `T`'s close | 28/31 | 22/31 | 2/25 |
| Bars closed by the cycle time `T` | **31/31** | 29/31 | 12/25 |
| Live's cache rebuilt from the logged refresh times (log window only) | 10/10 | 8/10 | 6/9 |

- **The backtester's gates look up to 12 h ahead.** This is follow-ups item 1 ("the gates must
  move with it"), now measured. Example: PEPE 2026-08-20 — live saw a −0.7% 20-bar return and
  blocked; the backtester reads the close 12 h later (+8.6%) and passes.
- **Bars closed by `T` reproduce live.** Momentum and the 15m score match live's logged numbers
  exactly (4/4 and 8/9). The two "same reason" misses block on both sides; only the first filter
  to report differs.
- **The 4h values are close but not exact** (live 25 vs 24, 33 vs 32, 43 vs 47). Live reads 15m and
  4h from caches that a `setInterval` counted from boot refreshes (`refreshMtfCache`: 15 min,
  4 h). At a 00:00 cycle, the 4h cache was last fetched at 23:43 (before the 10-17 boot) or 23:06
  (after it), so its newest bar is the 20:00 bar, part-formed. That part-formed bar cannot be
  rebuilt from disk, which is why no method matches the 4h values exactly. Follow-ups item 9.

**Layer 3 result — scalper trades (2026-10-24).** Same script. It runs the real `PortfolioBacktester`
with live's filter stack and sizing (`maxPositionPct` 0.15) over the whole history. It trades only
from the first logged cycle (`tradeFromTs`, so the indicators and the multi-bar memory start warm,
as live's did), from live's free balance then ($118.40), with the 2026-09-28 deposit added on its
date (`deposits`). Both options are new and off by default. Live made 6 round trips in the window:

| Live trade | Backtest | Cause |
|---|---|---|
| DOGE, INJ, LDO, BTC, PEPE | same entry cycle; fill 0.4–5.3% worse | fill at the next bar's open, 12 h after live (item 1) |
| CRV 09-09 entered | no trade | gates read 12 h ahead (item 1; layer 2) |
| — (live blocked) | PEPE 08-20, LDO 09-04 entered | same cause: momentum −0.7% vs +8.6%, MTF 29 vs 53 |
| INJ stop 09-15 07:35 at −0.1% (break-even) | stop at the 12:00 close, −13.7% | stops at the bar close only (item 4) |
| LDO take-profit 09-25 18:51 (+12.7%) | no take-profit; stopped 09-28 | item 4, plus the later, higher fill |
| BTC aging exit 09-26 **12:00** | aging exit 09-26 **00:00** | live counts age from the fill, 15 s after the cycle (item 10) |
| Sizes LDO 0.169, PEPE 0.135, BTC 0.273 | 0.175, 0.142, **0.141** | backtests never applied ATR sizing (item 11) |

- **Item 11 is a parity break, now fixed in the backtester.** Live applies ATR inverse-volatility
  sizing to every entry (`config.atr.enabled: true`, `applyATRSizing` first in
  `computePositionSize`). `FULL_LIVE_FILTERS` never turned the backtester's `atrPositionSizing`
  on, and the inventory had no row, so every baseline was sized without it. With it on, the
  replay's sizes move to live's: INJ 0.117 vs 0.121, BTC 0.282 vs 0.273, LDO 0.160 vs 0.169,
  PEPE 0.140 vs 0.135 (mean error 0.047 → 0.007 without DOGE). The backtester's private ATR copy now
  calls the shared `computeATRPct`; the golden in `timeAlignment.test.js` proves that is an
  identity. **Unverified:** DOGE 08-20 (live 0.146, backtest 0.287 — about one ADX ×0.5 step;
  the logs from that day rotated out).
- **The ETH position opened 2026-08-03 has no recorded exit.** No SELL in `trades.csv` or the
  persisted trades, and it is not in `position_state.json` at the cut. The replay treats it as
  closed before 08-20. Unverified.

**TSM sleeve.** `runTrendCore.mjs` is a separate research copy of the vote logic (it imports
none of `src/engine/tsmCore.js`), so the sleeve was replayed with live's own `computeTsmVote` on
the frozen candles instead: **118 of 118** logged `[TSM-CORE] … votes p/t` cycles match (a
one-bar-older replay matches only 102, so the test can tell). Sleeve sizes and resizes were not
compared.

**Step 1 is complete.** Every difference in all three layers and the sleeve has a named cause. The
causes, largest first, with where each is fixed:

| Gap | Side | Status |
|---|---|---|
| Fills and gates one bar ahead (follow-ups 1) | backtester | open — the largest: 3 of 6 trades and 3 of 31 BUY outcomes differ |
| Stops at bar close only (4) | backtester | open — INJ −13.7% vs live −0.1%, LDO TP missed |
| ATR sizing never applied (11) | backtester | **fixed** — BTC size 0.14 → 0.28 (live 0.27) |
| Cycle-level gates on the previous cycle's candles (12) | live | open — regime/macro 24 h from the backtester |
| Stale bar on thin pairs (5) | live | **fixed** — 37 → 0 mismatches in the replay |
| 15m/4h cache on a boot-time timer (9) | live | open |
| Aging exit one cycle late (10) | live | open |
| klines failure loses the cycle (6) | live | open |

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

## Step 2 result (2026-10-24)

All twelve follow-up items are fixed (table in
[the follow-ups](2026-09-backtester-parity-followups.md)). The reconciliation on the new engine:
layer 3 matches **6 of 6** live trades (before: 5, plus 2 the live bot never made), entry fills
within 0–0.3% of live, and the DOGE target, CRV stop and LDO target within 6–9 minutes of live.
The remaining exit differences are calibration (the slippage tier also moves the break-even
reference) and live's old aging timing (item 10, fixed on live).

Baseline on the deep set (`126 36a73a13…`), research context, `runBaseline.mjs`:

| full_history | Return | Sharpe | DD | WR | DSR |
|---|---|---|---|---|---|
| c3 (committed engine) | +140.7% | 1.08 | −8.8% | 60% | 0.13 |
| + ATR sizing (item 11) | +115.4% | 1.03 | −8.5% | 60% | 0.10 |
| + fills and gates at the cycle time, stops still at the close (attribution run) | +103.3% | 1.19 | −5.8% | 65% | 0.33 |
| + stops inside the bar (item 4) = the live-timing engine | **+37.3%** | **0.69** | −8.1% | 49% | 0.02 |

| Window | live-timing engine |
|---|---|
| y2_365d (in-sample) | −1.15%, Sharpe −0.09, DD −7.46% |
| y1y2_full (OOS) | +31.24%, Sharpe 1.22, DD −8.11% |
| walk-forward, live sizing | +23.33%, Sharpe 0.80, DD −4.56%, DSR 0.04 (was +68.69% / 1.21 / −3.81% / 0.23) |

**Reading.** The fill and gate fixes alone improve the risk-adjusted numbers. Almost all of the drop
is item 4. Close-only stops flattered the strategy twice: a target was booked at the 12 h close,
past the target (take-profit P&L $1,272 → $584), and the break-even exits that live takes inside the
bar never happened (stops 17 → 36, most near zero). Layer 3 shows the intrabar replay is what live
does. Per this plan, that is the measurement getting honest, not a regression to revert — but it
means the edge the bot was deployed on is much smaller than every earlier baseline said.

**Next (step 2, as planned):** re-run the optimizer. The per-symbol SL/TP and the +5% break-even were
chosen under close-only exits, and the optimizer now replays stops (on 12h OHLC). Any new config is a
strategy change: walk-forward, MIN_TRADES ≥ 8, DSR, then one change at a time to live.

## Step 3 result — one decision core (2026-10-24)

`src/core/decisionCore.js` holds the per-cycle decisions both sides call: `evaluateEntryGates`
(weekly DD, BTC.D, regime, correlation, MTF 15m, 4h, momentum — in live's order, with live's
messages) and `resolveDecision` (the asymmetric exit). Sizing goes through the existing
`computePositionSize` on both sides; exits through `traderUtils.js` (step 2). Each side keeps only
its data access: `core/filters.js` fetches and logs, `PortfolioBacktester` slices its arrays.
Research-only knobs (Kelly, the regime-label tilt, skip-bear, the volume and F&G filters) stay in
the backtester, labelled as such. The inventory rows for these rules are pinned to the core
functions, and `tests/core/decisionCore.test.js` pins their behaviour.

**No behaviour change, proven:**

- Live: the old `runEntryFilters` (frozen from `HEAD`) and the new one on 4,000 random scenarios with
  every gate on or off and random thresholds — 2,378 blocked across all six gates, **0 differ**.
  BTC.D gate swept across the file's delta: 1,202 cases, 291 blocked, 0 differ. Asymmetric exit:
  20,000 scenarios, 949 fired, 0 differ. Boot test: 33 decisions, 0 errors.
- Backtester: the golden in `timeAlignment.test.js` is unchanged (trades, equity and counters). The
  reconciliation's three layers are identical; only the replay's filter counters move to live's
  order (momentum 18 → 4, MTF 5 → 9, 4h 1 → 11, same 24 blocks), and `positionPct` differs in the
  16th digit from the multiplication order. Deep baseline (`runBaseline.mjs`): every window identical to the step-2 engine.

## Stop retune, first sweep (2026-10-24)

`src/scripts/runStopSweep.mjs` — pre-registered 27-cell grid (stop-loss scale × {0.75, 1, 1.5},
take-profit scale × {0.75, 1, 1.5}, break-even ∈ {off, 5%, 10%}), forward-only walk-forward at
live sizing on the deep set, 52 folds, DSR charged for 16,280 + 27 trials. Signal rows are computed
once per fold and reused by every cell (`runFold({ rowsOnly })`, `run(candles, { rows })`); the
script checks on the first two folds that reuse equals a plain run. The current cell reproduces the
earlier walk-forward exactly (+23.33%, Sharpe 0.80, DD −4.56%, 73 trades).

| Cell | Return | Sharpe | Max DD | WR | DSR | Accept |
|---|---|---|---|---|---|---|
| SL ×1.5 TP ×1.5 BE off | +66.03% | 1.38 | −4.28% | 72% | 0.53 | yes |
| SL ×1.5 TP ×1.5 BE 10% | +65.40% | 1.38 | −4.28% | 69% | 0.53 | yes |
| SL ×1.5 TP ×1.5 BE 5% | +55.32% | 1.33 | −2.54% | 56% | 0.45 | no |
| SL ×1.5 TP ×1 BE off | +44.36% | 1.24 | −4.28% | 72% | 0.34 | no |
| SL ×1 TP ×1 BE 5% (current) | +23.33% | 0.80 | −4.56% | 49% | 0.04 | no |

Full table in `data/stop_sweep.log`. Reading: the +5% break-even costs in almost every pair (under
real stop timing it closes winners at zero), and wider stops with wider targets help together.
**The winner is a corner of the grid**, so it is not accepted yet: a plateau check past 1.5 and the
two-window baseline (Y2 and Y1+Y2, WR gap) come first.

**Plateau check (9 more cells, break-even off, DSR charged for 16,307 + 9).** `(1.5, 1.5)` reproduces
its first-grid result exactly and is the top of a smooth plateau: SL ×2 / TP ×1.5 Sharpe 1.35, SL ×1.5 /
TP ×2 1.34, SL ×2 / TP ×2 1.30, out to SL ×2.5 / TP ×2.5 1.15, with drawdown growing to −10.8%. Not a
lucky corner.

**Two-window baseline of the winner** (SL ×1.5, TP ×1.5, break-even off; applied in memory by a
preload, the config file unchanged):

| Window | Current | Winner |
|---|---|---|
| y2_365d (in-sample) | −1.15%, Sh −0.09, DD −7.46%, WR 33% | +12.88%, Sh 1.27, DD −2.71%, WR 64% |
| y1y2_full (OOS) | +31.24%, Sh 1.22, DD −8.11%, WR 45% | +95.96%, Sh 2.21, DD −6.88%, WR 70% |
| full_history | +37.30%, Sh 0.69, DD −8.11%, DSR 0.02 | +106.10%, Sh 1.17, DD −7.47%, DSR 0.31 |
| y1_holdout | +29.93%, Sh 2.11, DD −4.09% | +66.15%, Sh 2.78, DD −6.88% |

Better in every window; DD smaller in five of six (y1_holdout widens). WR gap Y1 75% vs Y2 64% =
11pp: a warning (> 10pp), not a blocker (> 15pp). The baseline's DSR charges the standard 16,280
trials, not the 36 sweep cells; the walk-forward DSR (0.53) charges them.

**Candidate (not applied):** every per-symbol `stopLossPct` and `takeProfitPct` × 1.5, global ones
too, `risk.breakEvenTriggerPct` 0. A risk change to the live config: applied only with the user's
OK, as one change, with the previous config kept for a rollback.

**Slippage calibration (measured, not changed).** Live's 24 fills at a cycle, against the bar's
open: mean +1.0 bps worse, versus a mean tier of 11.7 bps. The tiers are about 10× conservative; the
exception is PEPE (+22 bps = one 1e-8 price tick). Kept as they are (the rule says never flat);
re-measure once live has more fills.

**Sleeve sizing inputs (2026-10-24).** Live's own `computeRealizedVolAnnual` and
`computeTargetFraction` on the frozen candles, with the logged macro state: realized vol and size
fraction match the logged `[TSM-CORE] … vol X% → ×F` line on **118 of 118** cycles. With the votes
(118 / 118) the sleeve's decision and sizing inputs reproduce live; order fills and resizes were not
replayed.

**Applied 2026-10-24** (user decision): every `stopLossPct` / `takeProfitPct` × 1.5 (112 values,
checked against the committed config: 0 wrong, the rest identical) and `breakEvenTriggerPct`
0.05 → 0.10 — the user kept the break-even protection; the lock is still entry × 1.002, fees covered.
A baseline from the edited file reproduces the preload run exactly. Final config, deep set:

| Window | Return | Sharpe | DD | WR | DSR |
|---|---|---|---|---|---|
| y2_365d (in-sample) | +12.88% | 1.27 | −2.71% | 64% | 0.00 |
| y1y2_full (OOS) | +94.86% | 2.20 | −6.88% | 68% | 0.36 |
| y1_holdout | +65.21% | 2.77 | −6.88% | 72% | 0.18 |
| full_history | +105.28% | 1.17 | −7.47% | 66% | 0.31 |

WR gap Y1 72% / Y2 64% = 8pp (below the 10pp warning). Fine-tuning is deferred until the rebuild is
finished (user decision).

## Step 4 — design (implementation starts after step 3 is live and stable)

Per the decisions above, step 4 is planned now and built only after the step-1–3 release has run
live without surprises. What exists and what is left:

**Order interface.** The three order handlers already share most of a surface:

| Call | `LiveTrader` | `PaperTrader` | `BacktestSimulator` |
|---|---|---|---|
| `execute(symbol, decision, price, risk)` | async, real orders | sync | sync, with `fillPrice` / `positionPct` opts |
| `checkRisk(symbol, price)` | yes | **yes, since 2026-10-24** (was private) | `replayBar(symbol, bar)` + the tick inside `execute` |
| `markPrice(symbol, price)` | yes | yes | `markEquity(prices)` |
| `getStatus()` | async | sync | sync |
| core sleeve `open/close/resizeCorePosition` | yes | yes | — (the sleeve is simulated by `runTrendCore`) |

Left: (a) one `OrderHandler` contract (all async, `execute` taking a resolved size instead of each
handler sizing itself — sizing is `computePositionSize` everywhere), (b) the sleeve's order calls
on the simulator, so the sleeve is backtested with live's `tsmCore` functions instead of
`runTrendCore`'s copy, (c) a contract test that drives all three handlers through the same tick
sequence and requires identical trades.

**Event loop.** Live has three clocks: the aligned 12h cycle (`createAlignedScheduler`), the 2-minute
risk loop, and the 5 s price poll. The backtester has one step per 12h bar plus the 15m replay.
Left: a replay source that emits the same two events live reacts to — `barClosed(T)` for every
symbol and `priceTick(symbol, price, ts)` from the 15m bars — and one `Engine` that `main.js` and
the backtester both drive. `runAllSymbols` becomes `onBarClosed`; `runRiskChecks` becomes
`onPriceTick`. The reconciliation then replays live's own event stream instead of the
backtester's step loop.

**Done already, groundwork:** the decision core (step 3), shared stop helpers and the intrabar
replay (item 4), the fetch-first cycle (item 12), and the paper risk loop (paper now meets prices
every 2 minutes like live, so a paper run is a faithful shadow).

## Warm history for baseline and walk-forward windows (2026-10-24)

Found by the recursive check in `runSignalIntegrity.mjs` (decisions depend slightly on how much
history is loaded: 99.68% the same with 250 bars, 99.87% with 1,000). `sliceWindow` cut every
window at its start, so each window restarted every indicator there — `last_90d` (180 bars) got its
first decision row at bar 50 and traded 65 of its 90 days on cold state, while live always has about
1,600 bars behind a decision. Now `sliceWithHistory` keeps the history before the window and the run
trades only from the window's start (`tradeFromTs`), as the reconciliation does. Same config:

| Window | Cold start | Warm history |
|---|---|---|
| last_90d | −4.73%, Sh −2.54, DD −5.14% | +0.32%, Sh 0.20, DD −1.40% |
| last_180d | +14.78%, Sh 1.84, DD −4.76% | +14.36%, Sh 2.11, DD −2.11% |
| y2_365d | +12.88%, Sh 1.27, DD −2.71% | +17.77%, Sh 1.51, DD −3.89% |
| y1y2_full | +94.86%, Sh 2.20, DD −6.88% | +97.67%, Sh 2.20, DD −6.89% |
| full_history | +105.28%, Sh 1.17 | identical (it starts at the data's start) |
| walk-forward, live sizing | +65.40%, Sh 1.38, DSR 0.53 | +65.06%, Sh 1.36, DSR 0.50 |

The walk-forward moves least: its folds already had 365 bars of training as warm-up. Its DSR is now
exactly on the 0.5 acceptance line — a point for the fine-tuning to come. Lookahead check: trades
closed before three cuts are identical with or without later data.

## Release plan (live PC)

The live container runs `833c393`. Two releases, one change each, the previous image kept for a
rollback (`docker tag` before rebuilding):

1. **`a6ddef7` — live parity fixes + decision core, old exits.** `withFormingBar`, fetch-first cycle,
   per-cycle 15m/4h refresh on closed bars, aging from the opening bar, one klines retry, shared
   gates and asymmetric exit. Watch for: `[MTF-CACHE] … refresh complete` once per cycle, no
   `cycle failed` without a `retrying once` before it, the same number of `decision=` lines per
   cycle as before. After a week, rerun the reconciliation on a fresh snapshot — layer 1 should show
   no stale-bar mismatches.
2. **`HEAD` — the new exits and step 4.** The new exits (`4b2f365`: SL/TP × 1.5, break-even trigger
   +10%); the cycle as an engine (`d9e9658`, same decisions on the same bar) with entries filled one
   at a time by confidence (`c096828`, closes the slot race); risk-loop exits counted toward the
   daily-loss limit (`c35dcc8`); the bear cash-exit priced at this cycle's price (`2d5aec9`); the
   sleeve inside the engine (`39844c8`); the paper risk loop and the shared $11 floor in paper.
   Watch: the first stops and targets against `runEngineReplay.mjs` on a fresh snapshot, the daily
   P&L after a stop-loss, and that no cycle opens more scalper positions than `maxOpenPositions`.

Both need `TSM_CORE` and `.env` unchanged. Fine-tuning (exits that loosen with profit, per-symbol
retune, PBO / CPCV) comes after the rebuild, per the user.

## Step 4 — built (user decision 2026-10-24: now, not after the release)

**Slice 1 — one order contract.** `LiveTrader` takes its exchange calls as a constructor argument
(the real Binance client by default, so live is unchanged), `PaperTrader` gained a public
`checkRisk` (paper now runs the 2-minute risk loop), and `BacktestSimulator` answers the same
`checkRisk(symbol, price)` / `markPrice` calls. `tests/executor/orderContract.test.js` drives all
three — live against a fake exchange — through stop, target, break-even, strategy-sell, trailing and
min-notional scripts: identical trades on every one. Found while writing it: paper hardcoded a $10
floor (orders, sleeve opens, sleeve resizes) where live and the simulator use the shared $11; it now
uses `FALLBACK_MIN_NOTIONAL`. Known, documented difference: live's recorded P&L excludes fees,
paper charges none, the simulator models them — the contract runs at zero fees.

**Found for slice 2 — a slot race in live.** `runAllSymbols` runs every symbol's cycle at once
(`Promise.all`). Each captures `getStatus()` early and checks `canTrade`'s position limit after
its filter fetches, and `LiveTrader`'s own guard counts positions that are only added after four
awaits. Two BUYs in one cycle with three slots taken can both pass — five positions — and which BUY
gets a contested slot depends on which fetch returns first, not on confidence. It never fired (live
held at most two scalper positions), but the backtester fills slots by confidence, one at a time.

**Closed, not verifiable:** DOGE's 2026-08-20 entry size and the exit of the ETH position opened
2026-08-03 predate the retained logs (user decision: not pursued).

**Slice 2 — entries one at a time, by confidence.** `runCycle` now returns an unheld BUY as an
entry candidate instead of executing it; the rest of the cycle is `completeCycle`. `runAllSymbols`
runs phase A (every symbol in parallel: decision, exits, holds) and then phase B: candidates sorted
by `byEntryPriority` (decisionCore — confidence first, ties by `config.symbols` order), each
completed with a fresh `getStatus()`, so a slot, a correlation or an equity change from the
previous entry is visible to the next. The backtester sorts its queue with the same comparator (the
golden is unchanged: same order as its stable sort). Inventory row: "Entry slots filled one at a
time, highest confidence first". The boot cycle had no BUY, so phase B is first exercised by the
engine tests in slice 3.

**Slice 3a — the cycle is an engine.** `src/core/engine.js` (`createTradingEngine(deps)`) holds the
bar-close cycle that was `main.js`'s `runAllSymbols` / `runCycle` / `completeCycle` /
`refreshSymbolCandles` / `refreshMtfCache`, moved verbatim: the cycle state became `state.*`, every
`Date.now()` and default-clock argument (freshness, `withFormingBar`, the weekly DD) goes through the
injected `now()`, and BTC dominance comes in through `deps.marketContext`. `main.js` builds the
engine with the live dependencies and its scheduler calls `engine.runAllSymbols()`. Proof of no
change: a boot on the same 12h bar gives the same decision and confidence for all 33 symbols as the
boot before the move. `tests/core/engine.test.js` drives the real engine with PaperTrader and stub
aggregators — the first run of phase B: one free slot and three BUYs open one position, the highest
confidence; a tie goes to the earlier symbol; the others log the slot limit.

**Slice 3b — the live engine replays history.** `src/backtester/engineReplay.js` drives
`createTradingEngine` with a replay source: at every 12h close the clock is set to the cycle time,
the candle store serves what live would have fetched (closed bars + a seconds-old forming bar), and
`engine.runAllSymbols()` runs; until the next close every open position meets its 15m bars through
`engine.onPriceTick` — live's two events. Orders go to a `BacktestSimulator` behind live's order
interface; `RiskManager` runs on the replay clock; the aggregators and the regime tracker warm up on
the history before the window. `src/scripts/runEngineReplay.mjs` runs it next to
`PortfolioBacktester` with the same settings and compares every trade.

Live window (2026-08-20 → 10-24, $118.40, the 09-28 deposit): **6 of 6 trades identical** — symbol,
entry and exit time, reason, fills and size — and the same realised P&L ($8.61). The first run found
a real bug in slice 3a: the move had shadowed the clock inside the 15m/4h fetch, the filters failed
open, and the replay took the four entries live's MTF/4h filters had blocked. Fixed, with a test
that fails on the bug.

**A year of history, trade for trade.** Deep set, 2025-08-10 → 2026-08-10, $1,000: the first run gave
the same 26 trades on both engines (symbols, times, reasons, fills) with sizes drifting from
2025-12-10 on. Two causes, both fixed: (1) `PortfolioBacktester`'s median ATR ran only over symbols
with a decision row, so a symbol inside its first 50 bars (LSK, listed 2025-11-18) was in live's
median and not the backtester's — BTC's 2025-12-10 size differed by 1.8% and every later balance
followed; (2) the engine's bear cash-exit passed the last risk-loop mark as the price (up to 2 min
old); it now passes the price this cycle fetched — paper and the replay fill at the price they are
given, live's market order was unaffected. After both: **26 of 26 identical, same realised P&L
($111.84)**; the live window stays 6 of 6. The backtester and the engine live runs now trade the
same, trade for trade.

**Slice 3c — the TSM sleeve moves into the engine.** `runTsmCoreCycle` and its state (failed-close
retries, rung bookkeeping) moved from `main.js` into the engine the same way: verbatim, state in
`state.*`, the clock through `now()` (freshness, `withFormingBar`, the dashboard timestamp), the
equity history and the NASDAQ feed as deps. The risk loop's core branch reads
`engine.state.tsmCoreFailedCloses`. Proof of no change: on the same 12h bar, the boot's
`[TSM-CORE]` lines (votes, realized vol, size fraction, macro state for all four majors) are
identical to the boot before the move.

**The sleeve replays with live's code.** `BacktestSimulator` holds TSM core positions as live and
paper do (`openCore` / `closeCore` / `resizeCore`: a dollar allocation, no stop or target, blended
entry on resize, the $11 floor), and the engine replay serves the sleeve's feeds as of the clock (its
own equity curve for the HWM ladder, NASDAQ closes cut to the clock — the overlay now takes the
engine's `now()`). `src/scripts/runSleeveReplay.mjs` replays 2026-08-03 → 10-24 from live's balance
then ($189.43) with the deposits: **11 of 11 vote-flip opens and closes land on live's cycle**. The
remaining differences are resizes, which follow account equity (a 15% drift band on a share of
equity) — the replay approximates live's equity, and the 2026-09-28 resizes came from an
out-of-cycle restart right after a deposit. This is the first backtest of the sleeve with live's own
code; `runTrendCore` stays as the research study it was. `runEngineReplay.mjs` runs the scalper
without the sleeve, since `PortfolioBacktester` has none (6 of 6, 26 of 26 still identical).

**Step 4 is built.** One order contract (live ≡ paper ≡ simulator on the same calls), one engine for
the cycle with live's two events (`runAllSymbols` on a bar close, `onPriceTick` on a price), used by
`main.js`, the tests and the replay; the replay of that engine trades exactly like
`PortfolioBacktester` (6/6, 26/26) and the sleeve's flips land on live's cycles (11/11).
`tests/backtester/engineReplayParity.test.js` keeps the two engines equal on a fixed synthetic market
(6 symbols, alternating trends, gate thresholds relaxed on both sides so it trades); it fails when
one side drifts (checked: a fill moved to the close on one side breaks it). `PortfolioBacktester`
stays as the fast research engine — it precomputes the signal rows, the replay runs the cycle as
live does.

## Recalibration under live conditions (2026-10-24)

`src/scripts/runRecalibration.mjs` runs each cell through the engine live runs (the replay): the TSM
sleeve on and sharing the wallet, $190 to start and $10 every 7 days (the capital policy), the $11
floor, fees and tiered slippage, the full Fear & Greed history (`data/fearGreed_full.json`, from the
API with `limit=0`). Metric: deposit-adjusted time-weighted return (each cycle's growth net of that
cycle's deposit, chained), max drawdown of that index, Sharpe of its daily returns (√252). Windows,
both from $190: in-sample 2021-01-01 → 2024-12-31, holdout 2025-01-01 → 2026-08-10. Benchmarks: L0
= the live system as deployed (old exits), L1 = the committed config.

**Stage 1 — sizing for a small account** (16 cells + L0, pre-registered in the script):

| Cell | In-sample TWR / Sharpe / DD | Holdout TWR / Sharpe / DD |
|---|---|---|
| L0 live as deployed | +68.8% / 1.18 / 9.2% | +9.9% / 0.60 / **11.3%** |
| L1 committed | +81.9% / 1.28 / 9.2% | +24.5% / 1.24 / 9.7% |
| 3×20% | +88.5% / 1.30 / 9.2% | +33.3% / 1.44 / 10.4% |
| 2×30% | +101.7% / 1.31 / 9.3% | +42.4% / 1.52 / 11.6% |
| 2×40% | +117.0% / 1.31 / 9.4% | +52.0% / 1.52 / 13.1% |

(`minSizeMultiplier` 0.5 adds 0.2–1.2 points and up to 1.1 points of DD; the min-notional bump changes
nothing.) Findings:

- **The committed config beats the live system** in both windows (+13 and +15 points of TWR, higher
  Sharpe, equal or lower DD); the live system breaches the 10% DD tolerance in the holdout.
- **The $11 floor never bound** — 0 rejections, 0 bumps, in every cell and window. Checked directly
  for the first half of 2021 ($190, sleeve active): 7 BUY signals, 6 stopped earlier by the 4h,
  momentum and bear gates, the one that passed sized at $24.62. The BUYs that survive the gates are
  sized well above the floor, and the deposits grow the account. Live's own logs (09-25 → 10-24) show
  0 actual rejections; the "7% of signals under $11" from live's sizing logs counts every symbol every
  cycle, holds included.
- **Concentration gains return but breaks the DD tolerance in the holdout.** No cell passes the
  pre-registered rule. DSR is 0.00–0.03 for every cell including both benchmarks: at account level
  (sleeve included) the absolute 0.5 bar cannot separate anything.
- **The sleeve carries the holdout drawdown.** L1 without the sleeve: holdout +29.4% / Sharpe 1.96 /
  DD 2.4% (with it: +24.5% / 1.24 / 9.7%); 2×30% without it: +49.6% / 1.84 / 4.9%.

**Stage 2 — concentration × the sleeve's share on today's rung** (pre-registered here and in the
script before its first run): slots × size ∈ {4×15%, 3×20%, 2×30%} × sleeve share ∈ {50% (now), 25%,
0% (off)}; same windows, benchmarks and acceptance (beat L0 and L1 on TWR and Sharpe in both windows,
DD ≤ 10% in both); DSR reported, charged for every stage-1 and stage-2 cell, with the scalper's
walk-forward DSR as the statistical check for a winner.

| Cell | In-sample TWR / Sharpe / DD | Holdout TWR / Sharpe / DD | Fails on |
|---|---|---|---|
| L0 live as deployed | +68.8% / 1.18 / 9.2% | +9.9% / 0.60 / 11.3% | (benchmark) |
| L1 committed (4×15%, sleeve 50%) | +81.9% / 1.28 / 9.2% | +24.5% / 1.24 / 9.7% | (benchmark) |
| 4×15%, sleeve 25% | +63.0% / 1.21 / 9.2% | +27.7% / 1.42 / 9.7% | in-sample TWR, Sharpe |
| 4×15%, sleeve 0% | +22.4% / 1.02 / 4.5% | +29.4% / 1.96 / 2.4% | in-sample TWR, Sharpe |
| 3×20%, sleeve 50% | +88.5% / 1.30 / 9.2% | +33.3% / 1.44 / 10.4% | holdout DD (by 0.4 points) |
| 3×20%, sleeve 25% | +70.2% / 1.24 / 9.2% | +36.3% / 1.58 / 10.3% | in-sample TWR, Sharpe; holdout DD |
| 3×20%, sleeve 0% | +28.1% / 0.99 / 6.0% | +39.0% / 1.95 / 3.3% | in-sample TWR, Sharpe |
| 2×30%, sleeve 50% | +101.7% / 1.31 / 9.3% | +42.4% / 1.52 / 11.6% | holdout DD |
| 2×30%, sleeve 25% | +82.1% / 1.24 / 9.3% | +43.2% / 1.58 / 11.6% | in-sample Sharpe; holdout DD |
| 2×30%, sleeve 0% | +38.9% / 0.95 / 8.9% | +49.6% / 1.84 / 4.9% | in-sample TWR, Sharpe |

0 floor rejections and 0 bumps in every cell and window. DSR (holdout) 0.00–0.09 for every cell.
Full output in `data/recalibration_stage2.log` and `.json`. Findings:

- **No cell passes.** The nearest, 3×20% with the sleeve at 50%, beats both benchmarks on all four
  return metrics and misses the holdout DD limit by 0.4 points. The rule was set before the run, so
  it is not relaxed after it.
- **The sleeve is a bull-market engine.** In 2021–2024 it gives most of the return: 4×15% makes
  +81.9% with it and +22.4% without. In 2025–2026 it costs 5–10 points of return and adds 5–7 points
  of DD. No sleeve share wins in both windows; choosing one is a bet on the next regime, which the
  data cannot settle.
- **Concentration buys return with holdout DD**, with the sleeve on or off.
- **The result: L1, the committed config, stays.** It is the setup that beats the live system under
  live conditions in both windows, and its exit change carries the walk-forward DSR of 0.53 from
  the stop sweep (cell SL ×1.5, TP ×1.5, break-even 10%).

Possible next research (not started, each needs a pre-registered grid): a sleeve that limits its own
drawdown (for example, a share cut when the sleeve's equity falls from its peak, or the sleeve on
only in a BTC bull regime). That would attack the one trade-off stage 2 found, instead of trading
one window against the other.

## Trailing stop with an arm level (2026-10-25)

**Engine change first (`ac88b4d`).** The arm level ("start trailing once the trade is +X% up") was a
simulator-only research knob, so a backtest with it would not have been live. It is now the third
argument of the shared `calcTrailingStop`, read from `risk.trailArmPct` (default 0) by live, paper
and the simulator, and the live restore path checks it too. The walk-forward and baseline windows
also forced `trailingStopPct` to 0 whatever the config said; they now read `config.risk` as live
does. `orderContract.test.js` has an armed-trail scenario on all three handlers.

**Sweep** (`runStopSweep.mjs`, pre-registered in `05962c7`): the committed stops and break-even
(+10%), trail ∈ {4%, 7%, 10%} × arm ∈ {at entry, +5%, +10%} × take-profit {kept, off}, plus TP off
without a trail and the reference: 20 cells, forward-only walk-forward at live sizing, 52 folds,
DSR charged for 16,343 + 20 trials. Accept: ≥ 8 trades, DSR ≥ 0.5, DD at most 2 points worse than
the reference, and Sharpe above it. The 14-bar aging exit stays on, as in live, so even with TP off
a trade runs at most 7 days.

| Cell | Return | Sharpe | Max DD | WR | Trades | DSR | Accept |
|---|---|---|---|---|---|---|---|
| TP kept, trail 10% from +5% | +66.10% | 1.46 | −3.49% | 66% | 79 | 0.67 | yes |
| TP off, trail 7% from +5% | +63.80% | 1.39 | −3.49% | 66% | 79 | 0.56 | yes |
| TP kept, trail 7% from +5% | +53.56% | 1.37 | −3.49% | 66% | 79 | 0.52 | yes |
| TP kept, trail 10% from +10% | +62.54% | 1.37 | −4.28% | 69% | 78 | 0.51 | yes |
| TP off, trail 10% from +5% | +71.96% | 1.37 | −3.51% | 66% | 79 | 0.51 | yes |
| **reference (committed, no trail)** | +65.00% | 1.36 | −4.28% | 67% | 78 | 0.50 | — |
| TP kept, trail 10% from entry | +60.46% | 1.33 | −5.31% | 63% | 79 | 0.47 | no |
| TP off, no trail | +105.91% | 1.02 | −7.04% | 63% | 78 | 0.10 | no |
| TP kept, trail 4% from entry | +15.41% | 0.74 | −2.40% | 51% | 83 | 0.01 | no |

Full table in `data/trail_sweep.log`. The reference gives +65.00% / 1.36, not the +65.40% / 1.38
of the stop sweep: the engine fixes since then (slot order, median ATR, bear-exit price) moved it;
which one was not isolated. Reading:

- **The arm level is what makes a trail work.** Every trail that starts at entry loses to the
  reference; from +5% the 7% and 10% trails win with TP kept or off. A 4% trail loses everywhere.
- **The gain is small but in the right place:** Sharpe 1.36 → 1.46 and DD −4.28% → −3.49%, return
  about the same. The trail mostly protects trades that rose and then fell back.
- **TP off without a trail** has the top return (+105.9%) and the worst DD (−7.0%) and Sharpe (1.02).
- **The winner is at a corner** (the widest trail). Not accepted yet.

**Pre-registered next (before either runs):**

1. *Plateau check*, same sweep: TP kept, trail ∈ {10%, 12%, 15%} × arm ∈ {entry, +3%, +5%, +7.5%}
   plus the reference (13 cells, 10 new; DSR charged for 16,363 + 13). The winner stands if its
   neighbours stay at or above the reference's Sharpe and none collapses.
2. *Live conditions*, `runRecalibration.mjs --stage 3`: the two best cells (TP kept, trail 10% from
   +5%; TP off, trail 7% from +5%) with the committed sizing and sleeve, against L0 and L1, same
   windows and rule as stage 2 (beat both on TWR and Sharpe in both windows, DD ≤ 10% in both).

**Plateau check** (`data/trail_plateau.log`, 13 cells, DSR charged for 16,363 + 13). The winner holds:
every trail of 10–12% from entry-to-+7.5% beats the reference (Sharpe 1.37–1.46), except 10% from
entry (1.33, already a loss in the first grid); 10% from +3% equals the winner (1.46, DD −3.30%).
At 15% the result fades to the reference (1.32–1.34): a smooth edge, no collapse.

**Live conditions, stage 3** (`data/recalibration_stage3.log`):

| Cell | In-sample TWR / Sharpe / DD | Holdout TWR / Sharpe / DD | Result |
|---|---|---|---|
| L0 live as deployed | +68.8% / 1.18 / 9.2% | +9.9% / 0.60 / 11.3% | (benchmark) |
| L1 committed | +81.9% / 1.28 / 9.2% | +24.5% / 1.24 / 9.7% | (benchmark) |
| trail 10% from +5% | +83.5% / 1.31 / 9.2% | +25.0% / 1.28 / 9.7% | passes, by a small margin |
| TP off, trail 7% from +5% | +76.0% / 1.23 / 9.2% | +30.1% / 1.42 / 10.0% | fails (in-sample) |

The script's accept column still applied stage 1's DSR ≥ 0.5 and printed "no" for both; from stage 2
the rule written here has no account-level DSR condition, and the column now follows it.

**Two-window baseline** (`runBaseline.mjs`, deep set, the candidate by an in-memory preload):

| Window | Reference | Trail 10% from +5% |
|---|---|---|
| last_90d | +0.32%, Sh 0.20, DD −1.40%, 8 t | −1.77%, Sh −1.21, DD −2.42%, 10 t |
| last_180d | +14.36%, Sh 2.11, DD −2.11% | +12.34%, Sh 1.87, DD −2.81% |
| y2_365d (in-sample) | +17.75%, Sh 1.51, DD −3.91%, WR 62% | +15.67%, Sh 1.37, DD −3.91%, WR 61% |
| y1_holdout | +67.83%, Sh 2.73, DD −6.88%, WR 74% | +72.93%, Sh 3.15, DD −3.56%, WR 74% |
| y1y2_full (OOS) | +97.63%, Sh 2.20, DD −6.88% | +100.02%, Sh 2.40, DD −3.91% |
| full_history | +105.23%, Sh 1.17, DD −7.47%, DSR 0.31 | +107.72%, Sh 1.26, DD −7.47%, DSR 0.42 |

WR gap Y1 vs Y2: 13pp for the candidate, 12pp for the reference (both a warning, not a blocker).

**Verdict: not applied.** The candidate is better over the long windows and the walk-forward, but
worse in every window of the most recent year (90 d, 180 d, Y2: Sharpe 1.51 → 1.37). Its gain comes
from one year (y1_holdout, 2024-08 → 2025-08). Under "revert, don't patch" a change that worsens the
in-sample window does not go live on a small long-window gain. The shared arm level stays in the
code, off (`trailArmPct: 0`, `trailingStopPct: 0`); rerun this check when the live data has grown.

**Live window** (`runRecalibration.mjs --live <snapshot>`, live candle set): live's own period
2026-08-03 → 2026-10-24 12:00, its start equity ($189.43), its real deposits ($24.92, $61.11) and
its Fear & Greed, Nasdaq and equity-history files, sleeve on.

| Run | Final equity | Profit | TWR | Sharpe | Max DD (daily) | Scalper P&L |
|---|---|---|---|---|---|---|
| live (real) | $311.08 | $35.62 | 18.2% | 2.73 | 4.1% | $5.59 |
| replay: L0 live as deployed | $306.78 | $31.32 | 15.3% | 2.27 | 4.3% | $9.08 |
| replay: L1 committed | $306.22 | $30.76 | 15.1% | 2.13 | 4.9% | $8.47 |
| replay: trail 10% from +5% | $308.05 | $32.59 | 15.9% | 2.25 | 4.7% | $10.35 |

All three replays take the same six scalper entries as live. Between the setups the difference is
in three exits: INJ (L0 −0.02 at its +5% break-even, L1 −1.80 at the stop, trail −0.77), LDO (L0
+1.86 at its old target, L1 −0.02 at break-even, trail +0.58) and PEPE (trail +0.24, others 0).
DOGE takes the wider target in L1 and the trail (+10.30 vs +6.81).

The replay of the deployed config is $4.30 under live's real result, more than the spread between
the setups ($1.83). Its scalper made more than live (DOGE sized larger, the known 08-20 sizing
gap); its sleeve made less (resizes follow equity, which a replay only approximates). Two exits land
on other cycles than live's (BTC 12 h earlier, PEPE 45 h earlier, both near zero P&L). Twelve
weeks and six trades cannot rank the setups; the trail leads the replays by $1.27.

## Without the 7-day aging exit (2026-10-25)

Asked by the user "just to be sure": L0, L1 and the trail (10% from +5%) with
`risk.positionAgingExit` off, next to the same with it. Both sides read the one setting
(`engine.js` and `portfolioBacktester.js`). Commit `4b73f97`.

| Test | L0 with / without | L1 with / without | Trail with / without |
|---|---|---|---|
| Walk-forward (52 folds, DSR for 16,376 + 6) | +25.8% Sh 0.86 / +28.2% Sh 0.90 | +65.0% Sh 1.36 DD −4.28% / +72.1% Sh 1.41 DD −4.28% | +66.1% Sh 1.46 DD −3.49% / +73.6% Sh 1.52 DD −4.27%, DSR 0.73 |
| Live conditions 2021–2024 | +68.8% Sh 1.18 / +65.5% Sh 1.13 | +81.9% Sh 1.28 / +84.9% Sh 1.30 | +83.5% Sh 1.31 / +87.3% Sh 1.34 |
| Live conditions 2025–2026 | +9.9% Sh 0.60 DD 11.3% / +13.9% Sh 0.80 DD 10.9% | +24.5% Sh 1.24 / +24.9% Sh 1.20 | +25.0% Sh 1.28 / +26.0% Sh 1.26 |
| Live window (replay, final equity) | $306.78 / $306.33 | $306.22 / $299.50 | $308.05 / $307.59 |
| Baseline Y2 (in-sample) | — | +17.75% Sh 1.51 WR 62% / +19.57% Sh 1.56 WR 46% | +15.67% Sh 1.37 WR 61% / +16.00% Sh 1.38 WR 54% |
| Baseline Y1+Y2 (OOS) | — | +97.63% Sh 2.20 / +94.36% Sh 2.13 | +100.02% Sh 2.40 / +94.60% Sh 2.29 |
| WR gap Y1 vs Y2 | — | 12pp / **21pp** | 13pp / **19pp** |

(L0's walk-forward is +25.8% / 0.86 now, +23.3% / 0.80 at the stop sweep: the engine fixes since.)
In the live window only BTC changes (held to the 09-28 strategy sell instead of the 09-26 aging
exit); L1's larger loss there comes from the sleeve: the account stays under the $320 rung, so the
sleeve keeps 50% and loses more on ETH in October.

**Verdict: the 7-day exit stays.** Without it the walk-forward gains 5–8 points, but both
candidates hit the WR-gap blocker (> 15pp): the win rate in Y2 falls to 46% / 54% (likely trades
the aging exit closed at a small gain running on to a stop; not checked trade by trade). L1 without it also falls under L1's
holdout Sharpe in live conditions. No config change; L1 stays.

## Bot vs holding BTC (2026-10-26)

Asked by the user ("the whole bot idea should at least beat hodling"). Engine replay, live
conditions, $190 on 2020-06-01 and $10 a week. Holding BTC buys at each moment's price, less 0.1%.
Splits put that share of every deposit into BTC and run the committed bot with the rest. Scripts
in the session scratchpad (`hodlRun.mjs`, `buildHodl.mjs`); report: the "Bot vs holding BTC"
dashboard.

| Setup (2020-06 → 2026-08) | Final | Worst drop | Biggest $ fall | Sharpe | 3-yr windows beating hold |
|---|---|---|---|---|---|
| Hold BTC | $7,339 | 72.7% | $6,829 | 0.72 | — |
| Bot as committed | $5,644 | 6.8% | $193 | 1.59 | 2 / 13 |
| Bot, sleeve 50% at every size | $6,452 | 17.8% | $732 | 1.24 | 2 / 13 |
| Bot, sleeve 100%, 4 majors | $7,832 | 27.3% | $2,398 | 1.08 | 4 / 13 |
| 30% BTC / 70% bot | $6,218 | 41.7% | $2,063 | 0.84 | 2 / 13 |
| 50% BTC / 50% bot | $6,546 | 54.7% | $3,337 | 0.76 | 2 / 13 |
| 70% BTC / 30% bot | $7,066 | 62.5% | $4,634 | 0.75 | 2 / 13 |

Thirteen 3-year windows, one starting each quarter from 2020-06 to 2023-06. Holding BTC's median
profit was $1,540, against $888 for the 100% sleeve and $388 for the committed bot. No setup lost
money in any window. The bots win the windows that end after a fall (2023, 2026); holding wins
those that end near a top (2024–25). The sleeve's rules come from a study that covers these years,
so the trend-heavy rows are in-sample. Nothing applied: the sleeve share is a risk decision for the
user (stated limit about 10%).

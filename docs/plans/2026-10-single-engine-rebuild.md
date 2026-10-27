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

Correction (2026-10-26): the user's "10% rule" is a max loss per trade, not an account drawdown
limit. The framing above ("stated limit about 10%") is wrong on that point.

## Is the 100% sleeve just BTC? (2026-10-26)

Asked by the user. From the full-period 100% sleeve run (`btcLine.mjs` in the scratchpad). The
sleeve held a coin 64% of the time (1.7 coins on average), BTC 48%. Profit by source: BNB +$1,995,
scalper +$1,306, ETH +$1,102, BTC +$506, SOL −$576. Weekly correlation with BTC 0.66, beta 0.35;
it caught 42% of BTC's up weeks and 29% of its down weeks.

Simple rules with the same money (12h opens, 0.1% a side, so drops read a little low):

| Rule | Final | Worst drop |
|---|---|---|
| Hold BTC/ETH/BNB/SOL, equal parts | $8,976 | 73% |
| BTC above its 100-day average, else cash | $8,080 | 37% |
| BTC above its 50-day average, else cash | $8,052 | 47% |
| Bot, 100% sleeve | $7,832 | 27% |

The sleeve is a trend switch on the majors; its long-run money is market exposure. The fair
benchmark for any sleeve-heavy setup is "BTC above its 100-day average, else cash", not holding.

## Fast chart-pattern trader (2026-10-26)

The user's goal: many short trades (hours to 2 days), entries from trend, support/resistance and
candles, quick exits, at most 10% loss per trade, money in USDC most of the time. Model: Warrior
Trading's momentum style. Research only, no engine change. Scripts in the scratchpad: `fast/gen.mjs`
(scanner + 15m replay), `fast/analyze.mjs`, `fast/buckets.mjs`.

- Data: deep set, 1h bars built from 15m, trend from 4h (close > EMA200, EMA50 > EMA200).
  Swing points need 3 bars each side and are used only after that (no lookahead).
- Setups: bounce at a swing-low support (and a strict hammer/engulfing form); retest of a broken
  swing high; 2-day-high breakout on 1.5× volume; Warrior-style 15m bull flag (in play: up ≥ 3% in
  24h, volume ≥ 1.5×; pole ≥ 2%; pullback ≤ half on lighter volume; buy-stop above the last bar,
  stop under the pullback low, 6 h limit).
- Exits: next resistance, 2R, or a 1-ATR trail after +1R; break-even at +1R; 48 h limit.
  Replayed on 15m bars; a bar that touches stop and target counts as the stop.
- Costs: 0.1% fee + tier slippage per side (round trip 0.4% large, 0.6% mid, 0.9% micro).
- One trade at a time per coin. In-sample 2020-06 → 2025-08-10; the last 12 months stay locked.

Result: every setup, exit and coin set lost money, in every year: −0.18% to −0.64% per trade.
Before costs the edge is zero (bounce −0.03% ±0.04, retest −0.02% ±0.04, flag −0.05% ±0.04,
breakout +0.03% ±0.12 per trade). The 2R exit split 52% stop, 23% break-even, 24% target — the
coin-flip split is 50/25/25. No slice by stop width, trend distance, volume spike, ATR, candle
type, BTC trend, VWAP, "in play" strength or hour beat the costs; the best (breakouts on large
coins, +0.19% ±0.15 gross) is below the 0.4% round trip. The holdout was not read: nothing passed.

Verdict: on 1h/15m bars these chart patterns carry no edge in this data; more trades only add costs.

### Bigger bars and limit orders (2026-10-26)

The same scanner at 4h and 12h (`fast/gen2.mjs <out> <1h|4h|12h>`; trend from 12h EMA50/200, or
EMA100/400 on 12h for 12h bars; the 1h rerun matches the first run trade for trade). Gross edge by bar
size for breakouts on large coins: 1h +0.19%, 4h +0.86% ±0.53, 12h +1.2% ±1.2 per trade. Bounces,
retests and flags stay at about zero at every size. All 37 coins: breakouts lose on 4h (small coins
fail more and cost more), so large coins only (BTC ETH BNB SOL XRP DOGE ADA AVAX ZEC FTM XLM).

Order types (user: limit orders, market only in a catastrophe). On Binance spot base tier maker and
taker are both 0.1% (0.075% with BNB), so a limit mainly saves slippage. Modelled on 15m bars: a
resting limit buy fills only if price trades down to it, else no trade; target and time exits are
limit sells (fee only); stops are stop-limit sells into the bid (fee + tier slippage).

Plateau grid (`BO_GRID`, `fast/gridAnalyze.mjs`): 48-bar high lookback 24/48/96 × volume 1.2/1.5/2.0×
× stop 1.0/1.5/2.0 ATR × entry (market; limit 0.2% or 0.5% under the open for one bar; limit at the
broken level for two bars) × exit (2R or trail) × time limit. 4h large coins, in-sample:
- a 1.0 ATR stop loses almost everywhere; all 18 cells with 1.5–2.0 ATR are positive (market, 2R);
- limit 0.5% under the open: fills 78%, positive in 21/27 cells, median +0.40% per trade (market 0.36%);
- the misses are the best trades (+2.35% each vs +0.22% for the fills), but the price and the saved
  slippage still win; a limit at the broken level fills 46% and loses — it misses the runners;
- 12h large: 26/27 cells positive with market, median about +0.9–1.0%, but only ~35 trades a year.

Candidates fixed before any money run or holdout read — the plateau centre, 48 bars / 1.5× / 1.5 ATR /
2R: A = 4h, limit 0.5% under, 48 h limit; B = 12h, limit 0.2% under, 120 h limit.
Money (`fast/portfolio.mjs`: one position per coin, size = equity / max positions, $11 floor, valued
at every 4h close, drawdown on time-weighted returns):

| In-sample 2020-06-23 → 2025-08-10, $1,000 | Yearly | Worst drop | Sharpe | Trades/wk | In a trade |
|---|---|---|---|---|---|
| A, 4 at a time (25% each) | 9.6% | 11.8% | 0.99 | 1.3 | 10% |
| A, 2 at a time (50% each) | 18.7% | 22.3% | 1.01 | 1.2 | 10% |
| A, 1 at a time (100%) | 29.7% | 37.0% | 0.94 | 0.9 | 9% |
| B, 2 at a time | 11.4% | 23.4% | 0.62 | 0.5 | 12% |
| Hold BTC | ~53% | 73.7% | — | — | — |
| BTC above its 100-day average | ~46% | 44.9% | — | — | — |

Holdout 2025-08-10 → 2026-08-10, read once: A (2 at a time) +6.2%, drop 8.3%, 34 trades; B +3.1%,
14 trades; hold BTC −44%, BTC 100-day rule −29%. Per trade the holdout matches in-sample: 4h grid
27/27 cells positive with market (median +0.41%), 22/24 with the 0.5% limit (median +0.49%).

Verdict: 4h breakouts on large coins with a limit entry carry a real, small edge (about +0.4–0.5% a
trade after costs, plateau-stable, holds out of sample). Alone it is weaker than the committed bot
(Sharpe ~1.0 vs 1.59); the money sits in USDC ~90% of the time. Not applied. Open: run it next to
the committed bot on its idle cash; limit orders need live and simulator support (parity) first.

### Wider setup search under a fixed protocol (2026-10-26)

Asked by the user ("the more we look the higher the chance we find something"; also "research the
internet for ideas"). Protocol fixed before any run: discovery 2020-06 → 2023-12, validation
2024-01 → 2025-08-10, final year 2025-08-10 → 2026-08-10 read once for the passes only. Pass =
discovery n ≥ 100, net/trade > 0 and t ≥ 2.5; at least half of the family's cells positive; the
same cell positive in validation. Costs per side: market entry fee + slippage, limit entry fee;
target/time exits fee (limit sells); stops fee + slippage (stop-limit). Scripts in the scratchpad:
`fast/setups.mjs`, `fast/calendar.mjs`, `fast/libAnalyze.mjs`, `fast/passCheck.mjs`, `fast/finalCheck.mjs`.

Batch 1, chart setups (4h and 12h, all coins and large coins, market or limit entry, 1R/2R/trail,
two time limits; 1,848 tests, about 11 expected to pass discovery by luck): RSI(2) dip, EMA20/50
pullback, Bollinger squeeze, NR4/NR7/inside bar, break of structure, spring, volatility contraction,
relative strength, 1-year high, previous day/week high, RSI divergence, wide momentum bar, three-bar
pullback, and the volume breakout as a control. 30 passed discovery, 11 also validation: RSI
divergence (7 variants), the 4h breakout on large coins (3), the wide bar (1). Two clear false finds
were cut by validation: RSI(2) dip (discovery +0.95% t 2.85, validation −1.22% t −4.5) and EMA50
pullback on 12h (discovery +3.25% t 4.2, validation −0.17%).

Batch 2, published ideas (304 tests, none passed): intraday momentum (Shen, Urquhart & Wang 2022),
21–23 UTC (Quantpedia; −0.36%/trade after costs), near the 1-week high and 7-day momentum on large
coins (Fičura 2023; +2.67%/week but holding all large coins made +2.36% — beta), daily momentum
(Zaremba et al. 2021), volatility breakout (Larry Williams), big-drop bounce (Caporale & Plastun
2019, as they found: not profitable). BTC funding as a filter (Binance public history): negative
regimes too rare (< 15 trades), "not crowded" made discovery worse.

Control: entering on every uptrend bar with the same stop and exit made about 0% in discovery and
−0.4%/trade in validation. All 11 passes beat it in both blocks (+0.85–1.39% and +0.40–1.01%).

Final year, read once:

| Pass | Final year net/trade | Control | Excess |
|---|---|---|---|
| Breakout 48 bars, large, limit 0.5%, 2R/48 h | +0.35% (41) | −0.36% | +0.72% |
| Breakout 96 bars, large, limit, 2R/48 h and /120 h | +0.12% / +0.05% (27) | −0.36% / −0.43% | +0.48% |
| RSI divergence, 7 variants | −0.27% to −0.88% | −0.36% to −0.79% | −0.19% to +0.16% |
| Wide momentum bar | −0.54% (55) | −0.34% | −0.21% |

Verdict: of about 2,150 tests only the large-coin 4h volume breakout survives all three blocks. The
final year was already read once for that family (candidate A above), so its pass is not a fresh
test; the divergence and wide-bar failures are. Price-pattern setups at 4h/12h look mined out in
this data; new ideas likely need new data (order book, listings, news), not new patterns.

### More ideas from GitHub and Quant Stack Exchange; the breakout next to the bot (2026-10-26)

Searched GitHub (`gh search`, READMEs and findings files) and Quant Stack Exchange (thin). Useful:
an open lab that tests ideas with walk-forward and a locked holdout (TDZNBEER/crypto-backtest-lab, 37
write-ups, mostly negatives that match ours: day-of-week, opening-range breakout, pairs, funding,
TD Sequential, on-chain, turn of month), a failed-strategies repo (long-only trend, cross-sectional
momentum, pairs, low-vol all fail), and Freqtrade sets (in-sample only). Two leads tested:
- 21–23 UTC: our data agrees the shape is real before costs (large coins +3.2 bps per trade in
  discovery, +8.2 bps t 4.6 in validation), but a round trip costs 0.2% at Binance's 0.1% maker fee.
  Only worth a paper test if the account's USDC maker fee is about 0% (user to check).
- Nearness to the 52-week high (George & Hwang 2004; JBF 2025), long-only, top third weekly vs all
  coins equally (`fast/near52.mjs`, parameter-free): all coins excess +0.09%/wk t 0.17 in discovery,
  −0.45%/wk in validation; large coins −0.77%/wk in validation. Fails; final year not read.
- Taker-buy imbalance (Binance kline field; arXiv 2608.21888): published edges are sub-bps and point
  to reversal; needs a new download — left for a data round.

Breakout A (4h, large coins, limit 0.5% under, 2 at a time) with the committed bot, 2020-06 → 2026-08,
$190 + $10 a week (`fast/combine.mjs`; bot = the six-year engine replays). A money split only hurts:
70/30 Sharpe 1.85 and drop 8.8%, 50/50 1.59 and 11.4% (bot alone 1.91 and 6.8%). Daily correlation of
the two streams is 0.22, so an overlay on the bot's idle cash (the bot at full size, the breakout
at k × its 50%-per-trade size; estimate: daily returns added, cash assumed free — the breakout is in a
trade ~10% of the time):

| Overlay | Yearly | Worst drop | Sharpe |
|---|---|---|---|
| Bot alone | 20.2% | 6.7% | 1.91 |
| k = 0.25 (12.5% of equity per breakout trade) | 25.5% | 9.2% | 1.97 |
| k = 0.5 | 30.6% | 11.8% | 1.83 |
| k = 1 | 40.6% | 18.2% | 1.57 |

Caveats: an estimate, not a shared-cash simulation; the final year was already read for the
breakout family. Next: a shared-cash run in the engine replay (breakout as a second entry rule with
limit entries), which needs limit-order support on both sides (live parity) first.

### Data gap found while building the report (2026-10-26)

The deep candle set has no USDC bars from 2022-09-28 for 165 days (to March 2023): Binance converted
USDC balances to BUSD in September 2022 and USDC pairs stopped trading. Every USDC-pair replay in
this plan (the six-year replay, bot vs holding BTC, the setup searches) has no trades in that gap and
marks the whole price change at its end. It is why 2022 shows almost no trades. Report: the
"Setup search and breakout overlay" dashboard (data built by `fast/buildFast.mjs`).

### Profit-tiered exits on the breakout (2026-10-26)

From the external-bots review (NFI `long_exit_main`: exit on a smaller momentum drop as profit grows).
`fast/tierExit.mjs` replays the 4h large-coin breakout (6 entry cells: 24/48/96-bar high × 1.5/2.0 ATR
stop; market or limit 0.5% under) with six exits on 15m bars; the tiers read RSI-14 of closed 1h bars:
base (stop, BE at +1R, 2R target), tight tiers 30/34/38 at +1/2/4% (with or without the target),
loose tiers 35/45/55 (with or without), and a one-R stop ladder. Tier and ladder exits pay fee +
slippage. Pre-registered pass (`fast/tierAnalyze.mjs`): beat base on net per trade and total, in
discovery and validation, in ≥ 4 of 6 cells; then the final year once.

- The tight tiers almost never fire (0 tier exits in the reference cell): "tight, no target" is in
  effect "no 2R target, hold to the time limit". The gain comes from dropping the target.
- Passes (limit entry, 48 h, as candidate A): no target 6/6, loose tiers + no target 6/6, loose
  tiers with target 6/6 (tiny). Market/48 h: no target 4/6, loose + no target 4/6. The ladder fails.
- Final year, read once (first fresh test of these exits): loose + no target 6/6 with limit entry and
  6/6 with market entry; no target 6/6 with limit, 0/6 with market. Reference cell, final year:
  base +0.35%/trade, loose + no target +1.08%.

Money, candidate A (2 at a time, $1,000; 6 years at $190 + $10 a week):

| Exit | In-sample yearly / drop / Sharpe | Final year / drop / Sharpe | 6 years |
|---|---|---|---|
| base | 20.0% / 23.2% / 1.07 | +4.3% / 8.3% / 0.49 | $4,324 |
| loose tiers, no target | 27.0% / 32.0% / 1.07 | +16.5% / 7.2% / 1.44 | $5,551 |
| no target | 27.6% / 28.2% / 1.05 | +9.4% / 8.1% / 0.79 | $5,414 |

Overlay on the committed bot at 12.5% per breakout trade (estimate, `fast/overlayQuick.mjs`): base
25.7% / 8.9% / Sharpe 1.98; loose + no target 28.3% / 10.5% / 2.00 (bot alone 20.2% / 6.7% / 1.91).

Verdict: for the breakout, use loose tiers with no 2R target. It makes more money and held the final
year; the in-sample drop is deeper and the Sharpe is unchanged. On the bot, "TP off" was already
tested in the trailing sweep (+106% but Sharpe 1.02 vs 1.36, rejected); RSI tiers there need 1h RSI
in the live risk loop and a shared helper (parity), so they are a build, not a test.

### Combining the streams: why each works, and a first "superbot" (2026-10-26)

Asked by the user: combine what works a little, at different times, and find out why.
`super/super.mjs` (scratchpad) builds daily time-weighted returns for each stream with its own money
run: the committed bot; the scalper alone (engine replay, sleeve off, `hodlRun.mjs S0`); the trend
sleeve alone (`runTrendCore.mjs`, live's vote 30/45/60, slow-in, vol target 0.6, BTC/ETH/BNB/SOL);
the 4h breakout with the tiered exit; strongest coins (12h, top 3 by 7-day return making a 24-bar
high); RSI divergence; wide bar; 1-year high; hold BTC; BTC above its 200-day average. Regime per
day from BTC/USDT as of the previous close: trend (200-day average) × volatility (30-day vol above
its 365-day median). Deep set swapped in with the restore trap; fingerprint checked after (live set).

Why (Sharpe by regime, discovery → validation): almost everything works in calm uptrends and keeps
working there (bot, scalper, sleeve, breakout, strongest coins). The breakout is a calm-uptrend
strategy (1.63 → 1.80; negative in validation elsewhere). The sleeve and strongest coins earn most
in volatile uptrends. The scalper is the steadiest (positive in three regimes in both periods).
RSI divergence has no repeatable regime: noise. Validation has only 108 downtrend days.
Correlation (discovery): scalper 0.07 with the breakout, 0.10 with strongest coins, 0.16 with the
sleeve.

| Combination (capital splits sum to 1; overlays assume free cash) | Discovery | Validation | Final year |
|---|---|---|---|
| Bot as committed | 18.2% / Sh 1.72 / DD 6.0% | 28.9% / 2.39 / 6.7% | 7.6% / 1.16 / 6.4% |
| Equal parts (scalper, sleeve, breakout, strongest) | 31.5% / 1.72 / 13.5% | 31.4% / 1.86 / 8.6% | 7.3% / 0.82 / 9.3% |
| Inverse volatility, same four | 8.4% / 1.64 / 2.5% | 25.4% / 2.04 / 5.1% | 8.1% / 1.53 / 3.1% |
| Regime-switched (weights from discovery Sharpe per regime) | 43.2% / 2.10 / 8.9% | 32.6% / 1.74 / 9.5% | 13.1% / 1.55 / 5.8% |
| Bot + breakout overlay 12.5% | 29.1% / 1.95 / 10.0% | 31.5% / 2.19 / 8.8% | 11.9% / 1.51 / 7.2% |
| Bot + breakout + strongest, 12.5% each | 38.2% / 1.95 / 10.8% | 42.6% / 2.17 / 9.6% | 14.4% / 1.63 / 7.5% |

Read: the committed bot is already a combination and the hardest to beat on Sharpe in validation;
the regime switch overfits (best where its weights were set, worst in validation). The two overlays
on idle cash beat the bot on return in all three periods and on Sharpe in two (discovery, final
year), for about 3 points more drop. Caveats: overlays are estimates (cash assumed free); strongest
coins narrowly missed the discovery bar (t 2.47) and entered the pool after its validation was seen;
the final year was read once before for the breakout entries. Candidate "superbot v1": committed bot
+ breakout (tiered exit) + strongest coins at 12.5% of equity per trade on idle cash, limit orders.
Next: a shared-cash replay in the engine, which needs a second and third entry rule and limit orders.

## Satellite strategies in the engine (2026-10-26)

User: "let's start building so we can run real walk forward tests with the engine". Built on the
backtest side first, with the logic shared so live can call the same code later. Commits:

1. `fca9705` — `src/engine/satellites.js` (pure): `detectBreakout`, `detectStrongest`,
   `rankByReturn`, `isTrendUp`, `hourlyRsiByClose`, the tier exit, `satelliteOrderSize`,
   `planSatelliteEntry`. Config `satellites` (off; `SATELLITES=true`), 8 large coins of the list.
   Shared indicators (`calculateEMA`, `calculateRSI`, `computeATRPct`), so values differ slightly
   from the research scripts (EMA seeding, simple-average ATR); the engine is now the reference.
2. `859a50a` — `BacktestSimulator`: `placeSatelliteOrder` (a resting limit buy that locks its cash,
   as the exchange does), `replaySatelliteBar` (fill at the limit or a gap below; expiry; exits in
   the research order: time, pending tier, fill-bar stop, stop, target, break-even, tier at the
   hour close), `cancelSatelliteOrder`. Costs: limit buy / limit target / limit time exit fee only,
   stop and tier exits fee + slippage. `calcEquityFromStatus` counts `status.reserved`.
3. `162c79d` — engine: `runSatelliteCycle(kind)` (breakout at 4h closes; strongest at the 12h
   close, after the scalper and the sleeve), `onSatelliteBar`. Satellites never take scalper
   slots, the correlation cap's positions or the bear cash-exit; their PnL feeds the daily-loss
   brake. The replay steps the 12h interval in 4h windows when satellites are on (breakout cycle,
   then scalper ticks, then satellite bars), so no satellite sees cash from a later scalper exit;
   off, the loop is unchanged (`engineReplayParity` green). Inventory row: satellite entry plan.
   A trader without `placeSatelliteOrder` (LiveTrader, PaperTrader today) leaves satellites idle.
4. `207c2f7` — `src/scripts/runSuperbot.mjs`: one replay per cell (bot, bot+bo, bot+rs,
   bot+bo+rs) at live money ($190 + $10 a week), then rolling 6-month folds against the bot.

Not built yet (the live slice): `LiveTrader`/`PaperTrader` limit orders (place, poll fills,
cancel on expiry, stop-limit with a market fallback), the 4h scheduler and the hourly RSI feed in
`main.js`, restore of satellite positions and resting orders after a restart, and the inventory
row for the order path itself.

### First engine walk-forward (2026-10-26)

`runSuperbot.mjs` per cell, 2020-06-01 → 2026-08-10, $190 + $10 a week, deep set swapped in
(fingerprint checked after). The first `bot+rs` run had the breakout on too (`'bot+rs'.includes('bo')`
— "bot" contains "bo"); fixed to match whole parts and rerun.

| Cell | Final | Yearly | Sharpe | Worst drop | Satellite orders placed / filled / expired |
|---|---|---|---|---|---|
| bot (committed) | $5,644 | 20.2% | 1.91 | 6.7% | — |
| bot + breakout | $6,725 | 30.3% | 2.13 | 9.1% | 349 / 257 / 92 |
| bot + strongest | $5,923 | 22.1% | 1.78 | 9.0% | 165 / 153 / 12 |
| bot + both | $7,062 | 32.1% | 1.96 | 11.3% | 514 / 410 / 104 |

Six-month folds against the bot: breakout beats it on return in 6/13 and on Sharpe in 3/13;
strongest 5/13 and 3/13; both 7/13 and 5/13. The gain is concentrated: the Dec 2020 → May 2021
fold (bot +33.5%, bot + breakout +86.6%). Without it the breakout adds about +2.3% a year; in the
2021-12 → 2023-06 folds (bear, flat, and the USDC gap) it costs 0.5–1.5 points a fold.

Verdict: the breakout satellite holds in the engine (better than the overlay estimate, 28.3% /
Sharpe 2.00); the strongest-coins satellite does not (it lowers the Sharpe alone and with the
breakout) and stays off — its estimate carried the selection bias noted above. Candidate:
bot + breakout. Its edge is mostly trend periods; next is the live slice, then a paper run.

### The live side of the satellites (2026-10-26)

User: "I thought we had a single engine now?" — the decision cycle is one engine; carrying out
orders is three adapters (simulator, PaperTrader, LiveTrader), the plan's "one order path" step that
was never done. Parity there comes from shared rules, as `traderUtils.js` gives the scalper:

- `a9fad88` — `stepSatellitePosition` / `satellitePositionPlan` (`satellites.js`) are the one copy
  of the exit rules; the simulator calls them. Fills now happen at the limit price (a resting buy
  is filled at its own price), and every exit pays fee + slippage, as live's marketable sells will.
- `efe53bf` — PaperTrader holds satellite orders (fee-free, as paper's other paths); `main.js`:
  the risk loop also polls resting orders, feeds the closed-hour RSI once per hour, and a 4h
  scheduler runs the breakout one minute after each close (after the 12h cycle at 00/12 UTC).
  A paper restore keeps the plan; JSON stores Infinity as null, so a null target means none.
- `a25eb1f` — LiveTrader: GTC limit buy, polled each tick (fill, or cancel at expiry keeping a part
  fill); exits by the shared rules with an IOC limit capped 0.3% under the price, the rest at
  market as the catastrophe fallback (logged as an error). `satellite_orders.json` keeps resting
  orders across restarts; `position_state.json` keeps each satellite's plan; `calcCoreClaims` now
  also reserves satellite coins and resting orders' qty before the scalper restore. Inventory row:
  "Satellite order path". `binanceClient.createOrder` takes order params; `priceToPrecision` added.

Final engine walk-forward with these rules (bot + breakout): $6,699 (bot $5,644), 30.1% a year,
Sharpe 2.13 (1.91), worst drop 9.2% (6.7%); 349 limit orders, 257 filled, 92 expired; folds as
before (6/13 on return, 3/13 on Sharpe; the 2020-12 fold carries most of the gain).

Not done: a paper soak with `SATELLITES=true`, then a reconciliation of its trades against the
replay of the same days, before the user decides on live. Satellites stay off by default.

### Robustness checks on the breakout (2026-10-26)

User: "what about more tests and research?" Four checks, each with its pass rule fixed before the
run. Same setup as the walk-forward above (deep set, $190 + $10 a week, 2020-06 → 2026-08-10) unless
said. `runSuperbot.mjs` now takes `--bo '<json>'` (breakout settings over the config) and `--label`.

**R1 — days no test has seen** (live set, 2026-08-10 → 2026-10-24, $1,000; information only, 2.5
months is too short to decide on): bot +10.1%, Sharpe 2.68, worst drop 4.0%; bot + breakout +9.7%,
2.53, 5.3%. 13 breakout trades: 2 tier exits made +$31, the other 11 (stops, break-evens, time
limits) lost $33. No sign of a broken rule; a flat stretch for the breakout.

**R2 — settings plateau** (pass: at least 4 of the 6 cells beat the bot's Sharpe 1.91):

| Lookback (4h bars) | Stop 1.5 ATR | Stop 2 ATR |
|---|---|---|
| 24 | 28.6%/yr · Sharpe 2.09 · drop 10.0% | 26.4% · 2.04 · 9.3% |
| 48 (config) | 30.1% · 2.13 · 9.2% | 27.8% · 2.02 · 8.5% |
| 96 | 29.8% · 2.15 · 8.4% | 27.4% · 2.05 · 7.5% |

6 of 6 beat the bot → passes. The chosen cell is not a lucky peak. Folds beating the bot on Sharpe
stay low in every cell (3–5 of 13): the plateau holds for the whole period, not fold by fold.

**R3 — size per trade and open positions** (a trade-off table, no pass rule):

| Per trade · max open | Yearly | Sharpe | Worst drop | Filled |
|---|---|---|---|---|
| bot alone | 20.2% | 1.91 | 6.7% | — |
| 6.25% · 2 | 25.3% | 2.18 | 7.4% | 257 |
| 12.5% · 2 (config) | 30.1% | 2.13 | 9.2% | 257 |
| 25% · 2 | 39.7% | 1.92 | 13.4% | 257 |
| 12.5% · 1 | 27.2% | 2.05 | 8.6% | 186 |
| 12.5% · 3 | 28.6% | 2.03 | 9.6% | 294 |

More size buys return with drop: Sharpe peaks at the smallest size and falls back to the bot's at
25%. Two open is best of 1/2/3. The config (12.5% · 2) stays; 6.25% is the choice if the drop
matters more than the return. At live equity (~$300) a 6.25% order is ~$19, over the $11 floor.

**R4 — how sure is the gain** (`scratchpad/sb/r4.mjs`: daily returns, deposits out, 30-day block
bootstrap, 5,000 draws; pass: the 90% interval of the yearly gain over the bot is above 0):
+8.2 points a year, 90% interval +2.6 to +15.4, 99.6% of draws above 0 → passes. The Sharpe gain
(+0.21) is not proven: interval −0.13 to +0.57, 84% of draws above 0. Deflated Sharpe of bot +
breakout with 3,100 trials counted: 0.969 — mostly the bot's own strength, not proof of the add-on.

Verdict: the breakout adds return with confidence and a likely but unproven Sharpe gain; its
settings are on a plateau; most of the gain comes from trend periods (the 2020-12 fold). Next: the
paper soak and its reconciliation.

## Limit orders everywhere (2026-10-26)

User: "limit orders everywhere please". First the question whether a resting limit buy under the
price would earn money on the scalper's entries, as it does on the breakout. Estimate, per trade, on
the committed bot's six-year engine replay (deep set, $190 + $10 a week, sleeve on, satellites off;
final $5,644 as before): 77 scalper round trips, mean +5.2%; a limit buy at offset x under the cycle's
open, resting V hours, fills when a 15m low reaches it (strictly under the open for x = 0); exits as
replayed. Scripts in the session scratchpad (`lim/dump.mjs`, `lim/estimate.mjs`).

| Offset · rests | Filled | Sum of returns (market: 402%) | Missed trades' mean return |
|---|---|---|---|
| 0 · 4 h | 74 | 405% | +3.5% |
| 0.2% · 4 h | 66 | 376% | +4.8% |
| 0.5% · 12 h | 61 | 404% | +2.7% |
| 1.0% · 12 h | 48 | 313% | +5.2% |

Every offset breaks even or loses: the scalper trades rarely and wins big, so a few missed winners
cost more than 0.2–0.7% saved on each fill. The ceiling is small anyway: modelled slippage over the six
years was $137 for the scalper and $29 for the sleeve, against $2,213 of profit.

Built instead: no naked market orders on any live path. Every scalper and sleeve order is an IOC limit
capped `risk.limitCapPct` (0.5%) past the price — a buy fills at the book within the cap and buys
nothing past it; a sell's unfilled rest goes to market (the catastrophe fallback, logged as an error,
the satellites' existing rule). 0.5% sits above the highest slippage tier the backtests charge (micro
0.35%), so the backtest model is unchanged and the baselines stay valid. A buy the cap refuses is
live-only (no order book in history) and listed under `INTENTIONALLY_LIVE_ONLY`.
Tests: `tests/executor/liveLimitOrders.test.js`.

## Section C: tier exit, Nasdaq risk-off, shared vs per-coin settings (2026-10-26)

Same six-year engine replay as above (deep set, $190 + $10 a week, sleeve on). Scripts in the
session scratchpad (`c6/`, `c8/`). Pass rule for C6 and C7, fixed before any run: beat the committed
bot's Sharpe over six years and in at least half of the 6-month folds. Each first had to pass a
per-trade estimate; neither did, so neither was built.

**C6 — loose RSI-tier exit on the scalper: rejected.** The breakout's tiers (exit when open profit ≥
1/2/4% and RSI < 35/45/55), and the same tiers at ×2 and ×4 profit, on the 77 scalper round trips
(gross sum 441%):

| Tiers | RSI 1h: Δ sum · fired (better/worse) | RSI 4h: Δ sum · fired |
|---|---|---|
| 1/2/4% | −147 pts · 29 (10/19) | −32 pts · 11 (3/8) |
| 2/4/8% | −81 pts · 19 (7/12) | −11 pts · 3 (1/2) |
| 4/8/16% | −56 pts · 8 (2/6) | 0 · never fires |

The scalper holds for days and wins big; a momentum dip cuts trades that go on to the 18% target.

**C7 — NASDAQ risk-off (M1, half size while NASDAQ < 100d EMA): rejected.** Scalper: the 15 trades
opened in risk-off averaged +7.45% net (win 73%) against +4.69% (63%) for the other 62 — halving them
costs money. Breakout (bot + breakout replay, $6,699 as before): 10 of 257 trades opened in
risk-off, total P&L −$5 — the rule would move ~$3 in six years.

**C8 — shared vs per-coin settings: a measurement, and the main finding of the section.**

1. *Most per-coin settings never trade.* 21 of 37 coins made 0 trades in six years. Every coin that
   trades has a trend part in its combo (EMA, PSAR, HeikinAshi, ADX, MACD or Supertrend; 16 coins);
   all 14 dip-buying combos (BB, CCI, RSI, Stoch, MFI, WilliamsR, OBV, S&R only) never pass the
   entry filters, and 7 combos with a trend part do not either.
   Cause: `perSymbolOptimizer.mjs`'s `runWindow` scores combos on raw votes — no 15m/4h/momentum/
   macro/regime filters, no multi-bar confirmation — against the rule "the optimizer runs the same
   filters as the live bot". It picks combos the live bot never trades.
2. *The per-coin edge is in-sample.* The settings were tuned 2026-05-24/29 on 1,460 12h candles —
   2024-05 → 2026-05, both halves used for selection. Shared settings (one combo for every coin, SL
   7.5% / TP 18% / conf 0.55; six trend combos, fixed before the runs):

| Setup | 2020-06 → 2024-05 (unseen by both) | 2024-05 → 2026-05 (bot's tuning window) | 2026-05 → 08 (unseen) |
|---|---|---|---|
| bot, per-coin | 20.2%/yr · Sharpe 1.82 · DD 6.0% | 22.8% · 2.23 · 6.7% | −3.5% · −1.54 |
| EMA+HeikinAshi+PSAR | 28.4% · 2.36 · 5.9% | 0.6% · 0.11 · 13.1% | −9.1% · −2.67 |
| ADX+MACD+Supertrend | 33.5% · 2.24 · 8.5% | −6.3% · −0.43 · 17.0% | −8.9% · −1.82 |
| ADX+EMA+MACD | 31.9% · 2.22 · 10.2% | −13.3% · −1.10 · 31.2% | −8.7% · −2.18 |
| MFI+SR+Supertrend | 21.2% · 1.94 · 7.6% | 1.1% · 0.19 · 7.8% | −8.7% · −4.21 |
| ADX+EMA+SR | 21.0% · 1.70 · 10.3% | 3.8% · 0.32 · 18.1% | −11.7% · −3.07 |
| HeikinAshi+SR+WilliamsR | 19.1% · 1.80 · 8.5% | −1.8% · −0.25 · 10.1% | −3.2% · −1.63 |

   Over the four years neither side was fitted on, every shared trend combo matches or beats the
   per-coin settings. In 2024-05 → 2026-05 every shared combo is flat or losing; the per-coin bot made
   22.8% a year there because it was chosen there. The six-year bot figure (Sharpe 1.91) includes
   two in-sample years, so it overstates what to expect live.
3. *Re-fitting does not help.* Every 6 months, pick the menu combo with the best Sharpe over the
   prior 24 months and trade it for the next 6: 2022-06 → 2026-08 gives 2.4%/yr, Sharpe 0.33, DD
   16.0% (bot 13.0% / 1.65 / 6.7%, in-sample for half of it; fixed EMA+HeikinAshi+PSAR 4.1% / 0.53).
   It beats the bot in 3 of 9 folds. It picks yesterday's winner.

What C8 means: the scalper's trend-following edge was strong in 2020 → mid-2024 and has been near zero
since, on every setting nobody fitted to that period. Its only money-making setting since 2024 is the
in-sample one. Nothing is changed in the bot from this; an honest per-coin re-fit needs the optimizer
to run the filter stack first (`runSuperbot.mjs --per-symbol` reruns the shared cells).

## Section D: taker-buy share, stablecoin supply (pre-registered 2026-10-26, before any data was read)

Baseline: the bot + breakout six-year engine replay ($6,699, 30.1%/yr, Sharpe 2.13, DD 9.2%; 257
breakout, 77 scalper, 196 sleeve trades). Two stages per idea, as in C:

1. *Per-trade estimate* on the replay's trades. Pass: the trades the rule removes have a mean net
   return below 0 **and** below the kept trades, and the sign holds in both halves (entries before
   2024-01-01 and from then on). A failed estimate ends the idea; nothing is built.
2. *Engine replay* (rule built on both sides, row in `liveParityInventory.test.js`). Pass: beat the
   bot + breakout's six-year Sharpe **and** its Sharpe in at least half of the 6-month folds; report
   2024-05 → 2026-08 and the unseen 2026-08 → 10 separately (C8 showed the earlier years flatter).

**D9 — taker-buy share as a breakout filter.** Share = taker-buy base volume ÷ volume of the 4h
signal bar (Binance kline field 9; the stored candles drop it, so the 8 breakout coins' 4h klines are
re-downloaded to the session scratchpad, not into `data/candles`). Rule F1: skip a breakout whose
share is < 0.50. Secondary F2 (reported, decides only if F1 passes too): skip when the share is under
the coin's mean share of the prior 48 bars. No other thresholds are tried.

**D10 — stablecoin supply as a liquidity regime.** DefiLlama's free total stablecoin supply (USD,
daily). Risk-off: the supply fell over the last 30 days, read from the last day closed before the
entry (one day of lag). Rule: no new scalper or breakout entries in risk-off; open trades are not
touched. Tested on the scalper and the breakout separately (each must pass its own estimate);
the sleeve is reported for information only.

### Section D results (2026-10-26): both ideas rejected at the estimate, nothing built

Scripts and downloaded data in the session scratchpad (`d/`). The 4h taker-buy klines for the 8
breakout coins matched the deep set bar for bar (85,908 bars, every volume identical).

**D9 — taker-buy share.** Signal-bar share across the 257 breakouts: median 0.526, quartiles
0.474 / 0.566. Both rules fail: the trades they skip make money.

| Rule | Kept: n · mean · before 2024 / 2024 on | Skipped: n · mean · before 2024 / 2024 on |
|---|---|---|
| F1 share < 0.50 | 160 · +1.19% · +1.55% / +0.87% | 97 · +2.38% · +3.13% / +1.22% |
| F2 share < prior-48 mean | 172 · +1.90% · +2.83% / +0.97% | 85 · +1.10% · +1.19% / +0.99% |

Low-share breakouts did *better* (F1). That would be a new hypothesis fitted on these trades, so it
is not tested here.

**D10 — stablecoin supply.** Supply shrank over 30 days on 29% of days (2020-06 → 2026-08), yet
few fast trades opened then:

| Stream | Shrinking: n · mean · before 2024 / 2024 on · P&L | Growing: n · mean · P&L |
|---|---|---|
| Scalper | 11 · −0.86% · +1.22% / −2.05% · −$30 | 66 · +6.24% · $1,733 |
| Breakout | 9 · −0.20% · −1.39% / +9.32% · +$4 | 248 · +1.70% · $856 |
| Sleeve (info) | 29 · −1.04% · +0.91% / −8.50% · −$138 | 167 · +46.8% · $840 |

The sign flips between the halves for both fast streams (4 and 1 trades in the weak half), and the
whole effect is $30 and $4 over six years. The sleeve's −$138 is a pattern seen, not a test.

Where A–D leave the bot: the breakout satellite is the only addition that held; every filter and
exit tried on top of it or the scalper failed before a build. The open problem is C8: the scalper's
per-coin settings are in-sample since 2024-05, and an honest re-fit needs the optimizer to run the
full filter stack first.
## Execution and reporting corrections (2026-10-27)

- Satellite entries now consult the same account-level daily-loss gate as scalper entries,
  including a fresh check between orders. Stops and cancellations remain active while blocked.
- A partial live fill becomes a managed position immediately, while only the unfilled quote
  remains reserved. Stops cancel the remainder and re-read the final cumulative fill before
  selling; a cancellation failure does not prevent closing the known exposure. The exit intent
  survives retries and restarts, including any later fills of an uncancelled order.
- Position state adds `orderId`, `orderFilledQty`, `orderFilledCost` and `satelliteExitReason`;
  pending orders add cumulative fill bookkeeping and an optional exit reason. Old files still
  load. Saving the position before the pending-order update prevents duplicate credit after an
  interrupted write; wallet claims do not count a managed partial fill twice. Per-position
  polling stays locked through the entire asynchronous exit, and atomic state renames retry
  briefly on transient Windows file locks.
- Replay price bars, deposits, signal cycles and breakout cycles now share one chronological
  timeline. Every held leg is marked from the same observation before valuation. Equity points
  carry their observation time, including intrabar core marks, rather than a future interval's
  result labelled with its start. The breakout uses live's one-minute scheduler delay.
  `toTs` still means the last signal cycle: its following interval is included, but later
  deposits and bars are not. Intrabar fill times remain 15m-bar estimates, not exchange ticks.
- Baselines, walk-forward, recalibration, superbot and optimizer scoring share calendar-day
  returns and sample-deviation Sharpe annualized with 365 days. Deposits are excluded from
  returns, the first day is retained, and missing calendar days carry the last valuation
  forward rather than compressing elapsed time. This does not reconstruct missing prices or
  make the USDC market gap tradable. DSR uses matching observation units. Trade-order Monte
  Carlo reports a per-trade Sharpe, not a fictional daily annualization.

Strategy settings and opt-in flags are unchanged; nothing is deployed by these corrections.
The historical tables above must be regenerated on their frozen datasets before being used for
new configuration decisions.

## Section E: DVOL in the sleeve's vol targeting (pre-registered 2026-10-27, before any DVOL data was read)

Baseline: the bot + breakout six-year engine replay, **rerun on the deep set after `449c39f`**
(the tables above predate the accounting fixes). Same setup as C and D: 2020-06-01 → 2026-08-10,
$190 + $10 a week, sleeve on, satellites as committed.

**E1 — DVOL instead of realized vol in the sleeve.** Today each sleeve slot is sized
`min(1, max(0.2, 0.6 / realizedVol)) × macro`, realized vol = the last 60 12h returns, annualized
(`engine.js` → `computeRealizedVolAnnual`). E1 replaces `realizedVol` for BTC and ETH with Deribit's
DVOL for that coin (30-day implied vol, keyless `public/get_volatility_index_data`): the close of
the last 12h DVOL bar closed at or before the cycle time, ÷ 100. Nothing else changes — target 0.6,
floor 0.2, macro overlay, ladder. BNB and SOL (rung C) keep realized vol: Deribit has no index for
them. Missing DVOL (before 2021-03-24, or no bar within 24 h) falls back to realized vol, so the
first ~10 months are identical by construction. No other target, floor or vol source is tried.

Why it might help: realized vol looks 30 days back, so it sizes up after a calm month just before a
spike; implied vol prices the coming 30 days. Known bias: implied vol usually sits above realized
vol (the variance premium), so E1 holds less on average and its *return* will likely fall for that
reason alone. Sharpe, not return, decides; the mean sleeve fraction is reported for both.

1. *Stage 1 — replay only* (a research flag in the replay; no live code). Pass: beat the
   baseline's six-year Sharpe **and** its Sharpe in at least half of the 6-month folds that start
   on or after 2021-04-01 (earlier folds are identical by construction and are not counted).
   Report 2024-05 → 2026-08 and the unseen 2026-08 → 10 (on the current live set) separately.
   A fail ends the idea.
2. *Stage 2 — live side*, only if stage 1 passes: DVOL fetched and stored on disk (as a
   market-data cache under `data/`, beside `nasdaqTrend.json` — not `runtimeDir()`, which holds bot
   state; corrected 2026-10-27, stage 2), stale or missing DVOL falls back to realized vol (logged), a row in
   `liveParityInventory.test.js`, tests; then the same replay through the shared engine path.

**E2 — DVOL sizing on the breakout** is pre-registered only after E1's result, and before any
breakout-by-DVOL number is looked at. The breakout has no vol sizing today (12.5% of equity per
trade), so E2 is a new sizing rule, not a swap.

### Baseline rerun after `449c39f` (2026-10-27)

Deep set (`126 36a73a13…`), same commands as before; calendar-day Sharpe (365 days, every day counted).

| Cell | Final | Yearly | Sharpe | Worst drop |
|---|---|---|---|---|
| bot | $5,674 (was $5,644) | 19.0% (20.2%) | 1.86 (1.91) | 6.8% |
| bot + breakout | $6,717 (was $6,699) | 27.9% (30.1%) | 1.97 (2.13) | 9.4% |

Balances barely moved; yearly return and Sharpe fell because flat days now count. The breakout still
beats the bot in 6/13 folds on return and 3/13 on Sharpe, as before.

### E1 result (2026-10-27): stage 1 passes, by a small margin

DVOL 12h bars for BTC and ETH from Deribit, 2021-03-24 → 2026-10-27, 4,087 each, no gaps. The replay
takes them through `runSuperbot.mjs --dvol <file>` (engine dependency `loadImpliedVol`, lookup
`impliedVolAsOf` — closed bars only, null after 24 h; live passes nothing and is unchanged).

| Window | bot + breakout | E1 |
|---|---|---|
| 2020-06 → 2026-08, Sharpe · return · worst drop | 1.967 · 358.7% · 9.4% | **1.983** · 360.2% · **8.5%** |
| 2024-05 → 2026-08 | 2.101 · 68.1% · 8.3% | 2.094 · 67.7% · 8.3% |
| 2026-08-10 → 10-24, unseen (frozen live set `56c35002…`) | $311.86 · Sharpe 2.16 · 8.3% | $312.24 · 2.15 · 8.4% |

Counted folds (from 2021-06): E1 has the higher Sharpe in **7 of 11** — all six from 2021-06 to
2023-12 (bear and flat markets: −2.79 → −2.66, −0.46 → −0.18) and 2024-12; it loses 2024-06, 2025-06,
2025-12, 2026-06 by 0.001–0.04. Both pre-registered tests pass.

Mean vol fraction per 12h cycle (2021-03 → 2026-08), realized vs DVOL: BTC 0.93 / 0.91, ETH 0.83 /
0.83. The expected variance premium hardly shows — vol is under the 0.6 target most of the time, so
both are capped at 1. E1 changes *when* the sleeve cuts size, not how much it holds on average.

Reading: the gain is a lower worst drop (9.4 → 8.5%) and better bear-market folds; since 2024 E1 is
level with or slightly behind realized vol. Per the pre-registration, stage 2 (live side) follows.

### E1 stage 2 (2026-10-27): built, on by default

- `src/data/dvolFeed.js`: Deribit fetch (15 s timeout), cache `data/dvol.json`, closed bars only,
  merged payload-wins through `mergeCandles()`; refreshes when the cache lacks the bar that closed at
  the last 12h boundary (a time-to-live would let a cycle size on the bar before it). Values outside
  5–500 are dropped; an outage keeps the cache. The backfill matched the stage 1 download on all
  8,174 values.
- `config.tsmCore.impliedVol = { enabled: true, maxAgeHours: 24 }`. Live (`main.js`) and every
  replay script read the same file; `replayEngine` throws if the config enables it and no rows are
  passed. Inventory row "Sleeve vol targeting on implied vol (DVOL)". Tests: `tests/data/dvolFeed.test.js`,
  `impliedVolAsOf` in `tests/engine/tsmCore.test.js`.
- Six-year replay through the config path (no `--dvol`): **$6,721.90**, the stage 1 figure to the
  cent. Paper boot: BTC sized on implied vol 38%, ETH 53%.

E2 (DVOL sizing on the breakout) is next and gets its own pre-registration.

## Section E2: DVOL sizing on the breakout (pre-registered 2026-10-27, before any breakout-by-DVOL number was read)

Baseline: bot + breakout with E1 on, the six-year replay through the config path ($6,721.90 above),
same window, deposits and candle set.

**Rule.** Each breakout entry is sized `equity × perTradePct × f` instead of `equity × perTradePct`,
with `f = min(1, max(0.2, 0.6 / dvol))` — the sleeve's own target and floor, unchanged, so no new
number is fitted. `dvol` = BTC's DVOL ÷ 100, the close of the last 12h bar closed by the cycle time
(`impliedVolAsOf`, null after 24 h). One gauge for all 8 breakout coins, ETH included: the alts have
no index, and BTC DVOL stands for market-wide fear. No DVOL (before 2021-03-24, or none within 24 h)
→ `f = 1`, today's size. The cap at the free balance and the $11 floor apply after `f`, so a smaller
order can be refused at small equity — that is counted, not corrected. The strongest-coin satellite
is off and is not changed. No other target, floor, gauge or per-coin variant is tried.

Why it might help: the breakout's losers cluster in panics (wide 4h ranges, false breaks, gap-through
stops); implied vol is high exactly then. Expected effect: it bites only when BTC DVOL is above 60,
mostly 2021–22, so the post-2024 folds should be nearly identical.

1. *Stage 1 — replay only* (research flag). Pass: beat the baseline's six-year Sharpe **and** its
   Sharpe in at least half of the 6-month folds starting on or after 2021-04-01. Report 2024-05 →
   2026-08 and the unseen 2026-08 → 10 separately, plus breakout trades taken, orders refused under
   the floor, and the mean `f` at entry. A fail ends the idea.
2. *Stage 2 — live side*, only on a pass: config flag, the shared engine path (`planSatelliteEntry`),
   the DVOL loader both sides already have, a row in `liveParityInventory.test.js`, tests.

### E2 result (2026-10-27): rejected at stage 1, nothing built

Research flag through the shared engine path (`planSatelliteEntry` scaled by `f`), deep set
`36a73a13…`. The flag-off control reproduced the baseline to the cent ($6,721.90).

| Window | baseline (E1 on) | E2 |
|---|---|---|
| 2020-06 → 2026-08, Sharpe · return · worst drop | **1.983** · 360.2% · 8.5% | 1.974 · 343.8% · 8.3% |
| 2021-04 → 2026-08 | **1.524** · 108.3% | 1.512 · 100.6% |
| 2024-05 → 2026-08 | **2.094** · 67.7% | 2.091 · 67.3% |

Counted folds (from 2021-06): E2 has the higher Sharpe in **5 of 11** — it wins 2021-12, 2022-12,
2023-06, 2023-12, 2024-06 and loses 2021-06 (1.008 → 0.955), 2024-12, and four more by ≤ 0.001.
Both tests fail. The same 257 breakout trades were taken (no order fell under the $11 floor; 2
refusals for stop distance in both); `f` < 1 on 82 of them, mean `f` at fill 0.93, minimum 0.57.
Breakout PnL $867 → $807: the trades taken while BTC DVOL was above 60 earned money on balance, so
shrinking them cost return without cutting the worst drop by more than 0.2 points. The unseen
window was not run; the verdict was already decided. Per the pre-registration the idea ends; the
research code was reverted.

## Section E, item 2: exchange events for the four coins that stopped printing (2026-10-27)

Source: Binance's announcement feed (keyless `bapi/composite/v1/public/cms/article/list/query`,
catalogs 161 "Delisting", 49 "Latest News", 157 "Maintenance"; complete from 2025-01, rate-limited
at ~1 request/s) and `api/v3/exchangeInfo` for the pair status today.

| Coin | Event | Notice | Effective | Today |
|---|---|---|---|---|
| LSK | LSK/USDC pair removed (token stays) | 2026-06-09 08:30 | 06-12 | LSKUSDC `BREAK`, LSKUSDT trading; monitoring tag 07-24 (after) |
| TON | **Rebranded to GRAM, 1:1** — not a delisting | 2026-06-12 06:00 | halt 06-30 03:00 → GRAM/USDC opens 07-02 08:00 at 1.601 (TON's last 1.598) | TONUSDC `BREAK`, **GRAMUSDC trading** |
| GMX | GMX/USDC pair removed (token stays) | 2026-07-07 09:15 | 07-10 | GMXUSDC `BREAK`, GMXUSDT trading |
| VANRY | Token delisted | 2026-08-03 03:30 | 08-17 | VANRYUSDC `BREAK`; monitoring tag 07-03 (31 days before) |

- None of the four has a removal notice of the "monitoring tag first" kind except VANRY. The tag
  led the token delistings in the feed by 1–5 months (PIVX 06-18 → 08-03, NFP/POND 04-30 → 06-26,
  COS/MBOX 03-06 → 06-05, HIGH 04-14 → 06-05); USDC-pair removals come with 3 days' notice and no tag.
- No replay held any of the four at its event (six-year deep set, unseen 2026-08 → 10), so a veto on
  these dates changes no backtest trade: "no harm" holds trivially and the value is insurance — a
  position held through a pair removal is stranded (the stale-series guard skips the symbol, so no
  exit runs).
- TON is a universe bug, not a veto case: `config.symbols` still lists `TON/USDC`, a ticker that has
  not traded since 06-30, while the same coin trades as `GRAM/USDC`.

### TON → GRAM in the universe (2026-10-27, user decision)

`config.symbols` and the per-coin settings now name `GRAM/USDC` (TON's tuning unchanged). New
`src/scripts/stitchRenamedPair.mjs` wrote `GRAM_USDC_{12h,4h,15m}.json` = TON's history + GRAM's
bars (merged through `mergeCandles()`, stopping where the set's BTC file stops; it refuses a price
gap over 5% — here 0.19%). TON's files moved to `data/candles_retired/`. GRAM added to both
slippage maps (mid tier, as TON). New fingerprints: live set `126 193218ef…` (was `a81cdff7`), deep
set `126 724b7eed…` (was `36a73a13`); the protected frozen copy is unchanged and still has TON.

- Six-year replay (bot + breakout, E1 on): $6,721.65, Sharpe 1.9826, worst drop 8.5% (was $6,721.90).
- Unseen 2026-08-10 → 10-24 on the live set: $311.97 (frozen-set run with TON: $312.24).
- No GRAM trade in either window. The changes come from GRAM counting again in the portfolio median
  ATR and the correlation matrix. This is the new baseline for the veto below.
- Paper boot: GRAM loaded 1,590 bars from disk, fetched live, merged payload-wins.
- Live: if the live account held TON on 06-30, Binance converted it to GRAM; position restore now
  sees it under `GRAM/USDC`.

### Venue veto: built, on by default (2026-10-27, user decision: tag block + exit)

- Rule (`src/risk/exchangeEvents.js`, no timing parameter): a monitoring tag blocks new entries
  until lifted; a USDC-pair removal or token delisting blocks entries and sells a held scalper
  position at the first cycle after the notice, until a week after the removal takes effect (by
  then the stale guard owns the symbol, and a relisted pair can trade again). Scalper and
  satellites; the sleeve trades only BTC/ETH/BNB/SOL.
- Feed (`src/data/exchangeEventsFeed.js`): Binance CMS catalogs 161 and 49, newest page of each
  once per 4h period, a body only for a new pair-removal notice; cache `data/exchangeEvents.json`;
  an outage keeps the cache (fail-open). Backfill `src/scripts/buildExchangeEvents.mjs`: 4,482
  notices since 2020 → 363 events (169 delistings, 46 USDC-pair removals, 140 tags, 8 lifted).
  Five touch our universe, all in 2026 (table above).
- Both sides: `main.js` → `loadExchangeEvents`; `engineReplay` keeps events announced by its clock
  and throws when the config enables the veto and none are passed. Inventory row "Binance venue
  veto". PortfolioBacktester has no veto (`runEngineReplay.mjs` turns it off for its comparison).
- Pass rule "no harm + covers known events": six-year replay $6,721.65, Sharpe 1.9826 — identical
  to the GRAM baseline; one VANRY BUY blocked on its tag (2026-07), not taken in the baseline
  either. Unseen window $311.97, identical. Covers LSK, GMX and VANRY; TON was a rename.
- Paper boot: the feed refreshed (no new events). Two transient kline fetch failures (GRAM history
  init, TRX — retried; the same URL answered 200 a minute later), unrelated to the change.
- **Deploy step:** `data/` is not in git. On the live PC run `node src/scripts/buildExchangeEvents.mjs`
  once before the first boot (~10 minutes, paced for the rate limit), or copy
  `data/exchangeEvents.json` over. Without it the first refresh reads only the newest page of each
  catalog (about six weeks of news), and an older monitoring tag would be missed.

## Section E, item 3: CPCV and PBO (pre-registered 2026-10-27, before any PBO number was computed)

Tool, beside the deflated Sharpe (`src/backtester/overfitting.js`):
- `pboCscv(matrix)` — probability of backtest overfitting by combinatorially symmetric
  cross-validation (Bailey, Borwein, López de Prado & Zhu 2017). Rows = days, columns = trials. The
  days are cut into 16 equal blocks; for each of the C(16, 8) = 12,870 halvings, the trial with the
  best Sharpe in one half is ranked in the other half. PBO = the share of halvings where that trial
  ranks at or below the median. Also reported: how often it loses money in the other half, and the
  slope of its other-half Sharpe on its in-half Sharpe.
- `cpcvSplits()` and `cpcvPathIds()` — combinatorial purged cross-validation (López de Prado 2018,
  ch. 12), for the ranker in item 4. Same fold, purge and embargo convention as skfolio 1.12.2
  `CombinatorialPurgedCV`. `cpcvSelection(matrix)` gives the out-of-sample Sharpe of each
  recombined path for "pick the trial with the best Sharpe on the training groups".
- Cross-check, run once (skfolio in a scratch venv, not a dependency): skfolio's train and test
  indices and path ids must equal ours exactly on a set of sizes, purges and embargoes. skfolio has
  no PBO, so PBO is checked against an independent NumPy version written from the paper (equal to
  1e-9).

Two measurements. They are diagnostics: no bot setting changes from them. They are for item 4,
whose optimizer retune will report PBO and CPCV paths.
- *M1 — the C8 shared menu*, rerun on the current engine: the six shared trend combos of the C8
  table (bot cell, deep set, 2020-06-01 → 2026-08-10, $190 + $10 a week, sleeve on). The per-coin
  bot is left out (its settings were fitted on part of the period). Expected in advance: a high PBO,
  since picking the menu's best past Sharpe every 6 months already failed (C8 point 3).
- *M2 — the breakout plateau grid* (the research simulator's 4h trades, large coins, 27 setups ×
  4 entries × 4 exits = 432 trials, one position per coin, net of the same costs as
  `gridAnalyze.mjs`). Daily series = the sum of the net returns of the trades that close that day
  (a constant position size does not change a Sharpe ranking). 2020-07 → 2026-08, so the final
  year, read once before, is inside. Also reported: the out-of-sample rank of the committed cell
  (48 bars, 1.5× volume, 1.5 ATR stop, limit 0.5% under, 2R, 48 h) — the bot took the plateau
  centre, not the grid's best, so PBO describes the grid and not that choice.
- CPCV settings for both: 10 groups, 2 test groups (45 splits, 9 paths), purge 7 days (the aging
  exit's longest hold), embargo 7 days.

How to read PBO: below 0.25, picking the best past Sharpe from that menu is mostly sound; 0.25–0.5,
weak; 0.5 or more, worse than picking at random — do not select from that menu by past Sharpe.

### Item 3 result (2026-10-27): tool built and cross-checked; both menus are in the "weak" band

Cross-check (skfolio 1.12.2 in a scratch venv): train and test indices and path ids identical on
six settings (100–2,230 rows, 4–10 groups, 2–3 test groups, purge 0–7, embargo 0–7). PBO equal to a
NumPy CSCV written from the paper (largest logit difference 4e-16, three matrices). Fixtures in
`tests/backtester/overfitting.test.js`; report script `src/scripts/runOverfitting.mjs`.

| | M1: C8 shared menu (6 trials) | M2: breakout grid (432 trials) |
|---|---|---|
| PBO | **0.29** | **0.25** (0.252) |
| In-sample winner loses money out of sample | 5% of halvings | 12% |
| Winner's out-of-sample Sharpe vs in-sample | 2.41 − 0.95 × IS | 1.45 − 0.68 × IS |
| Full-period best (Sharpe) / median trial | ehp 1.36 / 1.15 | 96-bar, L0.2, 2R/48 h 1.20 / 0.34 |
| Deflated Sharpe of the best | 0.998 | 0.39 |
| CPCV paths, best training Sharpe traded (9 paths) | 1.12 … 1.37, mean 1.24 | −0.28 … 0.87, mean 0.47 |

- *M1:* the advance expectation (a high PBO) was not met: 0.29 is weak, not worse than random, and
  CPCV's 9 paths all beat the median combo (mean 1.24 vs 1.15). The two readings differ from C8
  point 3 because CSCV and CPCV mix past and future blocks, while the C8 re-fit only looked back
  (24 months → next 6) through the 2024+ break. Caveat: these are whole-account series with the
  sleeve on, shared by every trial (daily correlation 0.74–0.91), so the sleeve carries most of
  the Sharpe and the deflated Sharpe of 0.998; the menu differs only in the scalper part.
  ehp (EMA+HeikinAshi+PSAR) was the in-sample winner in 51% of halvings and is the full-period
  best on the current engine.
- *M2:* picking the grid's best past Sharpe is borderline (PBO on the line, deflated Sharpe 0.39:
  the grid's best is not significant after 432 trials). The committed cell (48 bars, 1.5×, 1.5
  ATR, limit 0.5%, 2R/48 h) has a mean out-of-sample rank of 0.89 — above 97% of the cells — and
  was never the in-sample winner: the plateau centre is a better choice than the grid's top.
- No bot setting changes. Item 4's optimizer retune reports PBO and CPCV paths with this tool, on
  scalper-only series where it can.

## Section E, item 4, part 1: the optimizer runs the live filter stack (2026-10-27)

C8 point 1 found the cause of the 21 never-trading coins: `perSymbolOptimizer.mjs`'s `runWindow`
scored combos on raw votes in a bare simulator. Fixed by running every combo through the engine
the parity tests hold equal to live:

- `src/backtester/symbolTrial.js`: a trial is a `PortfolioBacktester` run with `FULL_LIVE_FILTERS`,
  live sizing (`basePctOverride` = `risk.maxPositionPct`), multi-bar confirmation and the scaled
  threshold, in which only the coin under test has strategies. Every other coin is silent context:
  BTC feeds the regime/bear policy and the macro filter, all of them feed the median ATR that sizes
  the entry. Not modelled per coin: the 4-slot competition and the correlation cap, so a config
  change is still decided by the portfolio replay.
- Each window trades on the full history before it (warm indicators, `tradeFromTs`), and the
  holdout sees no bar after its end. The optimizer's own rule is unchanged (train on the later half
  of the last `--candles` bars, validate on the earlier half, `MIN_TRADES` 8, deflated-Sharpe
  penalty); it now reads candles from disk only.
- Speed: the 20 strategies run once per coin (`precomputeStrategyResults`), each combo replays them
  through the real `SignalAggregator`; `PortfolioBacktester.computeSharedSeries()` (regime, 15m/4h
  indexes, macro trend) and the context's price-only row fields (`computeSignalRows(…, { base })`)
  are computed once per window. 360 → ~70 ms a combo; coins run in parallel child processes
  (~2 min a coin, 37 coins ≈ 8 min on 10 workers). Run with `FILE_LOG_LEVEL=warn`: the aggregator's
  per-bar debug lines otherwise go to `logs/`.
- Checks: `tests/backtester/symbolTrial.test.js` — a trial equals a plain run with the other coins
  silent (trades, equity curve, filter counts; a mutated ATR base fails it), the threshold is
  scaled, mismatched shared series are refused. `runEngineReplay.mjs` on 2026-08-20 → 10-24:
  6/6 identical after the backtester change. The optimizer's local `aggregate()` is gone; the two
  static parity fixtures now require it to score through `symbolTrial.js`.
- Smoke run, ETH (live set): of 2,280 training combos, 648 take a trade under the live filters and
  53 reach 8 trades; the current combo takes 2 holdout trades.

## Section E, item 4, part 2: does a per-coin combo pick hold up? (pre-registered 2026-10-27, before any trial was run)

M3 measures the optimizer's search now that it runs the live filters. Diagnostic first: no bot
setting changes from it.

- Trials: for each of the 37 coins, the optimizer's menu — 1,140 three-strategy combos × minConfidence
  0.55 / 0.70 = 2,280 single-coin trials (`symbolTrial.js`: live filters and sizing, the coin's own
  stop and target from config, $1,000, no deposits). Deep set (`724b7eed`), trading 2020-06-01 →
  2026-08-10. Series: each trial's daily return.
- R1, per coin: PBO (CSCV, 16 blocks) and the share of halvings where the in-sample winner loses
  money; also how many trials trade at all and how many reach 8 trades.
- R2, walk-forward refit (decides): at each fold start (every 6 months from 2022-06-01, 9 folds, the
  last one ends 2026-08-10), each coin picks the trial with the best Sharpe over the prior 24 months
  among trials with ≥ 8 entries in those 24 months, and holds it for the fold; no eligible trial →
  the coin sits out. Book = equal-weight mean of the 37 coins' daily returns (sitting out = 0).
  Control A: EMA+HeikinAshi+PSAR at 0.55 on every coin (the C8/M1 best shared combo), same engine.
  Control B (report only, in-sample after 2024-05): today's per-coin config.
  **Pass:** R2's Sharpe over 2022-06-01 → 2026-08-10 beats A, and R2 beats A in at least 5 of the 9
  folds.
- Approximation: R2 switches between trial columns at a fold boundary, so a position open in the
  old trial is dropped there and the new trial's state is taken as it stands.
- Expected in advance: high per-coin PBO (2,280 overlapping trials, few trades each) and an R2 fail
  — C8 point 3 saw menu refits pick yesterday's winner.
- What it decides: a fail means no per-coin retune is applied; the optimizer stays a tool, and the
  per-coin question moves to the cross-coin ranker (one model for all coins, part 3). A pass sends
  the forward-only picks to the portfolio replay (stage 2, pass rule as section D).

## Section E, item 4, part 3: a cross-coin ranker (pre-registered 2026-10-27, before any feature or M3 result was read)

One model for all coins in place of per-coin settings: each week, rank the coins by predicted
next-week return and hold the top ones. Stage 1 is a research estimate on a clean weekly portfolio;
nothing is built into the bot unless it passes.

- Data: deep set (`724b7eed`). Decisions every Monday 00:00 UTC, 2020-06-01 → 2026-08-03; each uses
  bars closed by then and fills at that 12h bar's open. A coin is eligible with ≥ 400 closed 12h
  bars and a bar opening at the decision time. Its outcome is the open-to-open return to the next
  Monday; a coin with no bar then is closed at its last close (no look ahead at delistings).
- Features (closed bars only; each ranked across the eligible coins to [−0.5, 0.5], missing = 0):
  returns over 12 h, 1, 2, 4, 12 and 26 weeks; close vs 20/50/100/200-day SMA; 30-day volatility and
  downside volatility; largest 12h return in 30 days; 7-day vs 30-day quote volume; 30-day quote
  volume (size); 60-day beta to BTC and residual volatility; RSI 14, ADX 14, 20-bar Donchian
  position (12h); and the 20 strategies' votes at the decision bar (signed confidence, the
  CTREND-style signal aggregation). Target: next-week return, ranked the same way.
- Models, fixed in advance: **primary = ridge, α = 10, all features**. Also reported: ridge α = 1 and
  α = 100; ridge on the 20 votes only; ridge on the price features only; two gradient-boosted tree
  models (scikit-learn `HistGradientBoostingRegressor`: depth 3, rate 0.05, 200 iterations, 200
  per leaf; depth 2, rate 0.05, 300 iterations, 400 per leaf). Python in a scratch venv; features
  computed in JS with the bot's own indicators and strategies.
- Walk-forward: refit at each of the 9 fold starts of part 2 (2022-06-01, every 6 months) on every
  earlier week whose outcome ended before the fold (purge 1 week), expanding from 2020-06-01.
- Portfolio, all variants and baselines alike: while BTC is in the satellites' 12h uptrend (EMA 100
  over EMA 400, close above the slow), hold the top 5 equally; otherwise cash. Costs: 0.1% fee
  plus the coin's slippage tier per side on the traded amount. Baselines: **M** = top 5 by 7-day
  return (the strongest-coin satellite's ranking), **EW** = every eligible coin, BTC alone. Ungated
  versions are reported too.
- **Pass (stage 1):** over 2022-06-01 → 2026-08-10 the primary's net Sharpe beats M and EW; it beats
  M in at least 5 of the 9 folds; and its out-of-sample information coefficient (weekly Spearman of
  prediction vs outcome, all eligible coins, ungated) has a mean above 0 with t > 2. Also reported:
  PBO over the 7 model variants and 3 baselines, CPCV paths for the primary (10 groups, 2 test,
  purge and embargo 1 week), the deflated Sharpe with 10 trials, and 2024-05 → 2026-08 alone.
- Expected in advance: a small positive IC, and not enough to beat M after costs — weekly crypto
  momentum is the known effect, and the model mostly re-weights it.
- Stage 2, only on a pass: the model's rank replaces the 7-day-return rank of the strongest-coin
  satellite in the engine (JS inference, retrain schedule, a `liveParityInventory` row), judged by
  the engine replay as in section D.

### Part 2 result (2026-10-27): FAIL — per-coin menu picks do not hold up

Trials built in ~40 min (10 workers, ~130–230 ms a trial); scripts `e4/m3build.mjs`,
`e4/m3analyze.mjs` in the session scratchpad. LSK has no USDC bars in the deep set (all its trials
are flat) and is left out of R1.

- **R1:** on a typical coin 972 of the 2,280 trials trade at all and 201 reach 8 trades in six years
  (live filters on — the old optimizer saw none of this). Median PBO over 36 coins **0.43**; 15 coins
  at 0.5 or more (picking by past Sharpe is worse than random there), 3 below 0.25 (ETH 0.20, XRP 0.23,
  PEPE 0.13). Restricted to trials with ≥ 8 trades: median 0.49, 18 of 36 at 0.5 or more. The past
  winner loses money out of sample in a median 36% of halvings.
- **R2 (decides):** equal-weight book of 37 coins, 2022-06-01 → 2026-08-10.

| Fold | R2 refit | A: EMA+HeikinAshi+PSAR 0.55 | B: today's config (in-sample after 2024-05) | coins with a pick |
|---|---|---|---|---|
| 2022-06 | 0.11 | **2.98** | 1.99 | 10 |
| 2022-12 | 0.12 | **1.55** | −1.25 | 10 |
| 2023-06 | **0.92** | 0.66 | 1.07 | 10 |
| 2023-12 | **0.93** | 0.34 | −1.73 | 5 |
| 2024-06 | **0.27** | 0.17 | 4.00 | 8 |
| 2024-12 | −1.23 | **1.50** | 2.48 | 29 |
| 2025-06 | **−0.28** | −0.29 | 2.63 | 32 |
| 2025-12 | **1.54** | −1.86 | 2.56 | 34 |
| 2026-06 | **0.20** | −1.60 | −1.46 | 36 |
| Whole span | −0.13 | **0.32** | 1.86 | |

  R2 beats A in 6 of 9 folds but loses over the whole span (−0.13 vs 0.32): **FAIL** (both tests
  were required). The expected high PBO came true on half the coins; the expected R2 fail came true.
- B is 2.69 over 2024-05 → 2026-08 — the window its settings were fitted on — and mixed before it
  (2022-12 −1.25, 2023-12 −1.73): the same in-sample pattern as C8.
- Per the pre-registration: no per-coin retune is applied. `perSymbolOptimizer.mjs` stays a tool
  (now an honest one); today's per-coin settings are kept, and remain in-sample since 2024-05.

### Part 3 result (2026-10-27): FAIL at stage 1 — a real cross-coin signal, but no portfolio that beats BTC

Scripts and data in the session scratchpad (`e4/rk_features.mjs`, `e4/rk_model.py`, `rk_dataset.json`):
4,722 coin-weeks over 323 Mondays; the BTC gate was on in 171 of them. All numbers are walk-forward
out of sample, 2022-06-01 → 2026-08-10 (195 weeks, gate on in 102), net of costs.

| Gated, top 5 | Sharpe | Return | Worst drop |
|---|---|---|---|
| **ridge α = 10 (primary)** | **0.33** | 17.4% | 59.8% |
| ridge α = 100 / price features only | 0.51 / 0.49 | 62.3% / 58.3% | 45.9% / 51.0% |
| ridge α = 1 / votes only | 0.24 / −0.10 | 0.0% / −52.4% | 60.5% / 71.1% |
| trees depth 3 / depth 2 | 0.01 / 0.14 | −31.1% / −14.1% | 63.1% / 61.1% |
| M (top 5 by 7-day return) | −0.11 | −53.9% | 76.0% |
| EW (every eligible coin) | 0.05 | −33.2% | 60.4% |
| BTC alone | **0.55** | 61.4% | 34.8% |

- Verdict by the written rule: **FAIL** — the primary beats M (0.33 vs −0.11) and EW (0.05), and its
  IC is +0.103 with t = 3.69, but it beats M in only 4 of 9 folds.
- Why the fold count is low (a data limit, recorded, not used to change the verdict): the deep set
  holds USDC pairs, and only 8–10 of the 37 coins have USDC history in 2020–2022, none from late
  2022 to early 2023 (Binance's USDC pairs were paused), 3 through 2023, 16 by 2024-08 and 36 from
  2025-11. Three folds were all cash (gate off: 2022-06, 2025-12, 2026-06) and two had 5 or fewer
  eligible coins (2022-12, 2023-06), so every ranking held the same basket. In the four folds where
  the rankings could differ, ridge beat M in all four (2023-12 2.43 vs 1.52, 2024-06 0.54 vs 0.23,
  2024-12 −0.65 vs −2.01, 2025-06 0.60 vs 0.47). 2024-05 → 2026-08: ridge 0.15, M −0.33, EW −0.14.
- The signal is real and comes from price, not from the strategies: out-of-sample IC +0.10 to +0.12
  (t 3.2–4.3) for every ridge model on price features and both tree models; the 20 strategy votes
  alone have none (−0.026, t −1.2). 7-day momentum has a *negative* IC (−0.054, t −2.0): over a
  week, crypto coins mean-revert. That is why the strongest-coin satellite (top by 7-day return)
  lost money.
- No long-only alt basket beats holding BTC here: every gated basket fell 46–76% at its worst, BTC
  35%. PBO over the 10 series 0.16 (BTC and ridge-on-price the usual in-sample winners); deflated
  Sharpe ridge 0.44, BTC 0.62. CPCV paths for the primary (which train on later weeks too, back to
  2020): 0.84 … 0.98, mean 0.90.
- Per the pre-registration nothing is built. What it suggests for a *new* test (to be pre-registered,
  mostly 2024+ data): use the ranker's score as a filter on entries the bot already makes, or to
  skip the coins it ranks lowest, rather than as a stand-alone basket.

## Section E, item 4, part 4: the ranker as a filter on the bot's own entries (pre-registered 2026-10-27, before any entry was scored)

Part 3 found a real cross-coin signal (IC +0.10, t 3.7) but no basket that beats BTC. This test
asks the narrower question it suggested: does the ranker's score pick out the bot's *bad* entries?

- Trades: the baseline six-year replay (bot + breakout, E1 on, venue veto on; deep set `724b7eed`;
  $190 + $10 a week; 2020-06-01 → 2026-08-10; $6,721.65). Scalper and breakout are judged
  separately; the sleeve is not filtered.
- Score at an entry: decision time τ = the latest 12h boundary at or before the entry's cycle time
  (scalper: the entry bar's open; breakout: its 4h cycle time, floored to 12h). Part 3's features,
  from 12h bars closed by τ, for every coin eligible at τ (≥ 400 closed bars and a bar opening at τ),
  ranked across those coins as in part 3. The feature code is shared with part 3 and must reproduce
  its Monday rows exactly.
- Model: part 3's primary, **ridge α = 10 on all features**, kept unchanged although ridge on the
  price features alone did better out of sample (switching now would be choosing on that result).
  Refit on the 1st of every month from 2021-01-01 on every Monday row of part 3's dataset whose
  outcome week ended before the refit; an entry uses the latest refit before τ.
- q = the entered coin's percentile among the eligible coins at τ, (rank − 1) ÷ (n − 1), 0 = lowest.
  An entry is unscored (kept, counted apart) when n < 6, when the coin itself is not eligible, or
  when τ is before 2021-01-01.
- **Rule R: skip an entry with q < 1/3** (the bottom third). Reported, not deciding: q < 1/2. No
  other cutoff is tried.
- **Pass (stage 1, section D's rule, per stream):** the trades R removes have a mean net return
  (fees and slippage included) below 0 **and** below the kept trades' mean, and both hold in each
  half (entries before 2024-01-01 and from then on). Reported: n, mean, win rate, dollar P&L,
  Welch t. A fail ends the idea; nothing is built.
- Expected in advance: the bot's entries are already chosen by trend strategies, so few fall in the
  bottom third, and the pre-2024 half has few scalper trades (only 8–10 coins had USDC pairs then).
  A fail on sample size is the likely outcome for the scalper.
- Stage 2, only on a pass: ridge inference and the monthly refit in one JS module used by live and
  the replay, a `liveParityInventory` row, then the engine replay with section D's stage 2 rule.

### Part 4 result (2026-10-27): FAIL — the ranker's lowest-ranked entries are the bot's better trades

Scripts in the session scratchpad (`e4/p4dump.mjs`, `e4/rk_lib.mjs`, `e4/p4features.mjs`,
`e4/p4_model.py`). The replay reproduced the baseline to the cent ($6,721.65); the shared feature
code rebuilt part 3's Monday rows exactly for every coin. 334 entries (77 scalper, 257 breakout);
an entry is the sum of its partial exits, net return = P&L ÷ cost.

| Rule R (skip q < 1/3) | Removed | Kept | Welch t |
|---|---|---|---|
| Scalper, all scored (56) | 23, mean **+8.98%**, win 70%, $777 | 33, +3.16%, 67%, $672 | 1.86 |
| Scalper, before 2024 | 0 | 4, +2.49% | — |
| Scalper, 2024 on | 23, +8.98% | 29, +3.26% | 1.79 |
| Breakout, all scored (193) | 28, mean **+3.49%**, win 32%, $349 | 165, +1.51%, 30%, $525 | 0.81 |
| Breakout, before 2024 | 14, +4.09% | 55, +3.29% | 0.19 |
| Breakout, 2024 on | 14, +2.88% | 110, +0.62% | 0.78 |

- **FAIL for both streams**: the removed trades made money in every half, more than the kept
  ones. q < 1/2 gives the same picture (scalper removed +7.89% vs kept +2.66%; breakout +5.75% vs
  +0.70%). Unscored: 21 scalper and 64 breakout entries (before 2021, or fewer than 6 eligible coins).
- As expected the breakout entries sit high in the ranking (median q 0.75); the scalper's do not
  (0.43). Its pre-2024 half has 4 scored trades, so it could not have passed on its own.
- Reading: the ranker learned the one-week reversal (part 3), so a coin that has just run up ranks
  low — and the bot's trend entries buy exactly those coins and hold them for weeks. The two signals
  work at different horizons. Using the score the other way round (keep only the bottom third) is
  a new idea chosen on this result, at t < 2; it is recorded, not pursued.
- Per the pre-registration nothing is built. Item 4 is closed.

## Section E, item 5: token unlocks (pre-registered 2026-10-27, before any price around an unlock was read)

**Source, free and keyless:** DefiLlama's emission datasets,
`https://defillama-datasets.llama.fi/emissions/<slug>` (the `api.llama.fi/emission*` routes now
answer 402). Each file holds a daily cumulative unlocked-token series per allocation and a map of
allocations to categories. 23 of our 37 coins have one (none for XRP, ADA, BCH, LTC, ACH, LSK, PAXG,
PIXEL, THETA, VANRY, RENDER, PEPE; BTC and DOGE have no vesting). Snapshot of 2026-10-27 in the
session scratchpad (`tu/raw/`, sha256 of the file hashes `b209eafb…`). It is *today's* version of
each schedule: unlock dates are public in advance, but later corrections to the schedule are
hindsight this test cannot remove.

**Event:** a UTC day on which the coin's insiders + private-sale allocations rise by ≥ 1% of its
total unlocked supply of the day before (`tu/events.mjs`; slug choice where two exist:
`near-protocol`, `curve-finance`, `injective`, `arbitrum`). Event counts were read before writing
this (no prices): 222 in 2020-06 → 2026-08, about 130 with USDC prices around them, almost all ARB,
ENA, SUI, JUP, LINK, APT, ENS.

**Why not section D's per-trade rule:** the bot barely trades these coins. The breakout's 8 coins
have only AVAX and BNB events, almost none with prices; the scalper's coins with events (ENS, TIA,
JTO, AVAX, INJ) give a handful of trades near an unlock at most. So stage 1 asks whether the effect
exists in our universe at all, on every event.

1. *Stage 1 — event study* (deep set `724b7eed`, 12h USDC bars). τ = 00:00 UTC of the event day; an
   event counts if the coin and BTC both have bars opening at τ − 30 d and τ + 14 d. Abnormal return
   = coin log return − BTC log return, open to open. **Primary window: τ − 14 d → τ** (the window
   an entry veto would cover). **Pass:** mean abnormal return < 0 with t < −2 (events as
   independent), the median < 0, the mean < 0 in both halves of the events split at their median
   date, and the mean < 0 with any single coin left out. Reported, not deciding: τ − 30 d → τ,
   τ → τ + 7 d, τ → τ + 14 d, and per coin. A fail ends the idea.
2. *Stage 2 — only on a pass:* an entry veto built like the venue veto: no new scalper or satellite
   entry in a coin while an event of ≥ 1% is due within 14 days; held positions untouched. A dated
   event file under `data/` refreshed from the same source (fail-open on an outage), read by
   `main.js` and `engineReplay` alike, a `liveParityInventory` row, tests. Pass rule as the venue
   veto's: six-year replay Sharpe not below the baseline (1.9826) and the unseen 2026-08 → 10
   window not worse; blocked entries listed.

Expected in advance: published research (Keyrock 2024, ~16,000 unlocks) finds prices drift down
before large team and investor unlocks. Here most events are monthly unlocks of the same few
coins, which the market can see coming, so a weaker effect than in that study is likely.

### Item 5 result (2026-10-27): stage 1 passes as written, but a control shows no unlock effect; stage 2 not started

Scripts in the session scratchpad (`tu/events.mjs`, `tu/study.mjs`, `tu/placebo2.mjs`). 149 events
had prices on both sides of the window.

| Window (coin − BTC) | Mean | t | Median |
|---|---|---|---|
| **τ − 14 d → τ (primary)** | **−3.17%** | **−2.87** | −3.74% |
| τ − 30 d → τ | −6.46% | −4.19 | −8.33% |
| τ → τ + 7 d | −2.54% | −2.89 | −2.56% |
| τ → τ + 14 d | −4.91% | −4.35 | −4.75% |

- By the written rule stage 1 **passes**: mean and median below 0, t −2.87, both halves negative
  (−3.88% before 2025-03-20, −2.45% after), and negative with any single coin left out (−2.79% to −3.93%).
- **The rule had no control, and that decides the reading.** It measured the coin against BTC only,
  and in 2024–26 these coins trailed BTC in *any* window. A check added after the result (not
  pre-registered): each coin's 14 days before an unlock against its 14-day return on every day of
  the same span. Excess **+1.71%, t 1.47**: before an unlock, coins did no worse than usual. ARB,
  SUI, ENA, APT and JUP unlock monthly, so "an unlock within 14 days" covers about half of all days.
  The 14 days *after* an unlock are weaker than the 14 days before (−4.91% vs −3.17%), which also
  points to a steady trend, not an event.
- Reading: there is no unlock-timed effect in our universe; what the test measured is that the
  VC-funded coins with monthly unlocks lose ground to BTC almost all the time (ENA −12% per
  14 days, ARB −5%, APT −4% on average over their spans), as part 3 found for alt baskets in general.
- Stage 2 is **not started**: the veto would act as a part-time ban on a handful of coins, with no
  measured benefit, and the bot barely trades them (see above). If the user wants it anyway, the
  stage 2 rule above still applies. Section E is complete.

## Section F: two ideas from published research (pre-registered 2026-10-27, before either was run on our data)

Both are tested where the sleeve itself was validated: `runTrendCore.mjs` (honest fills — decide on
a closed 12h bar, fill at the next open — 0.1% fee per side plus the slippage tier; closed bars
only). **Data:** Binance USDT 12h bars 2017-08-17 → 2026-08-10, fetched keyless into a scratch
directory (the USDC pairs have the 2022-09 → 2023-03 hole and start in 2020); a new
`--candle-dir` flag points the tool at it. Sharpe on 12h returns, as in `TREND_CORE_STUDY.md`.
**Reference rule ("combo"):** the sleeve's price rule as studied there — vote 30/45/60 d, slow-in
(enter 3/3, stay ≥ 2), vol target 0.6. Universes: BTC+ETH and BTC+ETH+BNB+SOL (the sleeve's).

### F1 — multi-lookback Donchian trend (Zarattini, Pagani & Barbon 2025, "Catching Crypto Trends")

- Daily closes = the closes of the 12h bars that end at 00:00 UTC; decisions once a day on them.
- Per coin and per lookback n ∈ {5, 10, 20, 30, 60, 90, 150, 250, 360} days: **enter** when the
  daily close is above the highest of the previous n daily closes; the **stop** is the higher of
  the previous stop and the midpoint of the highest and lowest of the last n daily closes
  (today's included), so it never falls; **exit** when the daily close is below the stop.
- Coin target fraction = (lookbacks open ÷ 9) × min(1, 0.25 ÷ σ), σ = annualized std of the last
  90 daily returns (×√365). The paper allows 2×; we cap at 1× (spot, no borrowing). Capital split
  equally across the universe's coins, as for combo. A trade fills at the next 12h open when the
  target differs from the holding by more than 0.05 of the coin's capital, or opens/closes it fully.
- No other lookback set, vol target or band is tried. The 0.25 target means F1 holds much less
  than combo (0.6), so its return will be lower; **Sharpe decides**.
- **Pass (stage 1):** F1's full-window Sharpe beats combo's on **both** universes, **and** F1 has
  the higher Sharpe in at least 5 of the 9 calendar years 2018–2026 (2026 to 08-10) on
  BTC+ETH+BNB+SOL. Reported, not deciding: return, worst drop, exposure, round trips, the
  deflated Sharpe (search count charged), the 8-major universe (+XRP, ADA, LTC, DOGE), and the
  unseen 2026-08-10 → 10-24.
- Expected: a Sharpe close to combo's (both are trend rules on the same coins) and a smaller worst
  drop from the lower vol target; a fail on the yearly count is likely.
- Stage 2, only on a pass: F1 as the sleeve's signal in the engine (`tsmCore`), DVOL and NASDAQ
  overlays kept, a `liveParityInventory` row, tests; judged by the six-year engine replay (Sharpe
  not below 1.9826) and the unseen window not worse.

### F2 — Coinbase premium (US spot demand) as a sleeve overlay

- **Data:** Coinbase Exchange 1h candles for BTC-USD and USDT-USD (keyless public API; USDT-USD
  starts 2021-05-04) and Binance BTCUSDT 1h. Hourly premium
  p = CB(BTC-USD) ÷ (BN(BTCUSDT) × CB(USDT-USD)) − 1, on hours where all three closed — the USDT
  term removes tether's own drift from the dollar, which the usual (unadjusted) index includes.
- **Gauge:** the mean of p over the 168 hours closed by the decision bar's close (null if fewer than
  120 are present → neutral). One market-wide gauge for every coin, like the NASDAQ overlay M1.
- **Rule CB1:** half the sleeve's target while the gauge is below 0. Applied to combo and to
  combo + M1 (factors multiply), since M1 ships. No other threshold or window is tried; the 30-day
  gauge is reported only.
- Window: the sims run on the whole history (overlay neutral before its data); metrics are taken
  on **2021-06-01 → 2026-08-10**.
- **Pass (stage 1):** combo + CB1 beats combo **and** combo + M1 + CB1 beats combo + M1 on Sharpe, on
  **both** universes, **and** combo + M1 + CB1 has the higher Sharpe in at least 3 of the 6 calendar
  years 2021 (from 06-01) – 2026 (to 08-10) on BTC+ETH+BNB+SOL. Reported, not deciding: worst drop,
  share of time the gauge is below 0, the 30-day gauge, the unseen 2026-08-10 → 10-24.
- Expected: most market-wide overlays failed here (funding, dollar, MVRV, greed); only NASDAQ
  worked. Analysts' claims are the only evidence for this one, so a fail is the likely outcome.
- Stage 2, only on a pass: a Coinbase market-data feed cached under `data/` (fail-neutral,
  payload-wins merge), read by `main.js` and the replay alike, a `liveParityInventory` row, tests;
  judged by the six-year engine replay (Sharpe not below 1.9826) and the unseen window not worse.

### Section F results (2026-10-27): F1 passes stage 1 by the smallest margins; F2 fails

Tooling: `runTrendCore.mjs` gained `--candle-dir`, `--donchian` (F1), the overlays `CB1`/`CB30` and
combined overlays (`M1+CB1`), and a per-year Sharpe; `downloadContextData.mjs --only coinbase`
builds `data/context/coinbase_premium_1h.json` (48,046 hours, 2021-05-04 → 2026-10-27). With the
new flags off, all 20 earlier cells match the previous version of the tool exactly. USDT 12h bars
(8 coins) in the session scratchpad (`sf/data/usdt12h`); BTC matches the deep set's USDT copy on
6,658 of 6,659 bars.

**F1 — Donchian ensemble vs combo, 2017-08-17 → 2026-08-10:**

| Universe | combo: Sharpe · return · worst drop | F1: Sharpe · return · worst drop |
|---|---|---|
| BTC+ETH | 1.15 · 2,102% · 51.1% | **1.16** · 220% · 17.7% |
| BTC+ETH+BNB+SOL | 1.23 · 1,958% · 44.3% | **1.28** · 199% · 14.6% |
| 8 majors (reported) | 1.19 · 1,362% · 38.0% | 1.26 · 155% · 12.1% |
| unseen 2026-08-10 → 10-24, 4 coins (reported) | **2.50** · 18.7% · 12.0% | 2.18 · 4.8% · 3.6% |

Yearly Sharpe on BTC+ETH+BNB+SOL, F1 vs combo: F1 higher in 2018 (−0.50 vs −1.62), 2020, 2021, 2022
(−1.82 vs −1.85) and 2024; combo higher in 2019, 2023, 2025 and 2026. **5 of 9: stage 1 passes as
written**, on margins that could not be smaller: 1.16 vs 1.15 on BTC+ETH, and 2022 decided by 0.03.
The unseen window went the other way. F1 holds far less (its 0.25 vol target), so its return is a
tenth of combo's; its worst drop is a third. Deflated Sharpe 0.95 on 4 coins (combo 0.93).

**Stage 2 is not started; it needs a decision first.** Two things surfaced that the written stage 2
does not settle:
- *Sizing.* "F1 as the sleeve's signal, DVOL kept" can mean F1 whole (its own 0.25 target, on DVOL)
  or F1's open-lookback count times the sleeve's 0.6 target. Only the first was tested; choosing
  the second now would be choosing after the result.
- *The $11 floor.* F1 moves a coin's target in steps of 1/9. A sleeve slot is half the account at the
  first ladder rung, so at $190 one step is about $10 × the vol factor — under the floor. At live
  equity most of F1's changes could not be placed; the replay would enforce the floor and count it.

**F2 — Coinbase premium overlay, 2021-06-01 → 2026-08-10:** the 7-day gauge was below 0 on 19% of
bars (30-day: 13%).

| Sharpe · worst drop | BTC+ETH | BTC+ETH+BNB+SOL |
|---|---|---|
| combo | **0.60** · 46.4% | **0.69** · 44.3% |
| combo + CB1 | 0.56 · 47.9% | 0.67 · 45.8% |
| combo + M1 | **0.75** · 36.8% | **0.81** · 35.7% |
| combo + M1 + CB1 | 0.71 · 38.1% | 0.80 · 37.2% |
| combo + M1 + CB30 (reported only) | 0.84 · 36.8% | 0.91 · 35.7% |

**FAIL**: CB1 lowers Sharpe in all four comparisons. (It wins 5 of the 6 years against combo + M1,
but the whole-span tests fail: the 2021 loss, 1.20 → 0.82, outweighs the rest.) Unseen window: CB1
lower too (2.42 → 2.14 on 4 coins with M1). The 30-day gauge did better, mostly in 2025–26, but it
was a reported variant; adopting it now would be choosing on this result. It could only be tested
on data after 2026-10-27. Nothing is built.

## Section G: a second web search, every idea tested (pre-registered 2026-10-27, before any of them was run on our data)

User request: "test it all out" — every idea from the second search, including the ones the search
report put aside. Nothing below has been run yet. The only data read so far is a format probe of the
Coin Metrics exchange-flow rows (two recent days and the first day of the series), with no prices.

**Common to all.** Data as in section F: Binance USDT 12h bars, 8 coins (BTC, ETH, BNB, SOL, XRP,
ADA, LTC, DOGE), in the session scratchpad. Full window 2017-08-17 → 2026-08-10; halves
2017-08-17 → 2021-12-31 and 2022-01-01 → 2026-08-10; unseen 2026-08-10 → 10-24, reported only.
Costs: 0.1% fee per side plus the slippage tier. "combo" = the sleeve's rule as in section F (vote
30/45/60 d, slow-in, vol target 0.6). Universes: BTC+ETH and BTC+ETH+BNB+SOL ("4 majors"). Daily
closes = the 12h bars that close at 00:00 UTC. Stage 2 for every idea that passes is the same as
section F's: built into the engine, a `liveParityInventory` row, tests, the $11 floor enforced,
judged by the six-year engine replay (Sharpe not below 1.9826) and the unseen window not worse.

### G1 — 10-day high / 10-day low (Padyšák & Vojtko 2022, Quantpedia)

- HIGH on day d: the daily close is the highest of the last 10 daily closes (today's included).
  LOW: the lowest of the last 10. Decided at the daily close, filled at the next 12h open, held for
  one day (the 12:00 bar makes no new decision). Only the 10-day lookback decides; 20/30/40/50 are
  reported.
- **G1a** (the paper's rule): hold the coin at full size for the next day when HIGH or LOW,
  cash otherwise. **G1b** (the low leg added to combo): combo as it is; on a day combo holds nothing
  and the coin is LOW, hold it for that day at combo's own vol-target size, min(1, max(0.2, 0.6 ÷ σ)).
- **Pass:** G1a's Sharpe above combo's on both universes in the full window **and** in the
  window the paper never saw (2022-02-04 → 2026-08-10). Separately, G1b passes on the same test.
  Reported: buy and hold, each leg alone, the other lookbacks, trade counts, unseen window.
- Expected: G1a trades almost daily and costs 0.4% a round trip; it likely fails. G1b is the real
  question: does buying weakness add anything to the trend sleeve?

### G2 — coins held on exchanges (Coin Metrics community data, keyless)

- Data: BTC `SplyExNtv` (BTC held on exchange addresses), daily; also `FlowInExNtv` − `FlowOutExNtv`.
  A day's value is used only 2 days after the day starts (it is published about 27 hours after).
- **Rule EX1:** half the sleeve's target while BTC's exchange supply is above its level 30 days
  earlier (coins moving onto exchanges). One market-wide gauge, as M1. EX7 (7-day net flow > 0 →
  half) is reported only.
- **Pass:** as F2, on the full window: combo + EX1 beats combo **and** combo + M1 + EX1 beats
  combo + M1 on Sharpe on both universes, **and** combo + M1 + EX1 has the higher Sharpe in at least
  5 of the 9 calendar years on 4 majors.
- **Caveat written before the run:** every row of the series carries a 2026 computation time, so the
  exchange address labels were applied after the fact. The backtest is not point-in-time and
  overstates any edge. Even on a pass, stage 2 starts with six months of forward data recorded
  as published, not with a build.

### G3 — day of week and 12h session

- 14 cells (weekday × the 00:00 / 12:00 bar). Log 12h returns, BTC and the 4-major equal weight.
- **Pass:** some cell's mean differs from the other 13 cells' with Welch |t| ≥ 2 in **both**
  halves, with the same sign, **and** that difference is ≥ 0.4% (one round trip) in the second
  half, on BTC. Expected: fail (no persistent effect in the 2017 and 2024 studies).

### G4 — halving clock (Quantpedia 2025/26)

Three past cycles cannot be tested. Reported only, no build either way: the 2025 top's distance
from the 2024 halving, its drop from the top, and where the low so far falls against the paper's
2026-10-05 → 11-16 bottom window. Recheck after 2026-11-16.

### G5 — attention (Wikipedia pageviews)

- Data: daily "user" pageviews of the English Wikipedia article "Bitcoin" (Wikimedia REST API,
  keyless, from 2015-07). Weeks start Monday 00:00 UTC, non-overlapping.
- A = log(this week's views) − log(the mean of the previous 12 weeks). Regression of BTC's next-week
  return on A and on BTC's own return this week (attention follows price).
- **Pass:** A's coefficient has the same sign and |t| ≥ 2 in both halves. Stage 2 on a pass:
  an overlay in the direction found, pre-registered then. Expected: fail.

### G6 — BTC leads the alts (12h)

- 7 alts. Each bar: the alts' mean next-12h return regressed on BTC's 12h return and on the
  alts' own mean 12h return.
- **Pass:** BTC's coefficient > 0 with t ≥ 2 in both halves, **and** after the top tenth of bars by
  (BTC return − alts' return), the alts' next 12h beats their average 12h by ≥ 0.4% in both halves.
  Expected: fail (the effect is at 1-minute bars).

### G7 — abnormal volume (Garfinkel, Hsiao & Hu 2025; Bianchi & Dickerson)

- The deep USDC set (37 coins, 12h, 2020-06 → 2026-08). Each Monday 00:00: AV = log(quote volume
  of the last 7 days ÷ the mean weekly quote volume of the 12 weeks before); R = the coin's last
  7-day return; y = its next 7-day return minus BTC's. Weekly cross-sectional regressions of y on
  ranks of AV, R and AV × R (Fama-MacBeth); weeks with fewer than 8 coins are skipped.
- **Pass:** AV's or AV × R's coefficient has |t| ≥ 2 and the same sign in both halves
  (2020-06 → 2022-12, 2023-01 → 2026-08). Stage 2 on a pass: a filter test on the replay's
  entries, pre-registered then (as item 4 part 4). Expected: fail; Garfinkel finds the effect
  gone wherever short selling is possible, which is true of every coin here.

### G8 — volatility breakout (Larry Williams, k = 0.5)

- Per coin and day: level = the day's open + 0.5 × the previous day's high − low. A buy-stop at
  the level: it fills on the first 12h bar of the day whose high reaches it, at the level, or at
  that bar's open if it opened above. Exit at the next day's open. Full size, equal capital per coin.
- Sharpe on daily returns (× √365) for G8, and for combo and buy and hold read from the same days.
- **Pass:** G8's Sharpe above combo's on both universes in both halves. Reported: k = 0.3 and
  0.7, a price-above-5-day-mean filter, trades, mean per trade.
- Expected: fail; the only sources are paid TradingView scripts.

### G9 — does the sleeve's own rule hang on its best month? (Arefev 2026)

- combo and the equal-weight buy and hold on both universes, full window. (a) The Sharpe with the
  best calendar month's returns removed, from each; (b) the Sharpe with the best 1% of 12h bars
  removed, from each; (c) both Sharpes on 2022-01-01 → 2026-08-10.
- **Holds** when combo beats buy and hold in (a), (b) and (c) on both universes. This tests the
  shipped sleeve; a fail does not switch anything off by itself — it goes to the user with the
  numbers.

### Section G results (2026-10-27): every new idea fails; the sleeve's own rule holds

Tooling: `runTrendCore.mjs --maxmin` (G1 cells) and overlays `EX1`/`EX7` (G2);
`downloadContextData.mjs --only flows` (`cm_btc_exchange.json`, 3,952 days) and `--only attention`
(`wiki_bitcoin.json`, 4,136 days). With the 10-day-low leg forced off, `combo+min10` matches combo
exactly on both universes. G3–G9 ran in a scratch Python script on the same data. Nothing is built.

**G1 — 10-day high / low: FAIL, by a wide margin.**

| Sharpe | full: BTC+ETH | full: 4 majors | after the paper (2022-02-04 →): BTC+ETH | 4 majors |
|---|---|---|---|---|
| combo | **1.15** | **1.23** | **0.60** | **0.65** |
| G1a high or low (10 d) | 0.46 | 0.47 | −0.48 | −0.34 |
| high leg only (reported) | 0.77 | 0.76 | −0.18 | −0.02 |
| low leg only (reported) | −0.01 | −0.03 | −0.47 | −0.51 |
| G1b combo + low leg | 0.78 | 0.83 | 0.16 | 0.20 |

The low leg loses money on its own in every window, and adding it to combo raises the worst drop
from 44% to 65% on 4 majors. The 20–50-day versions (reported) are all below combo and negative
after 2022. On data the paper never saw, its rule has a negative Sharpe. It won in the unseen
2026-08-10 → 10-24 window (2.25–2.70 vs combo 2.13–2.50), which does not change the verdict.

**G2 — exchange supply: EX1 FAILS.** It lowers Sharpe in all four comparisons (combo 1.15/1.23 →
0.95/1.04; combo + M1 1.21/1.27 → 1.00/1.04) and was on 56% of the time. The reported 7-day
net-flow variant looked better over the full window (combo + M1 + EX7: 1.29/1.32), but it was tied
after 2022 (0.79/0.74 vs 0.76/0.75) and worse in the unseen window (1.53/1.88 vs 2.07/2.42). It was
reported only, and the data is not point-in-time, so it is not adopted.

**G3 — weekday / session: FAIL.** No cell has |t| ≥ 2 in both halves with the same sign. The cells
that do reach 2 in one half reverse or vanish in the other (BTC Friday 12:00: +0.47%, t 2.1, then
−0.05%; Thursday 12:00: −0.05%, then −0.40%, t −2.6).

**G4 — halving clock (reported only).** The 2025 top (124,659 on 2025-10-07) came 535 days after the
halving, inside the paper's 525–546 — but the paper was written after that top, so this is not a
test. The lowest close since was 58,625 on 2026-07-01 (−53%, 267 days after the top), not in the
paper's 2026-10-05 → 11-16 window; BTC closed 80,151 on 2026-10-27. The bottom call misses unless a
lower close comes by 11-16.

**G5 — Wikipedia attention: FAIL.** Next-week BTC return on attention: t 1.15 (2017–21), t 0.81
(2022–26).

**G6 — BTC leads the alts at 12h: FAIL.** BTC's coefficient: −0.07 (t −1.4), then +0.03 (t 0.5).
After the top tenth of BTC-minus-alt bars, alts beat their average by +0.24% and +0.09%, under the
0.4% a round trip costs.

**G7 — abnormal volume: FAIL.** Fama-MacBeth t for AV: −0.4, then +1.5; for AV × R: −1.6, then −0.2.
The first half has a median of only 8 coins a week.

**G8 — volatility breakout: FAIL.** Daily Sharpe, k = 0.5: BTC+ETH 1.05 vs combo 1.57 (2017–21),
−1.14 vs 0.57 (2022–26); 4 majors 1.82 vs 1.74, then −1.48 vs 0.62. Every k and the filter go
negative after 2022. Mean per trade +0.01% to +0.19% after costs.

**G9 — the sleeve's rule: HOLDS on all three tests.**

| Sharpe | BTC+ETH: combo · buy and hold | 4 majors: combo · buy and hold |
|---|---|---|
| full window | 1.15 · 0.73 | 1.23 · 1.06 |
| (a) without the best month | 1.02 · 0.65 | 1.13 · 0.89 |
| (b) without the best 1% of 12h bars | −0.02 · −0.30 | 0.17 · −0.11 |
| (c) 2022-01-01 → 2026-08-10 | 0.60 · 0.25 | 0.64 · 0.31 |

Test (b) is what Arefev's warning is about. Remove the best 1% of bars and both lose nearly all
their Sharpe: the returns of either come from a few big bars. combo stays ahead of buy and hold
in every row, so the sleeve does not depend on one outlier any more than holding the coins does.
Nothing changes.

## Section H: record the untestable gauges forward (pre-registered 2026-10-27, before any forward data exists)

Three web searches (sections D–G) found no new entry signal that survives costs. Two gauges looked
good but could not be tested honestly. This section records data from now on, so they can be
judged on data nobody has seen.

**What is recorded.** The bot records it itself (`config.gaugeRecorder`, `src/data/gaugeRecorder.js`:
its own 6-hour timer, at most one snapshot per asset per 20 hours, a failure only logs, nothing
reads it for a decision), so snapshots accumulate on the live PC. `npm run record-gauges` does
the same by hand. Each run appends one snapshot per asset (BTC, ETH) to `data/context/snapshots/cm_exchange_<asset>.jsonl`: the
last 45 days of Coin Metrics `SplyExNtv`, `FlowInExNtv` and `FlowOutExNtv`, exactly as the API
returns them at that time. `src/backtester/gaugeSnapshots.js` rebuilds EX1 and EX7 (§ G2) at a
decision time from the newest snapshot recorded at or before it, never from a later one. A
snapshot older than 2 days is a gap (gauge neutral). `--report` prints the latest gauges and how
much published values changed between snapshots. The first snapshot (2026-10-27 22:15 UTC) gives
the same BTC gauges as the downloaded history for 2026-10-26.

**What is not recorded, and why.** The 30-day Coinbase premium (CB30, § F2) and perp open interest
are built from price and exchange history that is not revised, so they can be rebuilt later from
the same downloads.

**Forward check, decided now.** Window: 2026-10-28 → 2027-04-28, Binance USDT 12h bars, the
universes and costs of § G, combo + M1 as the base.
- EX7 (BTC gauge, from the snapshots) and CB30 (from prices), each as a half-size overlay on
  combo + M1.
- **Pass:** the overlay's Sharpe is above combo + M1's on **both** universes over the window.
  Six months is about 360 bars, so a pass only earns a second six-month check. It does not earn a
  build. A fail on either universe closes the gauge.
- Reported, not deciding: EX1, the share of bars each gauge is on, the number of gap days, and
  the largest revision seen between snapshots. A revision of more than 1% in `SplyExNtv` means the
  section G backtests of EX1/EX7 were biased by later relabelling.
- Before reading the window, `runTrendCore.mjs` gets a snapshot input for EX1/EX7 that calls
  `gaugesAsOf()`, checked against the downloaded history on days where both exist.

## Section I: the 10% stop rule on the scalper (pre-registered 2026-10-28, before any run)

The user's rule: no stop more than 10% below entry. The SL/TP × 1.5 change (`4b2f365`) left 15 of
the 37 traded coins above it: 14 at 10.5% (XRP, BCH, LSK, PAXG, SOL, AVAX, DOGE, INJ, WLD, PEPE,
GRAM, RENDER, ENA, ICP) and TRX at 18% (12% on master). The satellites already cap at 10%
(`maxStopPct`). User request: "I would like to know what happens when we enforce the 10%; run
tests first."

**Change measured:** every `perSymbol.*.stopLossPct` above 0.10 set to 0.10, in memory by a
preload (`--import`), config file unchanged. Targets, break-even and everything else unchanged.

**Runs, each against a reference run made the same day with no preload:**
1. Six-year replay, bot + breakout (`runSuperbot.mjs --cell bot+bo`, deep set, $190 + $10 a week,
   2020-06-01 → 2026-08-10). The reference must reproduce $6,721.65 / Sharpe 1.9826, or the set
   is wrong and nothing is reported.
2. Two-window baseline (`runBaseline.mjs`, deep set, the scalper): every window, WR gap.
3. Walk-forward at live sizing (`runWalkForward.mjs --live-sizing`, deep set).
4. Unseen 2026-08-10 → 10-24 (`runSuperbot.mjs`, live set): reference $311.97.

**Reported:** return, Sharpe, worst drop, trade count, and the worst single scalper trade (a 10%
stop can still lose more on a gap). **No pass/fail:** the rule is the user's, so the cap is the
user's decision; the runs show its cost. Expected: the 14 coins at 10.5% barely move; TRX moves
most. The TSM sleeve has no stop (it exits on a vote flip); its worst trade is reported too.

### Section I results (2026-10-28): the 10% cap costs nothing; every run is a little better

The preload capped 24 per-symbol stops, 18 of them on traded coins (the four above plus APT, ARB
and JUP, also at 10.5%; the other 6 are coins not in the symbol list). Both references reproduced
their committed figures to the cent, so the candle sets are the right ones.

| Run | Reference | 10% cap |
|---|---|---|
| Six-year replay, bot + breakout | $6,721.65 · Sharpe 1.98 · drop 8.5% | $6,735.33 · Sharpe 1.99 · drop 8.4% |
| Baseline y2_365d (in-sample) | +17.75% · Sh 1.81 · DD −3.91% | +17.81% · Sh 1.82 · DD −3.88% |
| Baseline y1_holdout | +67.83% · Sh 3.28 · DD −6.88% | +68.50% · Sh 3.31 · DD −6.78% |
| Baseline y1y2_full (OOS) | +97.62% · Sh 2.64 · DD −6.88% | +98.50% · Sh 2.67 · DD −6.78% |
| Baseline full_history | +105.22% · Sh 1.36 · DSR 0.31 | +106.14% · Sh 1.37 · DSR 0.32 |
| Walk-forward, live sizing (52 folds) | +64.99% · Sh 1.58 · DD −4.28% · DSR 0.50 | +65.45% · Sh 1.59 · DD −4.22% · DSR 0.52 |
| Unseen 2026-08-10 → 10-24 | $311.97 | $312.04 |

- Same trades: 77 scalper trades in the replay, identical entries and exit reasons; WR gap
  unchanged (Y1 74% / Y2 62%). No trade that hit 10% went on to recover before 10.5%, so the
  cap only shortens losers: five stop-outs exit earlier (DOGE −$51.12 → −$48.78, INJ −$55.62 →
  −$53.13, PEPE −$55.34 → −$52.89, two smaller). TRX (18%) had no trade in any window.
- Worst scalper stop-out, as a share of the entry price: −10.5% → −10.0%; none of the 17 gapped
  through the stop on the 15m replay. Fees and slippage add about 0.3%.
- The TSM sleeve has no stop: 10 of its 103 exits were more than 10% below the first entry
  (worst SOL 2024-07-22 → 08-05, −37% in price; the sleeve is vol-sized, so the account lost
  less). Not part of this change; left for the user.

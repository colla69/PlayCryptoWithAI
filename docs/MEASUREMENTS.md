# Measurements

This file is the one home for backtest results. Other documents quote a headline and link here.
When a change ships, rerun the baseline, replace § Current baseline, and move the old headline
to § Earlier baselines. The dated plan documents in `docs/plans/` keep the full record of each
experiment, as written at the time.

- [Current baseline](#current-baseline-2026-11-26)
  - [Scalper alone](#scalper-alone-runbaselinemjs)
  - [Whole account](#whole-account-runsuperbotmjs)
  - [Stress windows](#stress-windows)
  - [Reading it honestly](#reading-it-honestly)
- [TSM sleeve studies](#tsm-sleeve-studies)
- [What was tested and decided](#what-was-tested-and-decided)
- [Earlier baselines](#earlier-baselines)
- [How to reproduce](#how-to-reproduce)

---

## Current baseline (2026-11-26)

Code at `002ed76`. Two candle sets:

| Set | Folder | Range | Fingerprint |
|---|---|---|---|
| Six-year | `data/candles_deep_2026-08-10` | 2019-09-27 → 2026-08-10 | `130 3ffa79b2b46b` |
| Live | `data/candles` | 2024-08-05 → 2026-10-27 | `126 193218ef2949` |

The fingerprint is the file count and a sha256 over the sorted `.json` names and contents. Both
were the same before and after the runs.

### Scalper alone (`runBaseline.mjs`)

The scalper only: 37 USDC pairs, 12h candles, a $1,000 research budget and live's full filter
stack (`FULL_LIVE_FILTERS`). Fills happen at the decision bar's open, with tiered slippage (large
0.10% / mid 0.20% / micro 0.35%). Stops are replayed on 15m bars. Sharpe uses calendar days
(365). DSR charges for the optimizer's 16,280 tries.

**Six-year set:**

| Window | Days | Trades | Return | Sharpe | Sortino | Max DD | Win rate | PF | DSR | PSR |
|--------|------|--------|--------|--------|---------|--------|----------|----|----|----|
| last_90d | 90 | 8 | +0.37% | 0.28 | 0.40 | −1.40% | 63% | 1.21 | 0.00 | 0.55 |
| last_180d | 180 | 17 | +14.53% | 2.55 | 6.92 | −2.11% | 65% | 6.20 | 0.00 | 0.99 |
| y2_365d (in-sample) | 365 | 26 | +17.92% | 1.83 | 4.74 | −3.83% | 62% | 3.62 | 0.00 | 0.99 |
| y1_holdout | 365 | 35 | +69.84% | 3.38 | 8.68 | −6.56% | 74% | 4.74 | 0.22 | 1.00 |
| y1y2_full (full OOS) | 730 | 61 | +100.28% | 2.71 | 7.00 | −6.56% | 69% | 4.31 | 0.43 | 1.00 |
| full_history | 2509 | 79 | +107.98% | 1.39 | 2.99 | −7.47% | 66% | 3.35 | 0.34 | 1.00 |

**Live set:**

| Window | Days | Trades | Return | Sharpe | Sortino | Max DD | Win rate | PF | DSR | PSR |
|--------|------|--------|--------|--------|---------|--------|----------|----|----|----|
| last_90d | 90 | 6 | +11.86% | 2.21 | 6.40 | −3.73% | 33% | 4.04 | 0.00 | 0.93 |
| last_180d | 180 | 16 | +24.98% | 2.57 | 7.50 | −3.73% | 56% | 4.94 | 0.00 | 0.99 |
| y2_365d (in-sample) | 365 | 25 | +27.44% | 1.88 | 5.04 | −3.73% | 60% | 4.41 | 0.00 | 0.99 |
| y1_holdout | 365 | 33 | +65.46% | 3.27 | 9.16 | −6.56% | 67% | 3.82 | 0.17 | 1.00 |
| y1y2_full (full OOS) | 730 | 58 | +110.87% | 2.63 | 7.22 | −6.56% | 64% | 4.04 | 0.36 | 1.00 |
| full_history | 814 | 64 | +115.57% | 2.53 | 6.33 | −6.56% | 64% | 3.81 | 0.37 | 1.00 |

### Whole account (`runSuperbot.mjs`)

The live engine replayed over history with the account the bot really has: $190 at the start
plus $10 a week. It includes the scalper and the TSM sleeve (`TSM_CORE=true`, equity ladder). The
`bot+bo` cell adds the 4h breakout satellite (`SATELLITES=true` on the live bot). "In" counts
every deposit.

| Set (range) | Cell | In → out | A year | Sharpe | Worst drop | Satellite fills |
|---|---|---|---|---|---|---|
| Six-year (2020-06-01 → 2026-08-10) | bot | $3,420 → $5,692 | 18.9% | 1.87 | 6.5% | — |
| Six-year | bot+bo | $3,420 → $6,763 | 28.1% | 1.99 | 8.2% | 257 of 349 |
| Live (2024-10-01 → 2026-10-27) | bot | $1,270 → $1,652 | 30.7% | 2.18 | 8.5% | — |
| Live | bot+bo | $1,270 → $1,727 | 39.0% | 2.39 | 8.2% | 85 of 119 |

Six-month folds (return / Sharpe / worst drop):

| Fold | bot | bot+bo |
|---|---|---|
| 2020-06 | 32.4% · 3.16 · 6.2% | 39.1% · 2.97 · 6.9% |
| 2020-12 | 31.4% · 3.55 · 4.4% | 84.7% · 4.79 · 3.5% |
| 2021-06 | 2.3% · 0.92 · 2.5% | 3.8% · 1.01 · 3.8% |
| 2021-12 | −2.5% · −2.05 · 2.7% | −3.4% · −2.66 · 3.6% |
| 2022-06 | −1.2% · −0.87 · 2.8% | −1.2% · −0.87 · 2.8% |
| 2022-12 | 0.4% · 0.25 · 1.9% | −0.4% · −0.18 · 2.2% |
| 2023-06 | 2.5% · 1.04 · 1.9% | 1.0% · 0.43 · 2.2% |
| 2023-12 | 8.8% · 2.00 · 3.8% | 7.4% · 1.38 · 4.8% |
| 2024-06 | 21.3% · 3.41 · 4.7% | 25.8% · 3.08 · 5.6% |
| 2024-12 | 9.8% · 1.77 · 6.4% | 16.5% · 2.61 · 5.2% |
| 2025-06 | 8.8% · 1.77 · 3.8% | 9.7% · 1.64 · 5.6% |
| 2025-12 | 6.4% · 2.09 · 2.8% | 6.1% · 2.03 · 2.8% |
| 2026-06 | −1.2% · −3.01 · 1.6% | −1.2% · −3.02 · 1.6% |
| *Live set* | | |
| 2024-10 | 23.8% · 2.70 · 7.4% | 37.8% · 3.43 · 6.2% |
| 2025-04 | 26.3% · 3.25 · 4.7% | 29.0% · 3.18 · 5.9% |
| 2025-10 | −5.3% · −2.14 · 7.6% | −4.9% · −2.09 · 7.1% |
| 2026-04 | 20.0% · 3.06 · 3.0% | 20.2% · 3.00 · 3.7% |
| 2026-10 | −2.0% · −4.03 · 3.0% | −2.7% · −5.09 · 3.6% |

The breakout beats `bot` on return in 6 of 13 six-year folds (3 of 13 on Sharpe), and in 4 of 5
live-set folds (2 of 5 on Sharpe).

### Stress windows

`runBaseline.mjs --stoplight` adds the natural BTC-drawdown windows and gives each window a
verdict: 🔴 if the drawdown is −15% or worse or the Sharpe is under 0.8, ⚪ when there are too few
trades to judge.

| Set | Overall | 🟢 | 🔴 | ⚪ | Red window |
|---|---|---|---|---|---|
| Six-year | 🔴 RED | 9 | 1 | 22 | last_90d: Sharpe 0.28 (8 trades, +0.37%) |
| Live | 🟢 GREEN | 10 | 0 | 4 | — |

No stress window on either set draws down more than −5.4%. The worst six-year window is
btc_dd_2020-01 (1 trade, −5.37%). The scalper is mostly flat in BTC drawdowns: 0 trades in 12 of
the 26 six-year windows.

### Reading it honestly

- **Scalper:** every window is positive and no drawdown is worse than −7.5%. PSR (the chance the
  true Sharpe is above 0, ignoring the search) is 0.93–1.00, except the six-year set's last 90
  days (0.55).
- **DSR is still below 0.5 on every window:** 0.00 on the short ones, 0.17–0.43 on the long ones.
  After the charge for the optimizer's tries, the Sharpe is not distinguishable from luck.
- **Most of the scalper's return is old.** The y1_holdout year (2024-08 → 2025-08) carries
  +65–70%. The most recent year adds +18% (to 2026-08-10) or +27% (to 2026-10-27). Out of sample
  on the six-year set, before 2024-05, the same scalper made 0.7% a year (plan 2026-11, Part A).
  The edge is concentrated in the period it was tuned around.
- **The short windows have few trades.** 6–8 trades in 90 days say nothing on their own. The
  six-year set's red last_90d is one of these.
- **The whole account** returns 18.9% a year over six years with a 6.5% worst drop. Most of it
  comes from 2020–21 and 2024–25. The four folds from 2021-12 to 2023-06 stay between −2.5% and
  +2.5%.
- **The breakout satellite** adds return on both sets (+9.2 and +8.3 points a year). The largest
  gap is one fold (2020-12: 84.7% against 31.4%), and it beats `bot` in fewer than half of the
  six-year folds. Treat it as a bet on strong bull legs, not a steady edge.

---

## TSM sleeve studies

The sleeve's rules are described in [STRATEGY.md](STRATEGY.md#tsm-core-sleeve-experimental-default-off--live-capable).
The full study is [TREND_CORE_STUDY.md](TREND_CORE_STUDY.md).

- **Slow-in hysteresis** (enter on 3 of 3 votes, hold on 2): on 9 years of USDT data, including
  the 2018 and 2022 bears, the Sharpe rises 0.93 → 1.04 (BTC+ETH) against the symmetric 2-of-3
  vote, with about 3× fewer round trips.
- **Six-year window** (2020-06-27 → 2026-07-02, 4,066 candles): the vote BTC+ETH sleeve returns
  +596% / Sharpe 0.99 / DD −52%, against +582% / 0.85 / −77% for equal-weight buy-and-hold of the
  same coins. DSR 0.72, stable across 15–90d lookbacks on both universes tested. It beats
  same-universe buy-and-hold on return, Sharpe and DD from every start date tested, including the
  2021 top.
- **Universe re-validated 2026-07-29** on the 6.1-year USDC series (4,128 bars, 2020-06-22 →
  2026-07-29), vote 30/45/60 + slow-in + volTarget 0.6:

  | Universe | Return | Sharpe | Max DD | DSR | '21–22 bear DD | Exposure |
  |---|---|---|---|---|---|---|
  | BTC+ETH (rungs A and B) | +454% | 1.05 | −36.0% | 0.64 | −35.8% | 46% |
  | **BTC+ETH+BNB+SOL (rung C)** | **+543%** | **1.20** | **−33.0%** | **0.75** | **−31.1%** | 41% |

  The wider universe is better on every column at lower exposure, at 2× the round trips (104 vs
  56). Without vol targeting it draws down deeper (−49.0% vs −38.8%).
- **Equity-ladder rungs**, combined account max DD (ρ = 0.025 against the scalper): A (2 majors
  @ 0.50) −17.4%, B (2 @ 0.30) −10.1%, C (4 @ 0.20) about −7%.
- **Full combo** (vol target + NASDAQ risk-off) on the 9-year study: Sharpe 1.27, DD −36%,
  DSR 0.94.
- **Caveat:** in-sample only. 2026 YTD the sleeve is about −9% (Q1 chop). At full deployment the
  real drawdowns are −40% to −60%.
- **Buy-back rule** (`stayVotes: 3`, `rebuyConfirmBars: 40`, built, off): six-year replay Sharpe
  1.99 → 2.08, worst drop 8.2% → 6.7%. Its checks before switch-on and the monthly shadow log are
  in [the 2026-11 plan](plans/2026-11-multi-asset-trend.md).

---

## What was tested and decided

| Enhancement | Result | Decision |
|-------------|--------|----------|
| Confidence-weighted aggregator + multi-bar gate | DD nearly halved, WR up on most-OOS window | **Shipped** |
| Portfolio correlation cap (hard entry cap @ 0.85) | Better Sharpe *and* tighter DD with the new aggregator. **Re-checked 2026-09-29 at live sizing, post time-alignment fix:** the cap binds — turning it off adds ~7 trades and lifts DSR 0.22→0.27 on the forward-only walk-forward, at the cost of DD −4.00%→−4.47%. Windowed agrees on trade count but is mixed on return/DSR direction (`y2_365d` prefers the cap ON); decision made on the forward-only run per the windowed-vs-forward-only rule. Both DSR readings (0.22/0.27) are well under the 0.5 significance bar — a status-quo hold, not strong evidence either way. | **Shipped (ON)** — reverses the old "rejected" verdict; re-check did not change the call |
| Weekly DD breaker + position aging exit | DD cut further, well inside safety margin. **Re-checked 2026-09-29 at live sizing:** 0 blocks in every window (y2_365d, y1y2_full, full_history) and in the forward-only walk-forward — the breaker never actually fires at this account size/risk config, so it is currently inert rather than tested | **Shipped (ON)** — inert-but-harmless; not a revert case since it never binds |
| Cash-exit on `BEAR_TREND` (not `BEAR_CHOP`) | last_180d DD −5.9% → −2.9%, small return cost | **Shipped (trend_only)** |
| ATR-based stops | Net-negative vs tuned per-symbol fixed stops on every window | **Infra kept, disabled** |
| Two-stage exit / chandelier runner | −8pp return, −0.1 Sharpe under current tuning | **Infra kept, disabled** |
| Regime archetype routing (trend pack in bull, mean-reversion in chop) | **Refuted (2026-06, deep 6yr data):** the trend-alignment filters (4h+15m MTF) structurally block mean-reversion entries (0 trades), and MR isn't range-specialized anyway. Routing infra also has latent bugs (dead code, unregistered strategy keys). | **Not viable as-is; infra stays OFF** |
| Logistic-regression meta-overlay (P(win) gate) | Held-out gate-admitted WR 12.5% vs 39.5% base (−27pp) — does not beat baseline on 376 samples | **Trainer + gate shipped, default OFF** |
| **15m MTF relaxation 0.50 → 0.30** (deep 6yr data) | Full 15m coverage made the filter portfolio-wide; 0.50 too tight. Forward-only WF Sharpe 1.01→1.50, DSR 0.01→0.11. **Re-checked 2026-09-29 post time-alignment fix** (`runMtfSweep.mjs`, windowed; the script's `mtf_0.50 (baseline)` label is stale — its `overrides:{}` case resolves to the current shipped 0.30, not 0.50): current 0.30 gets DSR 0.17/Sharpe 2.04/DD −8.84% on `y1y2_full` and DSR 0.13/Sharpe 1.08/DD −8.84% on `full_history`. Loosening to 0.20 gets DSR 0.34/Sharpe 2.23/DD −7.29% (better) on `y1y2_full` and DSR 0.21/Sharpe 1.14/DD −10.10% (worse) on `full_history` — but `mtf_OFF` (filter fully disabled) ties `mtf_0.20` on DSR in both windows (0.34 and 0.21), so at ≤0.20 the filter is statistically indistinguishable from being off. Both DSR readings (0.34/0.21) are still under the project's 0.5 significance bar even if confirmed. | **Shipped (ON) at 0.30** — re-check flags 0.20/OFF as a possible further relaxation; not acted on in this PR, needs a forward-only + Monte Carlo check first |
| **Momentum filter** (buy only positive 10-day trailing return — no falling knives) | Forward-only WF Sharpe 1.50→1.60, DSR 0.11→0.18, WR 60→70%, PF 4.7→6.6 | **Shipped (ON)** — live + backtest via shared `utils/momentum.js` (2026-06-25) |
| "Ride winners" (kill fixed TP + lift aging, trail the stop) | Looked great windowed (+167%/6yr) but **failed forward-only** (DSR 0.02 < relaxed-MTF baseline) | **Infra kept, disabled** |
| Deployment / position-size sweep | Pure **Sharpe-neutral risk dial** — scales return *and* DD ~linearly; not an edge | **No change (informational)** |
| **Relaxing the macro bear brake** (`sizeReduceFactor` 0.5 → 0.7 → 1.0) | Tested 2026-07-29 with the min-notional floor enforced. Return rises (+17.98%→+21.73%→+27.39% full history) but **Sharpe falls monotonically** (1.38→1.32→1.24; Y2 1.17→1.13→1.08) and DD widens −3.89%→−4.99%. Trade count unchanged (30). The hypothesis that this brake was redundant with the bear cash-exit — and so removing it would *re-allocate* rather than lever up — is **refuted**: it behaves exactly like scaling `basePct`. | **Rejected — knob unchanged at 0.5** |
| **Flooring the compounded sizing brakes** (`risk.minSizeMultiplier`) | The brakes multiply and are positively correlated, so the product (median 0.47× of base over the 2026-07 soak) undershoots what any single brake intended. A 0.40× floor is a **no-op** (−0.06pp return, Sharpe unchanged) because the median already sits above it; 0.60× is a weak risk dial (+0.28pp, Sharpe −0.01). | **Infra shipped, default OFF (0)** |
| Trailing stop (replace TP) | Gives back profit on retracements | Rejected (pre-overhaul) |
| More slots (5–8) | Dilutes capital, no DD benefit | Rejected (pre-overhaul) |

> **Under-deployment in bear is the mechanism, not a defect.** Four slots deploy ~25% of capital in a
> bear tape because the macro ×0.5 does nearly all of the cutting (it fires 100% of the time BTC is
> under EMA200; ADX/ATR net out to ~1.0×, and the confidence taper is a mild 0.85×). That brake is
> also what buys the sub-4% drawdown on every window. Both attempts to reclaim the idle capital cost
> risk-adjusted return, so per the cardinal rule neither shipped. The remaining option is allocating
> that capital to a *different* sleeve (TSM core), not loosening the scalper.

---

## Earlier baselines

Newest first. Numbers in different rows are not comparable trade for trade when the fill model,
stop timing or the Sharpe convention changed in between; the note says what changed.

| Date | Code | Headline (six-year set, scalper alone, full history) | What changed before it | Write-up |
|---|---|---|---|---|
| 2026-11-26 | `002ed76` | +107.98% · Sharpe 1.39 · DD −7.47% · DSR 0.34 | 2026-10 replay and reporting corrections: fills at the decision bar's open, 15m stop replay, synchronized valuations, calendar-day Sharpe | this file |
| before 2026-10 | — | +140.7% · Sharpe 1.08 · DD −8.84% | — | git history of `docs/STRATEGY.md` |
| 2026-09 | c3 | Forward-only walk-forward, 52 folds 2021–2026: +147.3% · Sharpe 1.19 · DD −6.56% · DSR 0.20 · 75 trades | Time-alignment fix (step by timestamp, not array index). Before: +153.8% · 1.23 · −26.11% · DSR 0.26 · 81 trades. The old drawdown was an artifact of the misalignment | [fix status](plans/2026-09-backtester-fix-status.md) |

---

## How to reproduce

The raw result files are not committed. Regenerate them on the research machine, never on the
live host, with output outside `data/`:

```bash
# Scalper alone: all windows + stress stoplight (exits 1 when the stoplight is red)
PAPER_MODE=true node src/scripts/runBaseline.mjs --phase <name> --stoplight --out <file>
# Whole account through the live engine (add --cell bot for the run without the breakout)
PAPER_MODE=true TSM_CORE=true node src/scripts/runSuperbot.mjs --cell bot+bo --from <date> --to <date> --out <file>
# Folds and the whole-period line from one or more runSuperbot outputs
node src/scripts/runSuperbot.mjs --report <file>[,<file>]
```

For the six-year set, rename `data/candles` aside, rename `data/candles_deep_2026-08-10` to
`data/candles`, run, and rename both back. Check both fingerprints before and after. A paper
boot rewrites `data/candles`, so do not boot the bot during a run.

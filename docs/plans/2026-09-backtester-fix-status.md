# Backtester time-alignment fix — status and handoff (2026-09-29)

**Status: code done and reviewed; measurements complete (2026-09-29, on the MacBook).** Steps 0–5
below are done — baselines for all four commits, the live-sizing correlation-cap/weekly-DD
re-check, the old-vs-new forward-only comparison, and the optional decision-flip sweeps. Remaining:
step 6, review and ship (`backtest-reviewer`, `pre-commit-reviewer`, push, open the PR).

## What is on the branch

Base: `e6d269d` (master). `npm test`: 443 pass, 0 fail.

| Commit | What |
|---|---|
| `ba8ed41` | **fix:** `PortfolioBacktester` steps over the union of all symbols' timestamps instead of array index; BTC (regime, macro) read as of the step. Bit-identical on aligned inputs (golden fixture generated with `e6d269d`) |
| `d786b34` | **fix:** correlation cap's matrix built with live's `buildCorrelationMatrix` over each symbol's trailing `correlation.period` bars as of the step (was one static matrix from the first half of history — future bars) |
| `f399897` | **fix:** weekly DD breaker sees simulator trades (it never fired in any backtest: wrong record shape) |
| `be0a0e7` | `src/scripts/runParityRecheck.mjs` — windowed on/off re-check of those two gates |
| `0f67981` | Re-check runs at live sizing; `runWalkForward.mjs` gains `--live-sizing`, `--corr-off`, `--wdd-off` |
| `c3b4bba` | Test guarding both 15m paths (filter, early exit) against index stepping |
| `a4659a2` | Docs: three new rows in the Live ≡ Backtest table (`.claude/rules/project.md`), reviewer checklists, `tests/backtester/timeAlignment.test.js` in the testing skill, follow-ups plan |

Guard: `tests/backtester/timeAlignment.test.js`. Each test there was checked to fail on the code
before its fix; the 15m test was checked against a mutation of each 15m path separately.

`backtest-reviewer`: **PASS** on the engine. Its conditions, all addressed on the branch: run the
gate re-checks at live sizing (the weekly DD threshold is a % of equity, and the ~100% research
deployment trips it more often than live's 60%); add a Y2 window; guard the 15m paths; note the
gapped-position gap. It also ruled that **worse numbers after these commits are not a revert
trigger** — they fix the measurement, so the corrected run becomes the new baseline.

**Nothing in `config/default.js` changed.** The correlation cap and the weekly DD breaker stay ON
until the forward-only re-check below says otherwise — and changing live config is a separate
decision, not part of this PR.

Found on the way and deliberately left out (each changes every window's metrics, so each gets its
own PR): [`2026-09-backtester-parity-followups.md`](2026-09-backtester-parity-followups.md) — fills
one bar later than live, equity curve marks only one position at market, gapped positions skipped.

## Why the runs stopped

On the live PC (24 GB RAM, the bot shares it), four concurrent full-filter runs on the deep
12h + 15m data exhausted memory and Claude Code killed every background job. The bot was unaffected.
**Run backtests one at a time** unless you have measured the headroom. Timing on the live PC: one
`runBaseline` ≈ 14 min, of which `full_history` (2509 days) ≈ 8 min.

## The data snapshot

Numbers are only comparable on identical inputs, and the old-engine baseline below was measured on
this snapshot:

- USDC 12h / 4h / 15m for the 37 symbols (126 files; 12h deep history rebuilt from 4h, 2019 on),
  cut to bars ≤ `2026-08-10T23:59:59Z` — 12h ends 2026-08-10 12:00, 4h 20:00, 15m 09:00.
  ANKR 12h/15m, FTM 15m and MATIC 15m are empty (no USDC history); four USDT 12h proxy files ride
  along unused.
- Plus `data/marketContext/` (BTC-dominance samples since 2026-07 — they can feed the recent
  windows) and `data/fearGreed.json` (re-fetched after 24h; historic values do not change).
- Archive on the live PC: `~/playcrypto-btfix-snapshot-2026-08-10.tar.gz` — 74 MB,
  sha256 `bed9780d88605737e76b37edf309d2be13ba6940681a335fae2fd486f88f107b`. It also carries the
  outputs below (`bl_old.json`, `bl_old_summary.txt`, `bl_old.log`, partial `bl_c1.log`).
- Fingerprint of the candle inputs — must print
  `126 36a73a13b89372605f30c1c07ce6d9701e91ccebaa781cca752dcf962ad2f6b8`:

  ```bash
  node -e "const fs=require('fs'),c=require('crypto');const h=c.createHash('sha256');const f=fs.readdirSync('data/candles').filter(x=>/_USDC_(12h|4h|15m)\.json$/.test(x)).sort();for(const x of f)h.update(x).update(fs.readFileSync('data/candles/'+x));console.log(f.length,h.digest('hex'))"
  ```

Every run prints a stale-MTF warning ("Filter results are NOT valid for decision-making"): it
measures calendar age against today. The snapshot is frozen on purpose and its MTF data covers every
window up to its last bar, so the warning does not apply here.

## Measured so far

Snapshot above, $1000 research budget, full live filter stack, `runBaseline.mjs`. All `data/mac_*`,
`data/wf_*`, `data/parity_recheck.log` and sweep-output files referenced below are gitignored
(`data/*`) and not committed — regenerate them with the commands in "Steps 0–5" below.

**Old engine (`e6d269d`)** — complete. Its summary header reads `@ 9591a91 (dirty)` because git
metadata is read when the file is written; the engine loaded at start was `e6d269d`'s.

| Window | Trades | Return | Sharpe | Sortino | Max DD | WR | PF | DSR |
|---|---|---|---|---|---|---|---|---|
| last_90d | 8 | +0.25% | 0.14 | 0.30 | −3.28% | 25% | 1.04 | 0.00 |
| last_180d | 20 | +62.90% | 2.39 | 33.94 | −4.20% | 55% | 10.45 | 0.00 |
| y2_365d | 22 | +15.26% | 0.94 | 4.42 | −6.00% | 36% | 2.91 | 0.00 |
| y1_holdout | 39 | +102.28% | 2.99 | 21.49 | −5.20% | 79% | 7.62 | 0.16 |
| y1y2_full | 63 | +150.15% | 2.07 | 11.88 | −5.76% | 63% | 4.93 | 0.17 |
| full_history (2509d) | 87 | +185.21% | 1.06 | 4.53 | −5.52% | 60% | 4.27 | 0.08 |

**c1 (`ba8ed41`, clock fix only)** — now complete:

| Window | Trades | Return | Sharpe | Max DD | WR | DSR |
|---|---|---|---|---|---|---|
| last_90d | 8 | +0.25% | 0.14 | −3.28% | 25% | 0.00 |
| last_180d | 20 | +62.90% | 2.39 | −4.20% | 55% | 0.00 |
| y2_365d | 22 | +15.26% | 0.94 | −6.00% | 36% | 0.00 |
| y1_holdout | 39 | +97.18% | 2.69 | −5.33% | 79% | 0.07 |
| y1y2_full | 65 | +144.06% | 2.03 | −8.84% | 65% | 0.16 |
| full_history (2509d) | 86 | +154.49% | 1.11 | −8.84% | 63% | 0.16 |

As expected, the three recent windows are identical (no misaligned symbol inside them); the
longer windows move once late-listed symbols trade on their real dates.

**c2 (`d786b34`, + correlation matrix fix)** and **c3 (`f399897`, + weekly DD record-shape fix)** —
identical to each other at default (non-live) sizing, meaning the weekly DD fix doesn't change
anything at this sizing:

| Window | Trades | Return | Sharpe | Max DD | WR | DSR |
|---|---|---|---|---|---|---|
| last_90d | 8 | +0.25% | 0.14 | −3.28% | 25% | 0.00 |
| last_180d | 19 | +62.43% | 2.37 | −4.20% | 58% | 0.00 |
| y2_365d | 23 | +25.09% | 1.36 | −4.37% | 43% | 0.00 |
| y1_holdout | 34 | +91.95% | 2.72 | −5.33% | 79% | 0.08 |
| y1y2_full | 60 | +137.59% | 2.04 | −8.84% | 63% | 0.17 |
| full_history (2509d) | 81 | +140.68% | 1.08 | −8.84% | 60% | 0.13 |

`old`'s `full_history` reproduced the archived table exactly (only the git-dirty header line
differs, as expected) — confirms the snapshot inputs on the MacBook matched the live PC's.

## Step 2 — correlation cap / weekly DD re-check at live sizing

Windowed (`runParityRecheck.mjs`) and forward-only (`runWalkForward.mjs --live-sizing`,
52 folds):

- **Weekly DD breaker never fires** — 0 blocks in every window and in the forward-only run;
  `wf_live` and `wf_live --wdd-off` are numerically identical (+80.82%, Sharpe 1.20, DD −4.00%,
  75 trades, DSR 0.22). It is currently inert at this account size/risk config, not validated as
  effective.
- **Correlation cap binds** — turning it off adds trades and return: forward-only 75→82 trades,
  +80.82%→+90.34%, DSR 0.22→0.27, at the cost of DD −4.00%→−4.47%. Windowed agrees on trade count
  (23→24, 60→65, 81→86 across `y2_365d`/`y1y2_full`/`full_history`) but is mixed on return/DSR
  direction — `y2_365d` cap-OFF is worse on everything (+15.45% vs +16.77%, DD −3.76% vs −2.66%);
  `y1y2_full` cap-OFF DSR falls 0.19→0.17, opposite to the forward-only 0.22→0.27; only
  `full_history` agrees on all counts (DSR 0.14→0.18). Decided on the forward-only run per the
  windowed-vs-forward-only rule; kept ON. Both DSR readings (0.22/0.27) sit well under the 0.5
  significance bar — a status-quo hold, not strong evidence either way.

## Step 3 — forward-only, old engine vs new (default sizing, 52 folds, 2021–2026)

| | old (`e6d269d`) | new (HEAD, c3) |
|---|---|---|
| Total return | +153.77% | +147.32% |
| Sharpe | 1.23 | 1.19 |
| Max drawdown | **−26.11%** | **−6.56%** |
| Win rate | 67.9% | 64.0% |
| Trades | 81 | 75 |
| DSR | 0.26 | 0.20 |

The headline result: the old array-index stepping let late-listed symbols read BTC regime/macro
state out of chronological order, inflating max DD to −26.11% — a measurement artifact, not a real
risk difference. Return/Sharpe move little; DD corrects by ~20pp. Per `backtest-reviewer`'s ruling,
this is not a revert trigger — the old number was wrong.

## Step 4 — decision-flip sweeps on HEAD (optional, reported not acted on)

- **Bear-skip** (`runBearSkip.mjs`): 0 bars hit `BEAR_TREND` in either window on corrected data —
  skip vs. no-skip identical. Verdict holds.
- **Momentum-leader selection** (`runMomentum.mjs`): `momentum-rank` ties baseline on `y1y2_full`
  (Sharpe 2.05 vs 2.04, DSR 0.17 both — within noise); every filtered variant is worse. Verdict
  holds — no selection edge, stays disabled.
- **MTF relaxation** (`runMtfSweep.mjs`) — **flagged, not acted on:** the script's
  `'mtf_0.50 (baseline)'` variant label is stale; its `overrides:{}` resolves to the *current*
  shipped `minAlignScore: 0.30`, not 0.50. Against that real baseline, loosening further to `0.20`
  shows better risk-adjusted metrics: `y1y2_full` DSR 0.17→0.34, Sharpe 2.04→2.23, DD −8.84%→−7.29%
  (better); `full_history` DSR 0.13→0.21, Sharpe 1.08→1.14, DD −8.84%→−10.10% (worse). `mtf_OFF`
  (filter fully disabled) ties `mtf_0.20` on DSR in both windows (0.34, 0.21) — at ≤0.20 the filter
  is statistically indistinguishable from being off, and even the improved DSR (0.34) sits under
  the project's 0.5 significance bar. Windowed only — would need a forward-only + Monte Carlo check
  before any config change, and its own PR.

## Steps 0–5 — done (2026-09-29, MacBook)

Commands kept below for reproducibility; results are in "Measured so far" and steps 2–4 above.

**0. Set up the MacBook** ✅

```bash
git fetch origin && git switch fix/backtester-time-alignment && npm ci
scp <live-pc>:playcrypto-btfix-snapshot-2026-08-10.tar.gz .
mkdir -p data && tar -xzf playcrypto-btfix-snapshot-2026-08-10.tar.gz -C data
# fingerprint one-liner above → 126 36a73a13…
npm test                                   # expect 443 pass
```

Only `src/backtester/portfolioBacktester.js` differs between the commits for anything a baseline
or walk-forward loads (`runWalkForward.mjs` only gained flags). So one checkout plus swapping that
file measures any commit. Don't edit the engine while a loop below runs.

**1. Baselines per commit.** ✅ `old` first: it must reproduce the table above exactly (compare
`data/mac_bl_old_summary.txt` with the archived `data/bl_old_summary.txt`). If it does not, the
inputs differ — stop and find out why before trusting anything else.

```bash
for pair in old:e6d269d c1:ba8ed41 c2:d786b34 c3:f399897; do
  tag=${pair%%:*}; rev=${pair##*:}
  git show "$rev:src/backtester/portfolioBacktester.js" > src/backtester/portfolioBacktester.js
  PAPER_MODE=true node src/scripts/runBaseline.mjs --phase "$tag" --out "data/mac_bl_$tag.json" > "data/mac_bl_$tag.log" 2>&1
done
git checkout -- src/backtester/portfolioBacktester.js     # c3's engine is HEAD's
cat data/mac_bl_*_summary.txt
```

**2. Correlation cap and weekly DD, at live sizing.** ✅ Windowed first, then forward-only. The
reviewer's rule: no keep/drop call on windowed numbers alone.

```bash
PAPER_MODE=true node src/scripts/runParityRecheck.mjs > data/parity_recheck.log 2>&1
PAPER_MODE=true node src/scripts/runWalkForward.mjs --live-sizing --out data/wf_live.json > data/wf_live.log 2>&1
PAPER_MODE=true node src/scripts/runWalkForward.mjs --live-sizing --corr-off --out data/wf_live_corroff.json > data/wf_live_corroff.log 2>&1
PAPER_MODE=true node src/scripts/runWalkForward.mjs --live-sizing --wdd-off --out data/wf_live_wddoff.json > data/wf_live_wddoff.log 2>&1
```

**3. Forward-only, old engine vs new** ✅ (default sizing, comparable with earlier walk-forwards):

```bash
git show e6d269d:src/backtester/portfolioBacktester.js > src/backtester/portfolioBacktester.js
PAPER_MODE=true node src/scripts/runWalkForward.mjs --out data/wf_old.json > data/wf_old.log 2>&1
git checkout -- src/backtester/portfolioBacktester.js
PAPER_MODE=true node src/scripts/runWalkForward.mjs --out data/wf_new.json > data/wf_new.log 2>&1
```

**4. Optional — decisions made on the misaligned deep data.** ✅ `runBearSkip.mjs`,
`runMtfSweep.mjs` (15m relaxation 0.50 → 0.30), `runMomentum.mjs` (momentum filter), each on HEAD.
A verdict that flips is reported, not acted on in this PR. Bear-skip and momentum held; MTF
relaxation flagged (see step 4 above) — not acted on.

**5. Write up.** ✅ `docs/STRATEGY.md` "Backtested Performance" table and the README performance
lines updated to the c3 baseline, with a note on the engine change and why. "What Was Tested &
Decided": re-check notes added to the correlation cap, weekly DD, and MTF relaxation rows. This
file's status is current as of this write-up.

## Remaining

**6. Review and ship.** `backtest-reviewer` on the numbers, `pre-commit-reviewer` on the staged
diff, push, open the PR against master. Then the follow-ups plan, one PR per item.

Also noted but out of scope for this PR: `runMtfSweep.mjs`'s `'mtf_0.50 (baseline)'` variant label
is stale (see step 4) — a one-line fix, no behaviour change, candidate for its own tiny PR.

## Also open

- Branch `research/bear-side` still describes the bug as open in
  `docs/plans/2026-09-backtester-time-alignment.md`; its status line points here.
- On the live PC, the worktree `~/IdeaProjects/PlayCryptoWithAI-btfix` (holds the snapshot and
  this branch) can be removed once the archive is on the MacBook and the branch is pushed:
  `git worktree remove --force ../PlayCryptoWithAI-btfix` from the main checkout.

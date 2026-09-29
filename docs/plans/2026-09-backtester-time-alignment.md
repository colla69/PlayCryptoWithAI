# Plan: fix PortfolioBacktester's time alignment (found 2026-09-28)

**Status (2026-09-29): fixed in code, not yet measured or merged.** Branch
`fix/backtester-time-alignment` fixes it (and two more one-sided rules found on the way: a static
correlation matrix and a weekly DD breaker that never fired); its status and the remaining runs are
in `docs/plans/2026-09-backtester-fix-status.md` on that branch. Found by `backtest-reviewer` while
reviewing [`docs/BEAR_SIDE_STUDY.md`](../BEAR_SIDE_STUDY.md); verified in the code and on the live
checkout's caches.

## The bug

`PortfolioBacktester.run()` steps every symbol by **array index**, not by timestamp:
`#precomputeData` builds `allData[sym]` from each symbol's own candles (starting at its own
`MIN_WARMUP`), and the step loop reads `allData[sym]?.[step]` (`src/backtester/portfolioBacktester.js`
lines 330, 342, 369, 390, 410), while the BTC macro filter and the regime use BTC's timeline
(`slice(0, step + MIN_WARMUP + 1)`). `sliceWindow` (`baselineFramework.js`) keeps each symbol's own
candles inside the window. So a symbol whose history **starts later than BTC or has holes** is traded
against the wrong dates — its step k is a different day from BTC's step k — and the cross-sectional
gates (slots, correlation, regime, macro, weekly DD) mix bars from different times.

This is a live ≡ backtest break of a kind the table in `.claude/rules/project.md` does not list yet:
live evaluates every symbol at the same wall-clock close.

## Evidence (live checkout caches, 12h, measured 2026-09-28)

Worst misalignment vs BTC over the committed `runBaseline` windows:

| Window | Misaligned symbols (of 37) |
|---|---|
| last_90d | 0 |
| last_180d | 0 |
| y2_365d | 1 — LSK 50d |
| y1y2_full (730d) | 6 — ACH 206d, GMX 170d, LSK 416d, PAXG 198d, THETA 186d, VANRY 172d |
| full_history | 8 — TRX 30d, ACH 260d, GMX 225d, LSK 470d, PAXG 253d, THETA 241d, VANRY 227d, TON 17d |
| deep 2020 → 2026 (rebuilt 12h) | 34 — all but BTC, ETH, BNB; at BTC-time 2021-01-01 the engine trades NEAR's 2024-07-13 bar, and by 2024 26 symbols have run out of data |

## What it affects

- Every portfolio result on windows longer than ~1 year, and **every deep-data study** — the
  committed baseline's `y1y2_full` / `full_history` rows, and the decisions validated on
  `rebuildDeepHistory` data: the 15m MTF relaxation 0.50 → 0.30, the momentum filter, the
  ride-winners rejection, regime archetype routing, the macro-brake relaxation, the sizing-brake
  floor, and `runWalkForward` folds on deep data.
- **Not** affected: `runTrendCore.mjs` and `runBearSide.mjs` sleeves (their own grid-aligned
  simulators), and last_90d / last_180d windows.

## Fix (engine, not per study)

1. Step over the union of all symbols' timestamps (or the BTC grid). Per step, look up each symbol's
   precomputed row **by timestamp**; a symbol with no bar at that time neither enters nor is marked
   stale-priced — it simply has no signal that step.
2. Keep each symbol's warmup per symbol; regime and macro read BTC at the same timestamp.
3. Parity fixture: a two-symbol run where one symbol starts N bars later must give that symbol the
   same decisions, entries and exits as a run where both start together (the shape of every break
   in the Live ≡ Backtest table: a rule true on one side only). Add the row to
   `tests/backtester/liveParityInventory.test.js` if it models a live rule.
4. Re-baseline (`runBaseline`, `runWalkForward`) and re-run the affected decisions above. Per the
   revert-don't-patch rule, anything that no longer beats the corrected baseline is reverted.
5. Add the break to the Live ≡ Backtest table in `.claude/rules/project.md` with its guard.

Scope: its own branch and PR; `backtest-reviewer` + `pre-commit-reviewer` before merge. Research
runs go in a separate worktree (`data/` there is not the live bot's).

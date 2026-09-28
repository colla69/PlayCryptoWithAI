---
description: Review staged or recently changed files for correctness and regression risk before committing
argument-hint: (optional) point to specific files or describe the change
---

Review the staged or most recently changed files in this repository. $ARGUMENTS

For each change:
1. Confirm it does what its description says, with no silent side effects.
2. Run `node --check` on modified `.js`/`.mjs` files.
3. Check the diff against "What the breaks look like in a diff" under Live ≡ Backtest in
   `project.md`, and against the project invariants (`CLAUDE.md` non-negotiables, `project.md`
   Architecture Rules): ES modules only (no `require()`), no lookahead, `dashboardState.js` sole
   writer, append-only dashboard contracts, smoke-test tag, no hard-coded secrets.
4. If signal logic changed, confirm the aggregator still matches across live, backtester and
   optimizer (`aggregatorVoting.js`).

Output: findings with severity (🔴 blocker / 🟡 warning / 🔵 note) and `file:line`, then a final
`✅ Safe to commit` or `🔴 Blocked` verdict.

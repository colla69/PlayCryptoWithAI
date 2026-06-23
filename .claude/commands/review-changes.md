---
description: Review staged or recently changed files for correctness and regression risk before committing
argument-hint: (optional) point to specific files or describe the change
---

Review the staged or most recently changed files in this repository. $ARGUMENTS

For each change:
1. Confirm the change does what its description says.
2. Run `node --check` on any modified `.js` files.
3. Check for: ES module usage, no `require()`, no hard-coded secrets, no lookahead in strategy logic.
4. Confirm dashboard state writes still route through `dashboardState.js`.
5. Confirm aggregator parity (live ≡ backtester ≡ optimizer) if signal logic changed.
6. Confirm smoke-test tag (`note: '🔬 smoke-test'`) is still present.

Output: findings with severity (🔴 blocker / 🟡 warning / 🔵 note), then a final
"✅ Safe to commit" or "🔴 Blocked" verdict. Keep under 300 words unless a blocker needs detail.

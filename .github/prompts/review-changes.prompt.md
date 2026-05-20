---
description: 'Review staged changes for correctness and regression risk before committing'
mode: agent
tools: ["read", "search", "execute"]
---

Review the staged or most recently changed files in this repository.

For each change:
1. Confirm the change does what its description says.
2. Run `node --check` on any modified `.js` files.
3. Check for: ES module usage, no `require()`, no hard-coded secrets, no lookahead in strategy logic.
4. Confirm dashboard state writes still route through `dashboardState.js`.
5. Confirm smoke-test tag (`note: '🔬 smoke-test'`) is still present.

Output: list of findings with severity (🔴 blocker / 🟡 warning / 🔵 note), then a final "✅ Safe to commit" or "🔴 Blocked" verdict.

Keep total output under 300 words unless a blocker requires full explanation.

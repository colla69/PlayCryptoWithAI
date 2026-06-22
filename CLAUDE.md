# playAIStocks — Claude Code project rules

The authoritative project rules live in `.github/` (shared with the GitHub Copilot setup).
They are imported below so a single edit keeps both toolchains in sync.

@.github/copilot-instructions.md
@.github/instructions/nodejs.instructions.md

Dashboard-specific rules load automatically from `src/dashboard/CLAUDE.md` and `public/CLAUDE.md`
when working in those trees. Commit-message rules: `@.github/git-commit-instructions.md`.

## Non-negotiables (restated so they are never missed)

- **Aggregator parity:** `src/engine/signalAggregator.js` ≡ `PortfolioBacktester` ≡
  `perSymbolOptimizer.aggregate()`. Change all three together; the shared math lives in
  `src/engine/aggregatorVoting.js`. `tests/engine/aggregatorParity.test.js` must stay green.
- **Dashboard contracts are append-only.** Never rename or remove a CSV column, JSON key, or SSE
  event — only add. `src/dashboard/dashboardState.js` is the sole writer of persisted state.
- **No lookahead.** Strategy/signal logic uses closed candles only (`candles.slice(0, -1)`).
- **No secrets in code.** Keys come from `.env` only. Keep `note: '🔬 smoke-test'` tags.
- **Revert, don't patch:** any change that worsens risk-adjusted metrics vs the committed baseline
  gets reverted, not band-aided. Robustness > sunk cost.

## Validate every change (in order)

```bash
node --check <changed files>
node --test 'tests/**/*.test.js'                 # expect ≥162 pass, parity fixture green
SMOKE_TEST=false PAPER_MODE=true DASHBOARD_PORT=<free> WEBHOOK_PORT=<free> node src/main.js  # boot, then kill
PAPER_MODE=true node src/scripts/runBaseline.mjs --phase <p>     # metrics vs baseline (strategy/risk changes)
```

## Token & cost discipline

The "Token Efficiency Rules" in the imported `copilot-instructions.md` apply to every session and
subagent: be concise, batch file reads, suppress verbose command output (grep for the result line),
don't re-read seen files, skip preamble. Subagents are cost-routed by `model:` in their frontmatter —
prefer the cheapest agent that fits the task; reserve heavier models for genuine judgment calls.

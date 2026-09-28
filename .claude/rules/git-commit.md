# Git Commit Instructions

Write commit messages following these rules:

1. **Language**: English
2. **Format**: `<type>(<scope>): <short description>` — scope optional
   - `feat` — new feature or capability
   - `fix` — bug fix
   - `perf` — performance improvement
   - `refactor` — code change with no behaviour change
   - `chore` — maintenance, dependencies, config
   - `docs` — documentation only
3. **Description**:
   - Short (≤72 chars), imperative mood ("Add X", not "Added X" or "Adds X")
   - No trailing period
   - Scope is the affected module or directory: `dashboard`, `strategy`, `risk`, `main`, `config`, `backtester`, `agents`
4. **Body** (optional): 1–3 lines explaining *why*, not *what*, when the change is non-obvious
5. No secrets, API keys, or credentials in commit messages
6. **Trailer**: end with the attribution lines Claude Code supplies for the session. Don't
   hard-code a model name — it goes stale at the next model release.

## Examples

```
feat(strategy): add CCI strategy to signal aggregator
fix(dashboard): show win-rate from trade history instead of trader state
perf(main): reduce price poll interval to 5s for open positions
chore: update ccxt to latest patch release
```

With a body:

```
fix(dashboard): derive win-rate from trade history instead of trader state

Trader state resets on restart, giving 0% win rate after a reboot.
History is persisted and survives restarts.
```

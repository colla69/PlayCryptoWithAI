# Git Commit Instructions

Write commit messages following these rules:

1. **Language**: English
2. **Format**: `<type>: <short description>`
   - `feat` — new feature or capability
   - `fix` — bug fix
   - `perf` — performance improvement
   - `refactor` — code change with no behaviour change
   - `chore` — maintenance, dependencies, config
   - `docs` — documentation only
3. **Description**:
   - Short (≤72 chars), imperative mood ("Add X", not "Added X" or "Adds X")
   - No trailing period
   - Reference the affected area when useful: `fix(dashboard): correct win-rate calculation`
4. **Body** (optional): explain *why*, not *what*, when the change is non-obvious
5. **Never** include secrets, API keys, or credentials in commit messages

## Co-authored-by trailer

Always append:
```
Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

## Examples

```
feat(strategy): add CCI strategy to signal aggregator
fix(dashboard): show win-rate from trade history instead of trader state
perf(main): reduce price poll interval to 5s for open positions
chore: update ccxt to latest patch release
```

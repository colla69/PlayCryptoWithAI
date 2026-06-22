---
description: Write a conventional commit message for staged or described changes
argument-hint: (optional) describe the change if there is no staged diff
---

Write a git commit message for the staged changes (or the described change if no diff is available).
$ARGUMENTS

Rules:
- Format: `<type>(<scope>): <short description>` (≤72 chars, imperative mood, no trailing period)
- Types: `feat`, `fix`, `perf`, `refactor`, `chore`, `docs`
- Scope: affected module or directory (e.g. `dashboard`, `strategy`, `risk`, `main`, `config`, `backtester`)
- Body (optional): 1–3 lines explaining *why*, not *what*, if the change is non-obvious
- Never include secrets, API keys, or credentials
- End with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

Output only the commit message, no explanation.

Example:
```
fix(dashboard): derive win-rate from trade history instead of trader state

Trader state resets on restart, giving 0% win rate after a reboot.
History is persisted and survives restarts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

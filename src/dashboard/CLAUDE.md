# Dashboard rules (src/dashboard/)

@../../.claude/rules/dashboard.md

Reminder: `dashboardState.js` is the **sole writer** of persisted dashboard state
(`dashboard_persist.json`). All CSV/JSON/SSE contracts are append-only — add keys, never rename
or remove. Caps: max 100 trades, 50 signals.

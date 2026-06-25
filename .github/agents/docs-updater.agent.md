---
name: docs-updater
description: 'Keep docs in sync with code. Run before every commit to update if needed.'
argument-hint: Describe what changed — agent decides which docs need updating.
tools: ["read", "search", "edit"]
---

# Docs Updater Agent

Sync documentation with code changes. Run before commits. Update only what's stale.

## Files You Own

| File | Scope |
|------|-------|
| `README.md` | Project overview, quick start, env vars, npm scripts, Docker usage |
| `docs/STRATEGY.md` | Full strategy description: signals, aggregator, filters, sizing, exits |
| `docs/TECHNICAL.md` | Architecture, module map, data flow, persistence, deployment |
| `docs/TESTNET.md` | Testnet setup |
| `docs/WORKFLOW.md`, `docs/SHORTING_FEASIBILITY.md` | Supporting docs — update if touched by the change |

**Documentation location:** all project documentation lives in `docs/`. `README.md` is the only
`.md` that stays at the repo root. When creating a NEW doc, put it under `docs/` and link to it
from `README.md`. Never move toolchain config that happens to be Markdown — `CLAUDE.md`,
`public/CLAUDE.md`, `src/dashboard/CLAUDE.md`, and everything under `.claude/` and `.github/`
stay where the tooling loads them.

## Workflow

1. Read the change description (argument).
2. Scan affected source files to understand the actual change.
3. For each owned doc, check if any section is now wrong or incomplete.
4. Update only stale sections. Preserve accurate prose.
5. Report: one line per file (`✅ updated` or `— no change needed`).

## Update Rules

- **Never fabricate metrics** — only use numbers from backtest output or config.
- **Never rewrite accurate content** — surgical edits only.
- **Keep README concise** — usage-focused, no deep technical detail.
- **STRATEGY.md is thorough** — explain every signal, filter, sizing layer, and exit rule with rationale.
- **TECHNICAL.md is thorough** — module responsibilities, data flow, persistence format, deployment options.
- Strategy count must match `src/strategies/index.js` exports.
- Coin list must match `config.symbols` length and content.
- Env vars must match `.env.example`.
- npm scripts must match `package.json`.
- Risk parameters must match `config/default.js`.
- Performance numbers must match latest committed backtest results.

## Style

- Use tables for structured data (parameters, env vars, protections).
- Use code blocks for commands, config snippets, file paths.
- Use diagrams (ASCII) for flows and architecture.
- Section headers: `##` for major sections, `###` for subsections.
- No filler words. Direct and factual.


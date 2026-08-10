# Agentic Development Workflow

This project is developed with **Claude Code**. Agents live in `.claude/agents/`, skills in
`.claude/skills/`, slash commands in `.claude/commands/`, and the shared rule files in
`.claude/rules/` (imported by `CLAUDE.md`).

> **Single-copy rule.** Until 2026-07-29 every agent, skill and prompt was mirrored into `.github/`
> for GitHub Copilot. The mirror drifted — its pre-commit reviewer still demanded `MIN_TRADES ≥ 3`
> where the optimizer and the instructions both said 8 — so it was removed. Do not reintroduce it.
> A rule that exists on one side only is this project's most expensive recurring bug.

---

## The Cast

### Agents

| Agent | Role | When to use |
|---|---|---|
| `@analyst` | Breaks down a feature idea: affected modules, risk, delivery slices | Before writing a single line — when the scope is fuzzy |
| `@developer` | Implements an approved change end-to-end | When the design is clear and concrete |
| `@strategy-designer` | Creates or tunes signal strategies in `src/strategies/` | Any new indicator or combo change |
| `@pre-commit-reviewer` | Lightweight staged-diff check before committing | Always, automatically offered by developer |
| `@reviewer` | General code review: correctness, conventions, logic | After a PR is open |
| `@risk-reviewer` | Reviews risk-management logic only | Any change to SL/TP/sizing/filters |
| `@security-reviewer` | Reviews API keys, order paths, secrets handling | Any change near `binanceClient.js` or `.env` |
| `@project-reviewer` | Full holistic audit of the whole codebase | Periodically, or before switching to live trading |
| `@docs-updater` | Keeps README, `.claude/rules/project.md`, and config comments in sync | After every merged feature |

### Skills

Skills are domain-specific knowledge packs that agents load on demand. They encode conventions, contracts, and checklists so the agent doesn't have to rediscover them.

| Skill | Loaded by | Covers |
|---|---|---|
| `trading-strategy` | `@strategy-designer`, `@developer` | Strategy contract, no-lookahead rule, aggregator wiring |
| `risk-management` | `@developer`, `@risk-reviewer` | Stop-loss, take-profit, sizing, daily limits |
| `security` | `@developer`, `@security-reviewer` | API key handling, order execution safety |
| `clean-code` | `@developer`, `@reviewer` | Module cohesion, helper extraction, readability |
| `testing` | `@developer`, `@tester` | `node:test` suite layout, the invariant fixtures, manual validation steps |

---

## Standard Workflows

### 1 — New Feature (typical path)

```
You  →  @analyst   "I want to add X"
         ↓ scope, modules affected, risks, delivery slices
You  →  @developer  "Implement slice 1: …"
         ↓ writes code, runs node --check, paper mode smoke test
         ↓ offers handoff →  @pre-commit-reviewer  (auto-suggested)
                         →  @docs-updater          (auto-suggested)
You  →  git push
```

### 2 — New Trading Strategy

```
You  →  @strategy-designer  "Design a VWAP mean-reversion strategy"
         ↓ creates src/strategies/vwap.js
         ↓ registers in src/strategies/index.js
         ↓ adds config block in config/default.js
         ↓ runs node --check + portfolio backtest
         ↓ reports: evidence, Sharpe delta, any regression
You  →  @docs-updater  "Strategy count changed, update README"
```

### 3 — Risk Parameter Change

```
You  →  @developer   "Change break-even trigger from 5% to 7%"
         ↓ edits config/default.js
         ↓ offers handoff →  @risk-reviewer
You  →  @risk-reviewer  (confirm)
         ↓ checks SL/TP interaction, sizing chain, no silent override
You  →  @pre-commit-reviewer → commit
```

### 3b — Live / Backtest Disagreement

```
Symptom: live logged a different confidence, block reason, or decision than a
         backtest of the same bar, on the same on-disk candles.

You  →  @developer  "Live scored TIA 0.18, the backtester entered. Find the divergence."
         ↓ 1. confirm the DATA is identical (diff data/candles vs what live used)
         ↓ 2. if identical, suspect the IN-MEMORY path, not the data:
         ↓      · dashboardState.updateCandles merge (payload must win)
         ↓      · a threshold read raw instead of scaleMinConfidence()
         ↓      · cycle firing off candle close (different MTF/regime inputs)
         ↓ 3. reproduce both code paths side by side on the same slice
         ↓ 4. lock the result in as a parity fixture, not a one-off assertion
You  →  @pre-commit-reviewer → commit
```

All three of those have actually happened, each invisible for weeks. See "Live ≡ Backtest"
in `.claude/rules/project.md`.

### 4 — Periodic Health Check

```
You  →  @project-reviewer
         ↓ full audit: architecture, risk controls, security, dashboard
         ↓ surfaces issues with priority (critical / warning / advisory)
You  →  create issues or handle inline
```

### 5 — Going Live (PAPER_MODE=false)

```
You  →  @security-reviewer  "Review all paths before enabling live trading"
         ↓ audits binanceClient.js, liveTrader.js, .env handling
You  →  @risk-reviewer  "Final risk parameter audit"
         ↓ checks daily loss limit, position sizing, SL/TP
You  →  update .env.live  →  docker compose up -d
```

---

## CI

There is **no CI in this repo** — `.github/workflows/` does not exist. (Earlier revisions of this
document described `copilot-setup-steps.yml` and `docs-sync.yml`; neither was ever present.)
Validation is local and mandatory before every commit:

```bash
node --check <changed files>
npm test                                  # ≥421 pass, parity fixtures green
SMOKE_TEST=false PAPER_MODE=true node src/main.js        # boot, then kill
PAPER_MODE=true node src/scripts/runBaseline.mjs         # strategy/risk changes only
```

---

## Agent Handoff Map

```
@analyst
    └─▶ @developer
            ├─▶ @pre-commit-reviewer   (always, before commit)
            ├─▶ @docs-updater          (after commit)
            ├─▶ @risk-reviewer         (if SL/TP/sizing touched)
            └─▶ @security-reviewer     (if API / order path touched)

@strategy-designer
    └─▶ @pre-commit-reviewer
    └─▶ @docs-updater

@project-reviewer                      (standalone, no handoffs)
```

---

## Key Conventions Enforced by Agents

- **No lookahead** — strategies never use the forming candle (`candles[length-1]` is live)
- **Full filter stack in backtests** — every backtest must enable 15m MTF, 4h momentum, regime sizing, macro, and confidence filters; partial-filter results are invalid
- **Backtest before enabling** — every new filter or strategy must show a net improvement at portfolio level, not just per-symbol
- **PAPER_MODE=true default** — all Docker and dev configs default to paper mode
- **Secrets never committed** — `.env` and `.env.live` are in `.gitignore`; agents refuse to hardcode credentials
- **Validate at portfolio level** — per-symbol optimizer results are misleading due to slot competition; always run `portfolioBacktest.mjs` to confirm
- **Filtered optimizer gate** — new coins must pass the full filter stack in `data/filtered_optimization_results.json` (9 pass / 5 fail from latest 14-coin evaluation)

---

## Adding a New Agent

1. Create `.claude/agents/<name>.md` with a YAML front-matter block:
   ```yaml
   ---
   name: my-agent
   description: 'One sentence — when to use this agent.'
   argument-hint: What context to provide when invoking.
   tools: Read, Grep, Glob, Bash        # least privilege — omit Edit/Write for reviewers
   model: opus                          # see "Model routing" below
   ---
   ```
2. Write the agent's mission, method, and output contract in the body.
3. Reference it from any agent that should hand off to it.
4. Add it to the table in this file.

---

## Model routing

Agents are cost-routed by `model:` in their frontmatter. The rule is **not** "cheapest that fits" —
it is *cheapest that fits the blast radius*:

| Model | Use for | Agents |
|---|---|---|
| `opus` | Anything guarding capital, credentials or statistical validity — where a miss is expensive and silent | `pre-commit-reviewer`, `risk-reviewer`, `security-reviewer`, `backtest-reviewer`, `project-reviewer`, `strategy-designer` |
| `sonnet` | Implementation and scoping, where mistakes surface fast in tests | `developer`, `analyst`, `tester`, `reviewer` |
| `haiku` | Mechanical, verifiable edits | `docs-updater` |

`pre-commit-reviewer` was on `haiku` and is the last gate before the order path. The four parity
breaks found in the 2026-07 audit were all one-sided rules — precisely what a cheap reviewer skims
past. Upgrading it is the single highest-leverage routing change in this repo.

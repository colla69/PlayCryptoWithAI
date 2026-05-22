# Agentic Development Workflow

This project uses GitHub Copilot's agentic coding system to develop, review, and maintain the trading bot.
All agents are defined in `.github/agents/` and are invoked from the Copilot chat interface (`@agent-name`).

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
| `@docs-updater` | Keeps README, copilot-instructions, and config comments in sync | After every merged feature |

### Skills

Skills are domain-specific knowledge packs that agents load on demand. They encode conventions, contracts, and checklists so the agent doesn't have to rediscover them.

| Skill | Loaded by | Covers |
|---|---|---|
| `trading-strategy` | `@strategy-designer`, `@developer` | Strategy contract, no-lookahead rule, aggregator wiring |
| `risk-management` | `@developer`, `@risk-reviewer` | Stop-loss, take-profit, sizing, daily limits |
| `security` | `@developer`, `@security-reviewer` | API key handling, order execution safety |
| `clean-code` | `@developer`, `@reviewer` | Module cohesion, helper extraction, readability |
| `testing` | `@developer` | Unit test patterns, manual validation steps |

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
         ↓ CI: docs-sync.yml warns if README wasn't updated
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

## CI Workflows

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| Copilot Setup Steps | `copilot-setup-steps.yml` | push to workflow file | Validates Node setup + syntax for Copilot cloud agent |
| Docs Sync Check | `docs-sync.yml` | push/PR touching `src/`, `config/`, infra | Warns when code changed but README wasn't updated |

Both workflows are **advisory** — they warn but do not block merges.

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
- **Backtest before enabling** — every new filter or strategy must show a net improvement at portfolio level, not just per-symbol
- **PAPER_MODE=true default** — all Docker and dev configs default to paper mode
- **Secrets never committed** — `.env` and `.env.live` are in `.gitignore`; agents refuse to hardcode credentials
- **Validate at portfolio level** — per-symbol optimizer results are misleading due to slot competition; always run `portfolioBacktest.mjs` to confirm

---

## Adding a New Agent

1. Create `.github/agents/<name>.agent.md` with a YAML front-matter block:
   ```yaml
   ---
   name: my-agent
   description: 'One sentence — when to use this agent.'
   argument-hint: What context to provide when invoking.
   tools: ["read", "search", "edit", "execute"]
   agents: ["pre-commit-reviewer"]   # optional handoff targets
   handoffs:
     - label: Review
       agent: pre-commit-reviewer
       prompt: Review the staged changes.
       send: false
   ---
   ```
2. Write the agent's mission, method, and output contract in the body.
3. Reference it from any agent that should hand off to it.
4. Add it to the table in this file.

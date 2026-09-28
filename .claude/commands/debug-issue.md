---
description: Debug a live or backtested issue with the trading bot
argument-hint: Describe the issue (symptom, when it happens, paper/live/backtest)
---

Find the root cause of the described issue in the trading bot and fix it.

Where to look:
- Logs are daily files: `logs/app-YYYY-MM-DD.log` (JSON lines) and `logs/error-YYYY-MM-DD.log`.
  The live bot runs in Docker as `playcrypto-bot`; `docker logs playcrypto-bot` has its console
  output, and `./data` and `./logs` are bind-mounted from this checkout.
- Reproduce it: identify the affected module and data flow; if the logs don't show enough, add
  targeted `logger.debug` output.
- Classify the fault as data (candle cache, freshness), signal (strategy, aggregator, threshold),
  execution (paperTrader/liveTrader, exchange limits) or state (dashboardState, persistence,
  restore).
- If live and a backtest disagree, confirm the on-disk data is identical first, then suspect the
  in-memory path — the Live ≡ Backtest table in `project.md` lists how that has broken before.

Fix the root cause with the smallest change, add a test that would have caught it (referencing
the incident in its docstring), then run `node --check` on changed files and `npm test`.

Report the root cause with the `file:line` evidence, the fix, and any follow-up risk.

Issue: $ARGUMENTS

---
description: 'Debug a live or backtested issue with the trading bot'
mode: agent
tools: ["read", "search", "execute"]
---

Investigate and fix the described issue in the trading bot.

Steps:
1. Reproduce the issue by identifying affected module and data flow.
2. Add targeted `logger.debug` output or read existing logs in `logs/app.log`.
3. Identify root cause: is it in data (candle cache), signal (strategy/aggregator), execution (paperTrader/liveTrader), or state (dashboardState)?
4. Propose and apply a minimal fix.
5. Syntax-check the fix with `node --check`.
6. Describe the root cause, fix applied, and any follow-up risks.

Describe the issue: $issue

---
name: security
description: >-
  Skill for security-sensitive changes: API credentials, order execution, environment variables,
  log hygiene, and anything that touches real money or the Binance exchange API.
---

# Security Skill

## What This Skill Covers

- API key and secret handling
- Environment variable practices
- Order execution guards
- Log hygiene (no sensitive data in logs)
- File commit hygiene (no secrets in git)

## Non-Negotiable Rules

1. **Secrets in environment variables only** — `process.env.BINANCE_API_KEY` / `process.env.BINANCE_API_SECRET`. Never hard-code in source or config files.
2. **`.env` must never be committed** — verify `.gitignore` contains `.env`.
3. **No secrets in logs** — never pass `apiKey`, `secret`, or `password` to any logger call.
4. **Paper/testnet guard before real orders** — check `PAPER_MODE` and `BINANCE_TESTNET` before calling any order-placement method.
5. **Order amount validation** — validate that computed order size is ≥ `minPositionUsd` and ≤ `maxPositionPct * balance` before sending to exchange.
6. **Smoke-test guard** — smoke-test trades must be tagged `note: '🔬 smoke-test'` and must not affect live risk state or daily loss accounting.

## API Credential Checklist

- [ ] `process.env.BINANCE_API_KEY` and `process.env.BINANCE_API_SECRET` are the only sources
- [ ] No fallback hard-coded key
- [ ] `src/exchange/binanceClient.js` is the only module that reads these variables
- [ ] `.gitignore` includes `.env`, `*.key`, `*.pem`

## Order Execution Checklist

- [ ] `PAPER_MODE === 'true'` check before any real order
- [ ] `BINANCE_TESTNET === 'true'` routes to `testnet.binance.vision` only
- [ ] Order size ≥ `minPositionUsd` before placement
- [ ] Order size ≤ `maxPositionPct * accountBalance` before placement
- [ ] Exchange errors are caught and logged without rethrowing credentials

## Log Hygiene

```js
// ✅ Safe
logger.error(`Order failed: ${err.message}`);

// ❌ Dangerous — never log credentials
logger.info({ apiKey: process.env.BINANCE_API_KEY });
logger.debug(`Auth: ${config.apiKey}`);
```

## File Commit Hygiene

Run before every commit:
```bash
git diff --cached --name-only | grep -E '\.(.env|key|pem|secret)$'
```
If any file matches, abort the commit.

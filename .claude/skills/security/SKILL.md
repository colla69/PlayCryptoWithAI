---
name: security
description: >-
  Skill for security-sensitive changes: API credentials, order execution, environment variables,
  log hygiene, and anything that touches real money or the Binance exchange API.
---

# Security Skill

## The signal bus is an order path

External signals (webhook/telegram/twitter) become votes in the live aggregator, and open positions
exit at a lowered 0.7× threshold, so injected SELLs can force a position dump. Any endpoint that
can emit onto `signalBus` requires authentication — the webhook demands `WEBHOOK_TOKEN`
(constant-time compare, `x-webhook-token` header), is off by default, and refuses to start without
the token. Treat a new signal source with the same severity as a `binanceClient.js` change.

## Rules

1. **Credentials come from env vars only** — `BINANCE_API_KEY` / `BINANCE_API_SECRET` via `.env`.
   Never hard-coded in source or config files, and no hard-coded fallback key. Only
   `src/exchange/binanceClient.js` passes them to the exchange client; other modules may test
   whether they are set (mode detection), never read the values into anything else.
2. **`.env` files stay out of git** — `.gitignore` covers `.env`, `.env.local`, `.env.*.local`,
   `.env.live`. A new secrets file gets a `.gitignore` entry in the same change.
3. **No secrets in logs** — never pass keys, secrets, passwords or tokens to a logger call, error
   message or dashboard payload. Exchange errors are caught and logged by `err.message`, never
   rethrown or logged with credentials attached.
4. **Mode before money** — `paperMode` / `testnetMode` (resolved once in `binanceClient.js`) decide
   before any order path runs; testnet mode rewrites every API URL group to `testnet.binance.vision`.
5. **Validate orders before submission** — size within `risk.maxPositionPct` of free balance and at
   or above the exchange floor from `src/exchange/exchangeLimits.js`.
6. **Smoke-test trades** are tagged `note: '🔬 smoke-test'` and never affect live risk state or
   daily-loss accounting.

```js
// ✅ Safe
logger.error(`Order failed: ${err.message}`);

// ❌ Never — credentials in logs
logger.info({ apiKey: process.env.BINANCE_API_KEY });
logger.debug(`Auth: ${config.apiKey}`);
```

## Before committing

```bash
git diff --cached --name-only | grep -E '(^|/)\.env|\.(key|pem|secret)$'   # must print nothing
```

If it prints anything, abort the commit.

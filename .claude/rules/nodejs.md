---
applyTo: "**/*.js"
---

# Node.js / ES Module Instructions

These rules apply to all `.js` files in this repository.

## Module System

- This project uses **ES modules** (`"type": "module"` in `package.json`).
- Always use `import` / `export`. Never use `require()` or `module.exports`.
- Use named exports; default exports only for the main class/function of a module.

```js
// ✅ Correct
import { createBinanceClient } from './exchange/binanceClient.js';
export function myHelper() { … }

// ❌ Wrong
const { createBinanceClient } = require('./exchange/binanceClient.js');
module.exports = { myHelper };
```

## File Extensions

- Always include `.js` in import paths: `import x from './utils/logger.js'`, not `'./utils/logger'`.

## Async / Error Handling

- Use `async/await` throughout. No callback-style async.
- Wrap exchange calls in `try/catch`. Log errors with `logger.error(err.message)`.
- Never swallow errors silently.

## Configuration

- Read all config from `config/default.js`. Never hard-code symbols, thresholds, or timeframes inline.
- Feature flags and parameters belong in `config/default.js` with a descriptive comment.

## Logging

- Use `src/utils/logger.js` (Winston). Never use `console.log` in production paths.
- Log levels: `logger.info` for lifecycle events, `logger.warn` for recoverable issues, `logger.error` for failures, `logger.debug` for high-frequency detail.
- Never log API keys, secrets, or credentials.

## Top-Level Await

- Top-level `await` is allowed in ES module entry points (`main.js`).
- Module-level code in shared modules should be synchronous; use async factory functions when initialisation is async.

## Naming Conventions

- Files: `camelCase.js` (e.g., `signalAggregator.js`, `paperTrader.js`).
- Classes: `PascalCase`.
- Functions and variables: `camelCase`.
- Constants: `UPPER_SNAKE_CASE` for module-level constants.

## Comments

- Comment the *why*, not the *what*.
- JSDoc on exported functions is welcome but not mandatory.
- Remove debug comments before committing.

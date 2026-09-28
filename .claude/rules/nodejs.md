---
paths:
  - "**/*.{js,mjs}"
---

# Node.js conventions

- ES modules only (`"type": "module"`): `import`/`export`, never `require()` or `module.exports`.
  Import paths include the `.js` extension (`'./utils/logger.js'`, not `'./utils/logger'`). Named
  exports; a default export only for a module's main class or function.
- `async`/`await` throughout — no callback-style async. Top-level `await` belongs in entry points
  (`main.js`, scripts). Shared modules initialise synchronously and expose an async factory when
  setup is async.
- Config lives in `config/default.js` — symbols, thresholds and timeframes are never hard-coded
  inline. A new flag or parameter gets a comment there saying what it does and why its default.
- Log through `src/utils/logger.js`, not `console.log` (CLI scripts under `src/scripts/` may print
  their report to stdout). Levels: `info` lifecycle, `warn` recoverable, `error` failures, `debug`
  per-cycle detail. Never log API keys or secrets.
- Exchange calls sit in `try/catch` and log `err.message`; an error is either handled or rethrown,
  never swallowed.
- Naming: files `camelCase.js`, classes `PascalCase`, functions and variables `camelCase`,
  module-level constants `UPPER_SNAKE_CASE`.
- Comments explain *why*. JSDoc on exported functions is welcome, not mandatory. Remove debug
  comments before committing.

---
applyTo: "public/**,src/dashboard/**"
---

# Dashboard Instructions

Rules for all dashboard-related files: `public/index.html` and `src/dashboard/`.

## public/index.html

- This is an intentional single-file dashboard (CSS + HTML + JS inline). Do **not** split it.
- Keep all styling in the `<style>` block at the top.
- Keep all JavaScript in the `<script>` block at the bottom.
- No external JS imports or CDN links — this must work without internet access.
- Use `data-*` attributes on table rows for surgical DOM updates without full re-render.
- Use SSE (`/api/events`) as the primary update channel; use a polling fallback (`/api/status`) for reliability.

## SSE Architecture

- SSE events emitted from `dashboardServer.js`:
  - `event: cycle` — full state snapshot (positions, balance, history, summary)
  - `event: prices` — live price map `{ symbol: price }`, pushed every 5s by `main.js`
  - `event: heartbeat` — full `cycle` payload pushed every 15s as keep-alive
- Frontend subscribes in `initSSE()` and handles each event type separately.
- Never rely solely on SSE for live prices; always keep the `pollPositionPrices()` poller active.

## dashboardState.js

- Single source of truth for in-memory dashboard state.
- All writes to `dashboard_persist.json` go through `dashboardState.js`. No other module reads or writes that file directly.
- Public methods: `pushTrade(trade)`, `pushSignal(signal)`, `getSnapshot()`, `getPortfolioStats()`, `getHistoryOpenPositions(trades, prices)`.
- Smoke-test trades are stored and displayed with a 🔬 badge; never filtered at load time.
- Win rate and total P&L are computed from persisted trade history (survives restarts).

## dashboardServer.js

- Express server, port from `DASHBOARD_PORT` env or `config.dashboardPort` (default 3001).
- If port is in use (`EADDRINUSE`), log a loud error with the kill command and exit — never silently continue on a different port.
- API endpoints:
  - `GET  /api/status` — full snapshot
  - `GET  /api/events` — SSE stream
  - `POST /api/smoke-test` — trigger smoke test (calls `runSmokeTest` from `main.js`)
  - `GET  /api/smoke-test` — smoke-test status
  - `GET  /api/logs?lines=200&filter=` — last N lines of `logs/app.log`

## DOM Update Conventions

- Full re-render only for major state changes (new trade added, position opened/closed).
- For live price updates: surgical cell updates via `querySelector('[data-symbol="X"] .pos-current-price')`— no full table re-render.
- Countdown timer for next price refresh is shown in the positions panel header only when there are open positions.

## EUR / USD Display

- EUR rate is fetched from `open.er-api.com` every 10 minutes.
- P&L values: percentage as primary display, USD amount on hover (tooltip).
- Stat cards: `%` as big number, `$·€` as sub-line.

## Formatting Helpers

- `formatQty(qty)` — locale-aware with thresholds to avoid scientific notation.
- `formatSignedDual(pct, usd)` — returns `+X.XX%` with `title="$±X.XX"`.
- `formatEur(usd, rate)` — converts USD to EUR string.

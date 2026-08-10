# PlayCryptoWithAI

A multi-strategy crypto trading bot for Binance spot markets.  
Trades a **37-coin USDC portfolio** on 12h candles using a confidence-weighted voting engine with
multi-timeframe filters, BTC-regime gating, cross-asset context, and portfolio-level risk circuit breakers.

> **EU compliance:** All pairs trade against USDC (not USDT).

**Performance (honest baseline — full live filter stack, realistic next-open fills + tiered slippage):**  
`last 90d (most OOS): +15.3% · Sharpe 3.04 · Max DD −4.4% · WR 53%`  
`full history (386d): +24.6% · Sharpe 1.32 · Max DD −3.7% · WR 40%`

> These come from the committed baseline runner (`runBaseline.mjs`). The robustness overhaul
> deliberately traded the old (non-reproducible) headline figures for honest, low-drawdown numbers
> the bot can be trusted to run on unattended. See [STRATEGY.md](docs/STRATEGY.md#backtested-performance-honest-baseline-full-filter-stack).

📖 **[Strategy Documentation](docs/STRATEGY.md)** — signals, filters, sizing, exits  
📖 **[Technical Documentation](docs/TECHNICAL.md)** — architecture, modules, deployment  
📖 **[TSM Core Study](docs/TREND_CORE_STUDY.md)** — majors trending sleeve research (experimental, live-capable)

---

## Quick Start

### Paper Mode (local)
```bash
git clone git@github.com:colla69/PlayCryptoWithAI.git
cd PlayCryptoWithAI
npm install
cp .env.example .env          # fill in Binance API keys (read-only is fine)
npm run paper                  # dashboard on http://localhost:3001
```

### Docker (recommended for servers)
```bash
cp .env.live.example .env      # set PAPER_MODE=false, add Binance keys
docker compose up -d           # dashboard on http://<host>:3001
```

### Upgrade
```bash
git pull && docker compose build && docker compose up -d
```

### Dev Mode (paper, with hot reload)
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

---

## Dashboard

Live at `http://localhost:3001` — four tabs:

| Tab | Contents |
|-----|----------|
| **Dashboard** | Positions, P&L, trade history, manual close buttons |
| **Signals** | Full signal history with symbol/decision filters, paginated (50–1000) |
| **Tools** | P&L equity curve, deposit tracker with time-weighted return (TWR), 🔄 Refresh Balance |
| **Logs** | Full log viewer with filter and search |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BINANCE_API_KEY` | — | Binance API key |
| `BINANCE_API_SECRET` | — | Binance API secret |
| `PAPER_MODE` | `true` | `true` = simulate, no real funds |
| `BINANCE_TESTNET` | `false` | Use testnet endpoints |
| `SMOKE_TEST` | `true` | `false` = skip startup connectivity check |
| `DASHBOARD_PORT` | `3001` | Dashboard HTTP port |
| `LOG_LEVEL` | `info` | Winston log level |
| `TELEGRAM_TOKEN` | — | Optional: Telegram bot token for trade notifications |
| `TELEGRAM_CHANNEL_IDS` | — | Optional: comma-separated chat IDs for notifications |
| `TSM_CORE` | `false` | Enable TSM majors trending sleeve (simulates in paper; REAL orders in live). Sizing follows the HWM equity ladder — see STRATEGY.md |
| `WEBHOOK_TOKEN` | — | Required to run the external-signal webhook (off by default). Requests must send it as `x-webhook-token`; without the env var the server refuses to start |

Telegram alerts now include entry/exit, SL/TP, P&L, held time, and startup mode/filter context.

---

## npm Scripts

| Script | Description |
|---|---|
| `npm start` | Start bot (honours `PAPER_MODE`) |
| `npm run paper` | Force paper mode |
| `npm run backtest:portfolio` | Full 37-coin portfolio backtest |
| `npm run download-history` | Download candle history from Binance |
| `npm run optimize` | Per-symbol strategy optimizer |
| `npm run compare` | Strategy comparison across symbols |
| `npm test` | Unit tests (Node test runner) |
| `npm run test:vitest` | Unit tests (Vitest) |
| `npm run test:connection` | Verify Binance API connectivity |

### Backtest Flags
```bash
# All filters are MANDATORY for valid results:
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs \
  --mtf4h --regimeSizing --confSizing \
  --slots 3 --candles 730 --budget 1000
```

See `--help` or [TECHNICAL.md](docs/TECHNICAL.md) for all flags.

---

## Portfolio

37 Binance spot USDC pairs:  
BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, BCH, LTC, TRX, NEAR, INJ, CRV, LDO, ENS, TIA, SUI, MANTA, JTO, PIXEL, WLD, PEPE, TON, RENDER, ENA, ICP, APT, ARB, JUP, ACH, GMX, LSK, PAXG, THETA, VANRY

Max 4 concurrent positions (~25% capital each), sized by ATR and confidence.

---

## Protections

| Layer | Protection | Action |
|-------|-----------|--------|
| Data | Candle series > 24h stale | Symbol skipped for the cycle |
| Entry | Max 4 positions | BUY blocked |
| Entry | 4h momentum < 0.45 | BUY blocked |
| Entry | 15m alignment < 0.30 | BUY blocked |
| Entry | Daily loss > −5% | All trades blocked |
| Entry | BTC < EMA(200) | Size halved |
| Entry | ADX < 15 (chop) | Size halved |
| In-trade | Stop-loss (5%) | Market sell |
| In-trade | Take-profit (12%) | Market sell |
| In-trade | Break-even (+5%) | SL locked at entry (persisted to disk) |
| In-trade | Risk-check loop (every 2 min) | Catches stops between 12h signal cycles |
| Ops | Cycle watchdog (30 min) | Telegram alert when the loop stops deciding |
| Ops | Drift monitor (armed, per-trade Sharpe ref 0.4658) | Telegram alert when live diverges from backtest beyond 2 SE |
| Sizing | HWM equity ladder | Sleeve risk steps down as all-time-high equity grows — never back up |

### Timing Architecture

| Loop | Interval | Purpose |
|------|----------|---------|
| Signal cycle | 12h (candle close) | Strategy evaluation + BUY/SELL signals — rescheduled off the wall clock after every run, so a slow or stalled cycle can't drift the loop off candle close |
| Risk-check | 2 min | SL/TP/trailing/BE for open positions |
| Price poll | 5 sec | Dashboard live prices |
| MTF 15m cache | 15 min | Refresh 15m candle cache for filters |
| MTF 4h cache | 4h | Refresh 4h candle cache for filters |
| Balance sync | 5 min | Sync exchange balance + position restore |
| Cycle watchdog | 30 min | Telegram deadman alert if no cycle completes within 1.15× the candle period |

---

## Persistence

| Path | Contents |
|------|----------|
| `data/dashboard_persist.json` | Dashboard state, positions, trades |
| `data/position_state.json` | Stop-loss / HWM / entry per position (survives restarts) |
| `data/signal_history.json` | Signal decision history (max 5000 entries) |
| `data/deposits.json` | Deposit tracker (gitignored, runtime-only) |
| `data/equity_history.json` | Daily equity snapshots — the valuation series TWR chains between |
| `data/filtered_optimization_results.json` | Per-symbol optimizer results (pass/fail) |
| `data/candles/` | Cached OHLCV data (gitignored — see below) |
| `logs/trades.csv` | Trade journal |
| `logs/app-YYYY-MM-DD.log` | Runtime log (DailyRotateFile, 50 MB max, 30 d retention) |

All state files are bind-mounted in Docker, and **none of them are in git** —
`.gitignore` covers `data/*` and `logs/*`. A new server starts with empty state
and rebuilds it rather than inheriting a snapshot:

```bash
npm run download-history -- --timeframe 12h    # and 4h + 15m for the MTF filters
```

Booting without any cache also works: `initializeHistoricalData` cold-starts and
backfills `config.historicalCandles` bars per symbol from Binance. Only the
backtests need the 4h/15m series present up front.

---

## Disclaimer

Educational and research purposes. Paper mode enabled by default. When `PAPER_MODE=false`, real orders are placed on Binance. You are solely responsible for any financial outcome. Past performance does not guarantee future results.

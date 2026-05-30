# PlayCryptoWithAI

A multi-strategy crypto trading bot for Binance spot markets.  
Trades a **37-coin USDC portfolio** on 12h candles using a voting signal engine with multi-timeframe filters.

> **EU compliance:** All pairs trade against USDC (not USDT).

**Performance (4 years, 37 coins, realistic fills + slippage):**  
`Y2: +87.1% · Sharpe 2.15 · Max DD −7.2% · WR 63.6%`  
`Full OOS: +1912% · Sortino 10.33 · Max DD −13.0% · WR 62.8%`

📖 **[Strategy Documentation](STRATEGY.md)** — signals, filters, sizing, exits  
📖 **[Technical Documentation](TECHNICAL.md)** — architecture, modules, deployment

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

Live at `http://localhost:3001` — three tabs:

| Tab | Contents |
|-----|----------|
| **Dashboard** | Positions, P&L, trade history, signal feed, manual close buttons |
| **Tools** | P&L equity curve, deposit tracker with True ROI |
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
| `TELEGRAM_TOKEN` | — | Optional: Telegram notifications |

---

## npm Scripts

| Script | Description |
|---|---|
| `npm start` | Start bot (honours `PAPER_MODE`) |
| `npm run paper` | Force paper mode |
| `npm run backtest:portfolio` | Full 37-coin portfolio backtest |
| `npm run download-history` | Download candle history from Binance |
| `npm run optimize` | Per-symbol strategy optimizer |
| `npm test` | Unit tests |
| `npm run test:connection` | Verify Binance API connectivity |

### Backtest Flags
```bash
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs \
  --mtf4h --regimeSizing --confSizing \
  --slots 3 --candles 730 --budget 1000
```

See `--help` or [TECHNICAL.md](TECHNICAL.md) for all flags.

---

## Portfolio

37 Binance spot USDC pairs:  
BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, BCH, LTC, TRX, NEAR, INJ, CRV, LDO, ENS, TIA, SUI, MANTA, JTO, PIXEL, WLD, PEPE, TON, RENDER, ENA, ICP, APT, ARB, JUP, ACH, GMX, LSK, PAXG, THETA, VANRY

Max 3 concurrent positions (~33% capital each), sized by ATR and confidence.

---

## Protections

| Layer | Protection | Action |
|-------|-----------|--------|
| Entry | Max 3 positions | BUY blocked |
| Entry | 4h momentum < 0.45 | BUY blocked |
| Entry | 15m alignment < 0.50 | BUY blocked |
| Entry | Daily loss > −5% | All trades blocked |
| Entry | BTC < EMA(200) | Size halved |
| Entry | ADX < 15 (chop) | Size halved |
| In-trade | Stop-loss (5%) | Market sell |
| In-trade | Take-profit (12%) | Market sell |
| In-trade | Break-even (+5%) | SL locked at entry |

---

## Persistence

| Path | Contents |
|------|----------|
| `data/dashboard_persist.json` | Dashboard state, positions |
| `data/deposits.json` | Deposit tracker |
| `data/candles/` | Cached OHLCV data |
| `logs/trades.csv` | Trade journal |
| `logs/app.log` | Runtime log (gitignored) |

All state files are bind-mounted in Docker. `git pull` restores everything on a new server.

---

## Disclaimer

Educational and research purposes. Paper mode enabled by default. When `PAPER_MODE=false`, real orders are placed on Binance. You are solely responsible for any financial outcome. Past performance does not guarantee future results.

# PlayCryptoWithAI

A multi-strategy crypto trading bot for Binance spot markets.  
Trades a **22-coin USDC portfolio** on a 12h timeframe using a voting signal engine, ATR-based position sizing, multi-timeframe alignment filters, and a live dashboard.

> **EU compliance note:** All pairs trade against USDC (not USDT). USDT is not tradeable from most EU countries.

**Backtested performance (18 months, 22 USDC coins, MTF + confSizing):**  
`+42.69% return · Sharpe 2.17 · Max drawdown −9.79%`

---

## Features

### Signal Engine
- **14 strategies** vote on every candle: RSI, Bollinger Bands, CCI, EMA, MACD, ADX, Stochastic, StochRSI, MFI, OBV, PSAR, WilliamsR, Supertrend, HeikinAshi
- Weighted confidence aggregation — entry only when score exceeds per-symbol threshold
- Per-symbol strategy combinations optimised via backtesting

### Risk Management
- **ATR position sizing** — volatile coins get smaller allocations automatically
- **Stop-loss / take-profit** per symbol (configured in `config/default.js`)
- **Break-even stop** — moves SL to entry once trade reaches +5%
- **Macro bear filter** — halves position size when BTC is below EMA(200)
- **Daily loss limit** — halts trading if drawdown exceeds threshold
- **Step-size precision** — sells the exact maximum qty Binance accepts (no dust remainder)

### Multi-Timeframe (MTF) Alignment Filter
- Before entering a 12h BUY, checks last 16 × 15m candles (4h window)
- Blocks entry when short-term trend is bearish (< 50% green candles)
- Covers all 22 portfolio coins — blocks ~167 bad entries per year
- +5pp return improvement vs no filter

### Confidence-Proportional Sizing
- High-confidence signals (conf ≥ 0.65) get up to **1.5× position size**
- Low-confidence signals get as little as **0.6×**
- Linear interpolation — no sharp jumps

### Live Position Sync
- On startup and every 5 minutes, the bot reads actual Binance balances
- Automatically restores any open positions after a restart (no manual intervention needed)
- Entry prices recovered from trade history; SL/TP recalculated from per-symbol config

### Dashboard
- Live web dashboard at `http://localhost:3001`
- Real-time open positions, P&L, trade history (with trade size column), signal feed
- Manual **Close Position** button per open trade
- Balance auto-refresh every 5 minutes (picks up deposits automatically)
- **Reset History** button to clear trade log and persisted state
- Log viewer with live filter and debounced search
- Persists across restarts via `data/dashboard_persist.json` and `logs/trades.csv` (both git-tracked)

---

## Quick Start

### Local (paper mode)
```bash
git clone git@github.com:colla69/PlayCryptoWithAI.git
cd PlayCryptoWithAI
npm install
cp ..env.example ..env          # fill in Binance API keys (read-only is fine for paper mode)
npm run paper                   # starts bot in paper mode, dashboard on port 3001
```

### Docker (recommended for servers)
```bash
git clone git@github.com:colla69/PlayCryptoWithAI.git
cd PlayCryptoWithAI
cp ..env.live.example ..env     # fill in your Binance keys, set PAPER_MODE=false
docker compose up -d            # starts bot; dashboard on http://<host>:3001
```

Trade history (`data/dashboard_persist.json`, `logs/trades.csv`) and candle data (`data/candles/`) are bind-mounted directly from the repo — no separate volume seeding required.

**Upgrade after a code change:**
```bash
git pull
docker compose build
docker compose up -d
```

**Local dev while live bot runs on server:**
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
# forces PAPER_MODE=true, live-syncs src/ on file change
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `BINANCE_API_KEY` | — | Binance API key |
| `BINANCE_API_SECRET` | — | Binance API secret |
| `PAPER_MODE` | `true` | `true` = simulate orders, no real funds |
| `BINANCE_TESTNET` | `false` | Use Binance testnet endpoints |
| `DASHBOARD_PORT` | `3001` | Dashboard HTTP port |
| `LOG_LEVEL` | `info` | Winston log level |
| `TELEGRAM_TOKEN` | — | Optional: Telegram bot notifications |

Copy `.env.example` → `..env` for local dev.  
Copy `.env.live.example` → `..env` for the server (never committed).

---

## npm Scripts

| Script | Description |
|---|---|
| `npm start` | Start bot (honours `PAPER_MODE` env var) |
| `npm run paper` | Force paper mode |
| `npm run backtest:portfolio` | Run full 22-coin portfolio backtest |
| `npm run download-history` | Download OHLCV candle history from Binance |
| `npm run optimize` | Per-symbol strategy optimiser |
| `npm test` | Unit tests |
| `npm run test:connection` | Verify Binance API connectivity |

### Backtest flags (portfolio backtest)
```bash
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs \
  --mtf          # enable MTF alignment filter (uses 15m candles on disk)
  --confSizing   # enable confidence-proportional position sizing
  --mtfExit      # enable 15m early exit for losing positions (experimental)
  --slots 5      # max concurrent open positions
  --budget 1000  # starting capital in USD
  --sl 0.08      # stop-loss override (8%)
  --tp 0.20      # take-profit override (20%)
```

---

## Project Structure

```
config/
  default.js          ← all strategy params, risk config, feature flags
src/
  main.js             ← bot entry point, main trading loop
  strategies/         ← 14 signal strategies (one file each)
  engine/
    signalAggregator.js  ← weighted voting, confidence scoring
  backtester/
    portfolioBacktester.js  ← shared-balance multi-symbol backtester
  risk/               ← position sizing, daily loss limit
  executor/
    paperTrader.js    ← simulated order execution
    liveTrader.js     ← real Binance orders (when PAPER_MODE=false)
  exchange/
    binanceClient.js  ← ccxt wrapper (fetchTicker, createOrder, amountToPrecision…)
    candleCache.js    ← disk-backed candle cache
  dashboard/          ← Express API + SSE events for live dashboard
  utils/
    mtfAlignment.js   ← MTF index builder + alignment score
    indicators.js     ← shared indicator helpers (EMA, ATR, etc.)
  scripts/
    portfolioBacktest.mjs   ← CLI research tool
    downloadHistory.js      ← fetch & cache OHLCV from Binance
    perSymbolOptimizer.mjs  ← exhaustive strategy combo search
public/
  index.html          ← dashboard frontend (vanilla JS, SSE-driven)
data/
  candles/            ← cached OHLCV (12h + 15m for all 22 USDC coins, git-tracked)
  dashboard_persist.json   ← dashboard state across restarts (git-tracked)
logs/
  trades.csv          ← full trade journal (git-tracked)
  app.log             ← runtime log (gitignored)
```

---

## Portfolio

22 Binance spot USDC pairs: BTC, ETH, BNB, XRP, LINK, LTC, TRX, BCH, NEAR, PAXG, DOT, ATOM, CRV, ENS, GMX, JTO, LDO, LSK, MANTA, PIXEL, SUI, THETA, TIA, VANRY

Max 5 concurrent open positions. Each position sized individually by ATR and confidence.

---

## Docker — Persistence

Trade history and candle data are stored directly in the repo via bind mounts:

| Path | Contents | Git-tracked |
|---|---|---|
| `./data/candles/` | All OHLCV candle files (~300 MB) | ✅ |
| `./data/dashboard_persist.json` | Dashboard state, open positions | ✅ |
| `./logs/trades.csv` | Full trade journal | ✅ |
| `./logs/app.log` | Runtime log | ❌ (gitignored) |

**Moving to a new server:**
```bash
git pull   # ← restores candles, trade history and all config — no backup needed
docker compose up -d
```

---

## Disclaimer

This software is for educational and research purposes. Paper mode is enabled by default. When `PAPER_MODE=false`, real orders are placed on Binance. You are solely responsible for any financial outcome. Past backtest performance does not guarantee future results.

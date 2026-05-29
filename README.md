# PlayCryptoWithAI

A multi-strategy crypto trading bot for Binance spot markets.  
Trades a **37-coin USDC portfolio** on a 12h timeframe using a voting signal engine, ATR-based position sizing, multi-timeframe alignment filters, and a live dashboard.

> **EU compliance note:** All pairs trade against USDC (not USDT). USDT is not tradeable from most EU countries.

**Backtested performance (4 years, 37 USDC coins, next-open fills, tiered slippage):**  
`Y2 in-sample: +87.1% · Sharpe 2.15 · Max DD −7.2% · WR 63.6% · PF 5.70`  
`Y1+Y2 full OOS: +1912% · Sortino 10.33 · Max DD −13.0% · WR 62.8%`

---

## Features

### Signal Engine
- **15 strategies** vote on every candle: RSI, Bollinger Bands, CCI, EMA, MACD, ADX, Stochastic, StochRSI, MFI, OBV, PSAR, WilliamsR, Supertrend, HeikinAshi, Support & Resistance
- **HOLD-suppressed aggregation** — HOLD votes don't dilute directional confidence (1 BUY + 2 HOLD = 100% confidence, not 33%)
- **Asymmetric exit threshold** — open positions can exit at 70% of normal confidence when SELL majority exists
- Per-symbol strategy combinations optimised via holdout-validated backtesting

### Risk Management
- **ATR position sizing** — volatile coins get smaller allocations automatically
- **Stop-loss / take-profit** per symbol (configured in `config/default.js`)
- **Break-even stop** — moves SL to entry once trade reaches +5%
- **Macro bear filter** — halves position size when BTC is below EMA(200)
- **Daily loss limit** — halts trading if drawdown exceeds threshold
- **Step-size precision** — sells the exact maximum qty Binance accepts (no dust remainder)

### Multi-Timeframe (MTF) Alignment Filters
- **15m filter:** Before entering a 12h BUY, checks last 16 × 15m candles (4h window)
  - Recency-weighted scoring — recent 15m candles have ~2× influence vs oldest
  - Blocks entry when short-term trend is bearish (score < 0.5)
- **4h momentum filter:** EMA(8)/EMA(21) crossover + RSI(14) on 4h candles
  - Score < 0.45 → entry blocked (4h trend is clearly bearish)
  - Blocks ~80 bad entries per year, boosts WR by +10pp
- Combined: covers all 37 coins — blocks ~290 bad entries per year

### Confidence-Proportional Sizing
- High-confidence signals (conf ≥ 0.65) get up to **1.5× position size**
- Low-confidence signals get as little as **0.6×**
- Linear interpolation — no sharp jumps

### Regime-Aware Position Sizing
- ADX-based — scales position size by trend strength at entry time
- **ADX ≥ 25** (strong trend): position boosted to **1.3×**
- **ADX < 15** (choppy range): position reduced to **0.5×**
- Combined with 4h filter: +893% full OOS vs +453% baseline (Calmar 73.9)

### Live Position Sync
- On startup and every 5 minutes, the bot reads actual Binance balances
- Automatically restores any open positions after a restart (no manual intervention needed)
- Entry prices recovered from trade history; SL/TP recalculated from per-symbol config
- **Synthetic trade record** — if no matching BUY found in history, a synthetic entry is created for dashboard continuity

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
| `SMOKE_TEST` | `true` | `false` = skip startup connectivity check |
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
| `npm run backtest:portfolio` | Run full 37-coin portfolio backtest |
| `npm run download-history` | Download OHLCV candle history from Binance |
| `npm run optimize` | Per-symbol strategy optimiser |
| `npm test` | Unit tests |
| `npm run test:connection` | Verify Binance API connectivity |

### Backtest flags (portfolio backtest)
```bash
PAPER_MODE=true node src/scripts/portfolioBacktest.mjs \
  --mtf          # enable MTF alignment filter (uses 15m candles on disk)
  --mtf4h        # enable 4h momentum filter (EMA crossover + RSI)
  --mtf4hScore 0.45   # minimum 4h score to allow entry
  --regimeSizing # enable ADX-based position sizing (boost trends, reduce chop)
  --confSizing   # enable confidence-proportional position sizing
  --mtfExit      # enable 15m early exit for losing positions (experimental)
  --slots 3      # max concurrent open positions
  --candles 730  # candle window (730=Y2 in-sample, 1460=Y1+Y2 full OOS)
  --budget 1000  # starting capital in USD
  --sl 0.08      # stop-loss override (8%)
  --tp 0.20      # take-profit override (20%)
```

> **Backtest integrity:** BUY fills use next-candle open (no execution lookahead). Slippage is tiered: large caps 0.10%, mid caps 0.20%, micro caps 0.35%. Optimizer uses holdout validation with MIN_TRADES ≥ 3. Always report both `--candles 730` (in-sample) and `--candles 1460` (OOS included) results.

---

## Project Structure

```
config/
  default.js          ← all strategy params, risk config, feature flags
src/
  main.js             ← bot entry point, main trading loop
  strategies/         ← 15 signal strategies (one file each)
  engine/
    signalAggregator.js  ← weighted voting, confidence scoring
  backtester/
    portfolioBacktester.js  ← shared-balance multi-symbol backtester
    backtestSimulator.js    ← per-trade execution (next-open fills, tiered slippage)
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
    portfolioBacktest.mjs   ← CLI research tool (SLIPPAGE_TIERS, two-window reporting)
    downloadHistory.js      ← fetch & cache OHLCV from Binance
    perSymbolOptimizer.mjs  ← exhaustive strategy combo search (MIN_TRADES ≥ 3)
public/
  index.html          ← dashboard frontend (vanilla JS, SSE-driven)
data/
  candles/            ← cached OHLCV (12h + 15m for all 37 USDC coins, git-tracked)
  dashboard_persist.json   ← dashboard state across restarts (git-tracked)
logs/
  trades.csv          ← full trade journal (git-tracked)
  app.log             ← runtime log (gitignored)
```

---

## Portfolio

37 Binance spot USDC pairs:  
BTC, ETH, BNB, SOL, XRP, ADA, DOGE, AVAX, LINK, BCH, LTC, TRX, NEAR, INJ, CRV, LDO, ENS, TIA, SUI, MANTA, JTO, PIXEL, WLD, PEPE, TON, RENDER, ENA, ICP, APT, ARB, JUP, ACH, GMX, LSK, PAXG, THETA, VANRY

Max **3** concurrent open positions (~33% capital each), sized by ATR and confidence.  
Per-symbol strategies and risk params are holdout-validated (Y1 OOS, MIN_TRADES ≥ 3).

---

## Docker — Persistence

Trade history and candle data are stored directly in the repo via bind mounts:

| Path | Contents | Git-tracked |
|---|---|---|
| `./data/candles/` | All OHLCV candle files (12h + 15m, ~300 MB) | ✅ |
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

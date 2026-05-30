# Technical Documentation

Architecture, data flow, module responsibilities, and deployment.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         main.js (entry point)                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Exchange     │    │  Signal Engine    │    │  Risk Manager    │  │
│  │  (Binance)   │    │                  │    │                  │  │
│  │              │    │  15 Strategies    │    │  Daily loss      │  │
│  │  fetchOHLCV  │───▶│  SignalAggregator │───▶│  Position sizing │  │
│  │  createOrder │    │  MTF filters     │    │  Max positions   │  │
│  │  fetchBalance│    │  Confidence calc  │    │  SL/TP checks    │  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Executor    │    │  Dashboard        │    │  State           │  │
│  │              │    │                  │    │                  │  │
│  │  PaperTrader │    │  Express + SSE   │    │  JSON files      │  │
│  │  LiveTrader  │    │  3-tab UI        │    │  Trade CSV       │  │
│  │  OCO orders  │    │  Deposit tracker │    │  Candle cache    │  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module Map

### Core (`src/`)

| Module | File | Responsibility |
|--------|------|----------------|
| Entry point | `main.js` | Trading loop, filter orchestration, startup sequence |
| Signal Aggregator | `engine/signalAggregator.js` | Weighted voting, confidence scoring, HOLD suppression |
| Strategies | `strategies/*.js` | 15 independent signal generators |
| Strategy Builder | `utils/strategyBuilder.js` | Per-symbol strategy/risk selection from config |
| Risk Manager | `risk/index.js` | Daily loss limit, trade gating |
| Paper Trader | `executor/paperTrader.js` | Simulated order execution |
| Live Trader | `executor/liveTrader.js` | Real Binance market orders, position tracking |
| Binance Client | `exchange/binanceClient.js` | ccxt wrapper, retry logic, market limits |
| OCO Orders | `exchange/ocoOrders.js` | Server-side SL/TP for Lambda deployment |
| Candle Cache | `exchange/candleCache.js` | Disk-backed OHLCV cache |
| MTF Alignment | `utils/mtfAlignment.js` | 15m and 4h filter scoring |
| Indicators | `utils/indicators.js` | EMA, ATR, ADX, RSI, Bollinger, etc. |
| Correlation | `utils/correlation.js` | Pearson correlation matrix builder |
| Logger | `utils/logger.js` | Winston logger + CSV trade appender |
| Dashboard | `dashboard/dashboardServer.js` | Express API, SSE, deposits CRUD |
| Dashboard State | `dashboard/dashboardState.js` | In-memory state for SSE broadcasts |

### Backtesting (`src/backtester/`)

| Module | Responsibility |
|--------|----------------|
| `portfolioBacktester.js` | Multi-symbol shared-balance simulation, all filters |
| `backtestSimulator.js` | Per-trade execution (next-open fills, tiered slippage) |
| `metrics.js` | Sharpe, Sortino, drawdown, profit factor, win rate |

### Scripts (`src/scripts/`)

| Script | Purpose |
|--------|---------|
| `portfolioBacktest.mjs` | CLI backtest runner with all flags |
| `downloadHistory.js` | Fetch OHLCV from Binance, save to disk |
| `perSymbolOptimizer.mjs` | Exhaustive strategy combo search with holdout validation |

### Lambda (`src/lambda/`)

| Handler | Purpose |
|---------|---------|
| `tradingHandler.js` | Trading bot logic (EventBridge → every 15 min) |
| `dashboardHandler.js` | Dashboard API (API Gateway) |

### State Persistence (`src/state/`)

| Module | Purpose |
|--------|---------|
| `index.js` | Abstraction layer (auto-selects local vs S3) |
| `localStore.js` | JSON file persistence (Docker/local mode) |
| `s3Store.js` | S3-backed persistence (Lambda mode) |

---

## Data Flow

### Trading Cycle (every 12h candle close)

```
1. fetchOHLCV(symbol, '15m', 100)  → candleCache
   fetchOHLCV(symbol, '4h', 30)   → candle4hCache
   fetchOHLCV(symbol, '12h', 100) → main candles

2. For each symbol:
   strategies[symbol].computeSignal(candles)
     → { signal: BUY/SELL/HOLD, confidence: 0-1, reason: string }

3. signalAggregator.evaluate(candles)
     → { decision, confidence, signals[] }

4. Filter cascade:
   maxPositions? → dailyLossLimit? → mtf15m? → mtf4h? → minConfidence?

5. Position sizing:
   base × ATR × confidence × regime × macro → effectiveRisk

6. trader.execute(symbol, decision, price, effectiveRisk)
     → createOrder(symbol, 'market', 'buy', qty)
     → position tracked in memory + persisted

7. Risk check (existing positions):
   price ≤ stopLoss?     → market sell (stop_loss)
   price ≥ takeProfit?   → market sell (take_profit)
   price ≥ entry × 1.05? → stopLoss = entryPrice (break_even)
```

### Position Sync (startup + every 5 min)

```
1. fetchBalance() → all asset quantities
2. For each symbol: if balance > MIN_RESTORE_NOTIONAL ($5)
3. Find entry price from trade history (walk newest BUY)
4. Reconstruct position object (entry, SL, TP, qty)
5. If no history match → create synthetic entry at current price
```

---

## Persistence

### Local Mode (Docker / bare metal)

| File | Format | Contents |
|------|--------|----------|
| `data/dashboard_persist.json` | JSON | Dashboard state (positions, signals, trades) |
| `data/deposits.json` | JSON | Deposit tracker entries |
| `data/candles/*.json` | JSON | Cached OHLCV data (12h, 15m, 4h) |
| `logs/trades.csv` | CSV | Full trade journal |
| `logs/app.log` | Text | Runtime log (winston) |

### Lambda Mode (S3)

| Key | Contents |
|-----|----------|
| `state/positions.json` | Open positions array |
| `state/trades.json` | Trade history array |
| `state/deposits.json` | Deposit tracker entries |
| `state/lastCycle.json` | Last execution timestamp |
| `logs/` | Retained 30 days (lifecycle rule) |

---

## Deployment Options

### 1. Docker (current production)

```bash
docker compose up -d   # bot + dashboard on :3001
```

- Bind-mounts `data/`, `logs/`, `config/` from repo
- No external database — all state in JSON files
- Git pull to upgrade, docker compose build to rebuild

### 2. AWS Lambda (serverless, ~$0.65/month)

```
EventBridge (15 min) → TradingBotFunction
API Gateway          → DashboardApiFunction
S3 static website    → Dashboard HTML
S3 bucket            → State persistence
```

Deploy: `./aws/deploy.sh` (requires SAM CLI + AWS credentials)

Key difference: Binance OCO orders handle SL/TP server-side (bot doesn't need to run 24/7).

### 3. Bare Metal / VPS

```bash
npm install && npm start   # or: npm run paper
```

Use systemd/pm2 for auto-restart. Dashboard on port 3001.

---

## Configuration

All configuration lives in `config/default.js`. Structure:

```
config
├── symbols[]              37 USDC pairs
├── strategies[]           Default strategy set
├── risk{}                 Global risk parameters
│   ├── initialBalance
│   ├── maxPositionPct, stopLossPct, takeProfitPct
│   ├── breakEvenTriggerPct, maxDailyLossPct
│   └── maxOpenPositions
├── symbolOverrides{}      Per-symbol strategies + risk
├── signals{}              External signal config (webhook, telegram)
├── atr{}                  ATR position sizing params
├── macroFilter{}          BTC EMA(200) bear detection
├── correlation{}          Pearson correlation filter (disabled)
├── mtfFilter{}            15m alignment filter params
├── confSizing{}           Confidence-proportional sizing
├── mtf4hFilter{}          4h momentum filter params
└── regimeSizing{}         ADX regime detection params
```

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 12h timeframe | Strategies need multi-day patterns; 4h too noisy (38% WR) |
| HOLD suppression | Prevents inactive strategies from diluting signals |
| 3 slots | Maximizes per-trade capital; DD only +1pp vs 5 slots |
| Next-open fills | No execution lookahead — realistic fill simulation |
| Tiered slippage | Large caps 0.10%, mid 0.20%, micro 0.35% |
| Fixed SL/TP over trailing | Trailing gives back profits on retracements |
| Market orders | Guaranteed fill; slippage acceptable on 12h timeframe |
| No database | JSON files sufficient for <100 trades/month; simple backup (git) |
| OCO for Lambda | Exchange handles exits 24/7 without running process |

---

## Development Workflow

```bash
# Run backtest (Y2 in-sample)
npm run backtest:portfolio -- --candles 730 --mtf4h --regimeSizing --confSizing

# Run backtest (full OOS)  
npm run backtest:portfolio -- --candles 1460 --mtf4h --regimeSizing --confSizing

# Run optimizer
npm run optimize

# Download fresh candle data
npm run download-history

# Test connection
npm run test:connection

# Paper mode
npm run paper

# Syntax check after changes
node --check src/path/to/file.js
```

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
│  │              │    │  20 Strategies    │    │  Daily loss      │  │
│  │  fetchOHLCV  │───▶│  SignalAggregator │───▶│  Position sizing │  │
│  │  createOrder │    │  MTF + regime     │    │  Correlation cap │  │
│  │  fetchBalance│    │  Cross-asset ctx  │    │  DD breaker/aging│  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────┐    ┌──────────────────┐  │
│  │  Executor    │    │  Dashboard        │    │  State           │  │
│  │              │    │                  │    │                  │  │
│  │  PaperTrader │    │  Express + SSE   │    │  JSON files      │  │
│  │  LiveTrader  │    │  4-tab UI        │    │  position_state  │  │
│  │  OCO orders  │    │  Deposit tracker │    │  Trade CSV       │  │
│  │  State save  │    │  512KB log tail  │    │  Candle cache    │  │
│  └──────────────┘    └──────────────────┘    └──────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Notifications (src/notifications/telegramNotifier.js)        │  │
│  │  Send-only Telegram bot — BUY/SELL/Startup alerts             │  │
│  │  No-op if TELEGRAM_TOKEN / TELEGRAM_CHANNEL_IDS unset         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Module Map

### Core (`src/`)

| Module | File | Responsibility |
|--------|------|----------------|
| Entry point | `main.js` | Trading loop, filter orchestration, startup sequence |
| Signal Aggregator | `engine/signalAggregator.js` | Confidence-weighted voting + multi-bar gate (consumes `aggregatorVoting.js`) |
| Aggregator Voting | `engine/aggregatorVoting.js` | Pure voting math — shared by live, backtester, optimizer (parity-locked) |
| Regime Classifier | `engine/regimeClassifier.js` | BTC 2×2 regime (EMA200 × ADX) with 3-bar hysteresis |
| Regime Router | `engine/regimeRouter.js` | Bear policy (cash-exit on BEAR_TREND) + regime→strategy bundles (routing OFF) |
| TSM Core | `engine/tsmCore.js` | Majors trending-sleeve engine (majority-vote trailing momentum); pure functions |
| Strategies | `strategies/*.js` | 20 independent signal generators (+ `registry.js` catalog) |
| Strategy Builder | `utils/strategyBuilder.js` | Per-symbol strategy/risk selection; applies `confidenceThresholdScale` |
| Market Context | `data/marketContext.js` | BTC.D (CoinGecko) + ETHBTC (Binance) cache, replayable in backtest |
| Fear & Greed | `data/fearGreed.js` | F&G history loader for the entry-threshold modulator |
| Risk Manager | `risk/index.js` | Daily loss limit, trade gating |
| Portfolio Risk | `risk/portfolioRisk.js` | Correlation cap, weekly DD breaker, position-aging exit (pure fns, shared live/backtest) |
| Paper Trader | `executor/paperTrader.js` | Simulated order execution |
| Live Trader | `executor/liveTrader.js` | Real Binance market orders, position tracking, position state persistence |
| Binance Client | `exchange/binanceClient.js` | ccxt wrapper, retry logic, market limits |
| OCO Orders | `exchange/ocoOrders.js` | Server-side SL/TP for Lambda deployment |
| Candle Cache | `exchange/candleCache.js` | Disk-backed OHLCV cache; merge-preserving saves keep deep research history intact |
| MTF Alignment | `utils/mtfAlignment.js` | 15m and 4h filter scoring |
| Indicators | `utils/indicators.js` | EMA, ATR, ADX, RSI, Bollinger, etc. |
| Correlation | `utils/correlation.js` | Pearson correlation matrix builder |
| Logger | `utils/logger.js` | Winston logger + CSV trade appender |
| Dashboard | `dashboard/dashboardServer.js` | Express API, SSE, deposits CRUD, dated log reader (512KB tail) |
| Dashboard State | `dashboard/dashboardState.js` | In-memory state for SSE broadcasts |
| Persistence | `dashboard/persistence.js` | Debounced JSON write for dashboard state + signal history |
| Notifications | `notifications/telegramNotifier.js` | Send-only Telegram bot (BUY/SELL/startup alerts); no-op if unconfigured |

### Backtesting (`src/backtester/`)

| Module | Responsibility |
|--------|----------------|
| `portfolioBacktester.js` | Multi-symbol shared-balance simulation, full filter + regime + risk-gate stack |
| `backtestSimulator.js` | Per-trade execution (next-open fills, tiered slippage, ATR/two-stage infra) |
| `metrics.js` | Sharpe, Sortino, drawdown, profit factor, win rate |
| `deflatedSharpe.js` | Deflated/Probabilistic Sharpe (Bailey & López de Prado) — multiple-testing correction |
| `baselineFramework.js` | Reusable multi-window baseline runner (full live filter stack) |
| `walkForward.js` | Forward-only walk-forward harness + Monte Carlo trade shuffle |
| `stressReport.js` | Pure stoplight verdict (🟢/🟡/🔴) over stress windows — used by `runBaseline --stoplight` |
| `../monitor/driftMonitor.js` | Live vs backtest per-trade Sharpe drift detection (Lo 2002 SE) |

### Scripts (`src/scripts/`)

| Script | Purpose |
|--------|---------|
| `portfolioBacktest.mjs` | CLI backtest runner with all flags |
| `downloadHistory.js` | Fetch OHLCV from Binance, save to disk |
| `perSymbolOptimizer.mjs` | Exhaustive strategy combo search; MIN_TRADES≥8, deflated-Sharpe gate, shared aggregator |
| `runBaseline.mjs` | Run the multi-window baseline → `data/baseline_<phase>.json`; `--stoplight` adds the stress verdict |
| `runWalkForward.mjs` | Walk-forward + Monte Carlo report (honest out-of-sample equity) |
| `trainMetaOverlay.mjs` | Train the Phase-5 logistic P(win) overlay → `data/meta_overlay.json` (gate-only, default OFF) |

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
1. MTF candles served from in-memory cache (refreshed every 15m / 4h)
   12h candles fetched fresh from Binance and merged into history cache

2. For each symbol:
   strategies[symbol].computeSignal(candles)
     → { signal: BUY/SELL/HOLD, confidence: 0-1, reason: string }

3. signalAggregator.evaluate(candles)
     → { decision, confidence, signals[] }

4. Filter cascade (uses cached 15m/4h data — no extra API calls):
   bearRegimeBlock? → maxPositions? → dailyLossLimit? → weeklyDDBreaker?
     → correlationCap? → mtf15m? → mtf4h? → BTC.D gate / F&G modulator → minConfidence?

5. Position sizing:
   base × ATR × confidence × regime × macro → effectiveRisk

6. trader.execute(symbol, decision, price, effectiveRisk)
      → createOrder(symbol, 'market', 'buy', qty)
      → position tracked in memory + persisted to data/position_state.json
      → notifyTrade() → Telegram alert (if configured)

7. Risk check (existing positions):
    price ≤ stopLoss?     → market sell (stop_loss)
    price ≥ takeProfit?   → market sell (take_profit)
    price ≥ entry × 1.05? → stopLoss = entryPrice (break_even), save state
    All closes → notifyTrade() → Telegram alert (if configured)

8. TSM Core Cycle (if `TSM_CORE=true`, paper-only):
   runTsmCoreCycle() reads closed 12h candles from dashboardState (no lookahead)
   For each core symbol: computeTsmVote(trailing momentum) → majority vote
   If vote flips: openCorePosition / closeCorePosition → position tracked with isCore flag
   Core positions excluded from risk-loop SL/TP, correlation cap, daily-loss accounting
```

### Fast Risk-Check Loop (every 2 min)

```
1. For each open position:
   fetchTicker(symbol) → current price
2. Evaluate: trailing stop, break-even, stop-loss, take-profit
3. If triggered → market sell, update dashboard, persist state
4. Reduces market exposure window from 12h to ~2 min
```

### MTF Candle Cache

```
┌─────────────────────────────────────────────┐
│ 15m cache: refreshed every 15 min (24 bars) │
│ 4h cache:  refreshed every 4h (30 bars)     │
│ On cache miss: live fetch + warm cache       │
└─────────────────────────────────────────────┘
- Eliminates 74 API calls per BUY evaluation (37 symbols × 2 TF)
- Stored in-memory (not disk) — rebuilt on restart
```

### Position Sync (startup + every 5 min)

```
1. fetchBalance() → all asset quantities
2. For each symbol: if balance > MIN_RESTORE_NOTIONAL ($5)
3. Find entry price from trade history (walk newest BUY)
4. Load persisted state from data/position_state.json (SL, HWM, entry)
5. Reconstruct position object (entry, SL, TP, qty)
6. If persisted state exists → restore exact SL/HWM (no data loss on restart)
7. If no persisted state → lock break-even only when the live ticker is already above entry × 1.05
8. If no history match → create synthetic entry at current price
```

### Trade Loading on Startup

```
1. Load trades from data/dashboard_persist.json (primary source)
2. Fallback: parse logs/trades.csv if persist file missing or empty
3. Merge deduplicated trades into dashboardState
4. Both /api/trades and /api/daily-pnl read from dashboard_persist.json
```

### Telegram Notifications

```
1. initNotifier(TELEGRAM_TOKEN, TELEGRAM_CHANNEL_IDS) at startup
2. If token/chatIds missing → module becomes no-op (no errors)
3. On BUY:  broadcast 🟢 BUY {symbol} with entry, qty, notional, SL/TP, balance, order id
4. On SELL: broadcast 🔴 SELL {symbol} with entry/exit, P&L, duration, reason, balance, note
5. On startup: broadcast 🤖 Bot Started with mode, timeframe, slots, min confidence, enabled filters
6. Triggers: cycle trades, risk-loop closes, manual closes
```

---

## Dashboard API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/status` | Full dashboard summary (positions, metrics, signals) |
| GET | `/api/signals` | Current signal feed |
| GET | `/api/signal-history` | Paginated signal history (`page`, `pageSize`, `symbol`, `decision`) |
| GET | `/api/trades` | Trade history from `dashboard_persist.json` |
| GET | `/api/daily-pnl` | Daily P&L breakdown (realized + unrealized) |
| GET | `/api/health` | Uptime, cycle count, version |
| GET | `/api/symbols` | Configured symbol list |
| GET | `/api/strategies` | Strategy registry |
| GET | `/api/candles` | Cached candles for a symbol |
| GET | `/api/deposits` | Deposit list |
| POST | `/api/deposits` | Add deposit entry |
| DELETE | `/api/deposits/:id` | Remove deposit entry |
| POST | `/api/backtest` | Run on-demand backtest |
| POST | `/api/close-position/:symbol` | Manual position close |
| POST | `/api/refresh-balance` | Trigger immediate position sync + balance update |
| POST | `/api/smoke-test` | Run connectivity smoke test |
| GET | `/api/logs` | Log tail (filtered, paginated) |
| GET | `/stream` | SSE event stream (cycle updates, heartbeat) |

### Local Mode (Docker / bare metal)

| File | Format | Contents |
|------|--------|----------|
| `data/dashboard_persist.json` | JSON | Dashboard state (positions, signals, trades) |
| `data/position_state.json` | JSON | Per-position stop-loss, HWM, entry price (survives restarts) |
| `data/signal_history.json` | JSON | Full signal decision history (max 5000 entries, paginated via API) |
| `data/deposits.json` | JSON | Deposit tracker entries (gitignored, runtime-only) |
| `data/filtered_optimization_results.json` | JSON | Per-symbol optimizer results (9 pass, 5 fail from latest run) |
| `data/candles/*.json` | JSON | Cached OHLCV data (12h, 15m, 4h) |
| `logs/trades.csv` | CSV | Full trade journal |
| `logs/app-YYYY-MM-DD.log` | JSON lines | Runtime log (DailyRotateFile, 50 MB/file, 30 d retention) |

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
│   ├── initialBalance, maxPositionPct, stopLossPct, takeProfitPct
│   ├── breakEvenTriggerPct, maxDailyLossPct, maxConcurrentPositions (4)
│   ├── minConfidence, confidenceThresholdScale (0.65, Phase-4 → 1.0)
│   ├── atrStops{} (disabled), twoStageExit{} (disabled)
│   └── weeklyDDBreaker{}, positionAgingExit{}
├── perSymbol{}            Per-symbol strategies + SL/TP + minConfidence (optimizer-tuned)
├── correlation{}          Correlation cap on new entries (enabled, threshold 0.85)
├── signals{}              minConfidence, multiBarConfirmation, external signal config
├── macroFilter{}          BTC EMA(200) bear detection
├── mtfFilter{} / mtf4hFilter{}  15m alignment + 4h momentum filter params
├── confSizing{} / regimeSizing{}  Confidence- and ADX-proportional sizing
├── regimeClassifier{}     EMA/ADX periods + hysteresis bars
├── bearPolicy{}           Cash-exit on BEAR_TREND (mode: trend_only)
├── regimeRouting{}        Regime→strategy bundles (disabled)
├── tsmCore{}              Majors trending sleeve (paper-only, default OFF)
│   ├── symbols[]          Core holdings (default ['BTC/USDC','ETH/USDC'])
│   ├── lookbackBars[]     Trailing-momentum windows (default [60,90,120] = 30/45/60 days)
│   └── deploymentPct      Sleeve share of equity (default 0.5)
├── btcDominance{}         BTC.D entry gate (CoinGecko)
└── fearGreed{}            Fear & Greed entry-threshold modulator
```

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| 12h timeframe | Strategies need multi-day patterns; 4h too noisy (38% WR) |
| Confidence-weighted voting | Uses each strategy's confidence as its vote weight; HOLD counted in the denominator so `minConfidence` is granular (2/3 ≠ 3/3) |
| Aggregator parity-locked | One pure `aggregateVotes()` shared by live/backtester/optimizer; fixture-enforced |
| Deflated Sharpe gate | Corrects for the optimizer's ~16k-trial search burden; honest significance bar |
| 4 slots | Per-trade capital vs diversification; DD stays well inside the safety margin |
| Next-open fills | No execution lookahead — realistic fill simulation |
| Tiered slippage | Large caps 0.10%, mid 0.20%, micro 0.35% |
| Fixed SL/TP over trailing | Trailing gives back profits on retracements |
| Market orders | Guaranteed fill; slippage acceptable on 12h timeframe |
| No database | JSON files sufficient for <100 trades/month; simple backup (git) |
| Position state persistence | SL/HWM/entry saved to disk on every change; survives restarts without losing break-even protection |
| DailyRotateFile logging | 50 MB max per file, 30-day retention; dashboard reads today's dated file with 512 KB tail for speed |
| OCO for Lambda | Exchange handles exits 24/7 without running process |
| TSM core positions (#core keys) | Coexist with scalper on same asset; `isCore: true` flag excludes them from risk-loop, correlation cap, daily-loss accounting (ring-fenced sleeve) |
| Candle cache merge-preserving | `saveCachedCandles` keeps disk bars strictly older than payload's first timestamp; empty payload no-ops (preserves deep research history) |

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

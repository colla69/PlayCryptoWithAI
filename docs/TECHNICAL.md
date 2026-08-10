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
| TSM Core | `engine/tsmCore.js` | Majors trending-sleeve engine (slow-in momentum vote, vol targeting, resize planning); pure functions |
| NASDAQ Trend | `data/nasdaqTrend.js` | FRED daily NASDAQ feed (keyless, 12h cache) + equity risk-off computation for the core sleeve |
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
| Candle Freshness | `utils/candleFreshness.js` | Timeframe parsing + frozen-series detection (live guard, backtest stale-data warning) |
| Cycle Scheduler | `core/cycleScheduler.js` | Candle-close alignment; re-derives each fire time from the clock so the loop can't drift |
| MTF Alignment | `utils/mtfAlignment.js` | 15m and 4h filter scoring |
| Indicators | `utils/indicators.js` | EMA, ATR, ADX, RSI, Bollinger, etc. |
| Correlation | `utils/correlation.js` | Pearson correlation matrix builder |
| Logger | `utils/logger.js` | Winston logger + CSV trade appender |
| Dashboard | `dashboard/dashboardServer.js` | Express API, SSE, deposits CRUD, performance (TWR), dated log reader (512KB tail) |
| Equity History | `dashboard/equityHistory.js` | Append-only daily equity snapshots (one row per UTC day) |
| Time-Weighted Return | `utils/timeWeightedReturn.js` | Chain-linked return that cancels out deposits/withdrawals |
| Cycle Watchdog | `monitor/cycleWatchdog.js` | Deadman alert: Telegram fires when no cycle completes within 1.15× the candle period (the July 2026 18h stall produced zero alerts) |
| Webhook Auth | `signals/webhookServer.js` | External signals VOTE in the live aggregator — server refuses to start without `WEBHOOK_TOKEN` and 401s requests missing `x-webhook-token` (off by default since 2026-07-29) |
| Dashboard State | `dashboard/dashboardState.js` | In-memory state for SSE broadcasts; also holds the candle series every strategy analyses — the merge is **payload-wins** so a forming bar is corrected, never frozen |
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
| `repairPhantomState.mjs` | One-shot ops repair (2026-08-03 incident): strip the phantom scalper position that absorbed the core sleeve's ETH from state/trade/equity files. Bot stopped; dry-run by default, `--apply` to write; idempotent, refuses to write if files don't match the incident state |
| `repairFrozenCoreEquity.mjs` | One-shot ops repair (2026-08-10 incident): rewrite the 08-04→08-09 `equity_history.json` snapshots frozen by the unmarked core legs, from verified Binance 1m closes. Bot stopped; dry-run by default, `--apply` to write; idempotent, writes `.bak` |

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

## Measuring performance once you deposit regularly

`/api/performance` returns two numbers because they answer different questions and
diverge as soon as contributions become regular:

- **`twrPct` — time-weighted return.** Chains growth *between* cash flows, so deposits and
  withdrawals cancel out. This measures the strategy. It is what the dashboard shows.
- **`simplePnl` / `simpleReturnPct` — money-weighted.** `equity − netContributions`. This
  measures your wealth, and moves purely because of a deposit's size and timing.

The dashboard previously showed only the money-weighted figure labelled "True ROI", which is
misleading under dollar-cost-averaging: deposit into a flat strategy and it swings; make a large
late deposit into a losing one and the loss looks mild. With a single funding deposit and no
further flows the two are identical — they only separate once you contribute more than once.

TWR needs a portfolio valuation immediately before each cash flow, which nothing recorded
(trades carry a balance but are rare — ~30/year on this config). `dashboard/equityHistory.js`
now appends one snapshot per UTC day from the main cycle, so it accrues in paper and live alike.

## Data Flow

### Trading Cycle (every 12h candle close)

```
0. Cycle fires at candle close + 3s, then re-derives the NEXT fire time from the
   wall clock (core/cycleScheduler.js). No fixed setInterval — a slow or stalled
   cycle costs that cycle, never the alignment.

1. MTF candles served from in-memory cache (refreshed every 15m / 4h)
   12h candles fetched fresh from Binance and merged into history cache
   → series older than maxCandleStalenessPeriods (24h) ⇒ symbol skipped

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

8. TSM Core Cycle (if `TSM_CORE=true`; paper simulates, LIVE places real market orders):
   runTsmCoreCycle() reads closed 12h candles from dashboardState (no lookahead)
   For each core symbol: computeTsmVote(trailing momentum) → majority vote
   If vote flips: openCorePosition / closeCorePosition → position tracked with isCore flag
   Core positions excluded from risk-loop SL/TP, correlation cap, daily-loss accounting
   (the fast risk loop still marks their price each pass — valuation only, never stops)
   Failed vote-flip closes → Telegram alert + retry via fast risk loop (live only)
```

### Fast Risk-Check Loop (every 2 min)

```
1. For each open position:
   fetchTicker(symbol) → current price
2. Evaluate: trailing stop, break-even, stop-loss, take-profit
3. If triggered → market sell, update dashboard, persist state
4. Reduces market exposure window from 12h to ~2 min
5. TSM core positions get NO stop evaluation, but they are still marked-to-market
   every pass: checkRisk() is the only writer of position.currentPrice, and skipping
   core legs froze the getStatus() valuation at the restore price — the dashboard
   looked right (it overrides prices from its own map) while equity_history.json,
   the sleeve's HWM ladder and every %-of-equity gate read a stale number
6. After marking, a vote-flip close that failed on the exchange is retried —
   every cycle until it fills
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
0. Core sleeve claims FIRST (calcCoreClaims, executor/traderUtils.js): every core
   leg — persisted AND already live in memory — reserves the wallet coins it owns,
   clamped to the free balance, before the scalper restore below may attribute
   anything. In-memory legs never enter the restore loop but own their coins all
   the same; omitting them let the scalper claim the sleeve's own ETH as a
   phantom position (observed live 2026-08-03, equity inflated ~25%)
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
| GET | `/api/performance` | Time-weighted return + simple P&L (see below) |
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
| `data/equity_history.json` | JSON | One equity snapshot per UTC day; the valuation series TWR needs |
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

### 1b. TSM core sleeve on the live bot

```bash
# in the live container's environment (docker-compose.yml or .env):
TSM_CORE=true
docker compose up -d --build
docker logs -f <container> 2>&1 | grep TSM-CORE   # watch sleeve cycles
```

The sleeve runs inside the main bot process — no separate container. In
`PAPER_MODE` it simulates; on the LIVE bot it places **real market orders**
sized to `tsmCore.deploymentPct` of the account (default 50%), so enabling
`TSM_CORE` on live is a deliberate capital-deployment decision. Expect
`[TSM-CORE]` log lines each 12h cycle (votes, vol fraction, macro risk-on/off)
and `🧲 tsm-core`-tagged trades once momentum turns positive. Core positions
have **no SL/TP** — the only exit is the momentum-vote flip; a close that fails
on the exchange fires a Telegram alert and is retried by the fast risk loop
every ~2 min until it fills. The same loop marks each core leg to market every
pass (valuation only — no stop is ever evaluated), which keeps
`data/equity_history.json` and the sleeve's HWM ladder honest. Core positions
restore across restarts from `data/position_state.json` (`qty` + `isCore` are
persisted); on restore, core legs reserve their wallet coins first
(`calcCoreClaims`) so the scalper can only attribute what is genuinely left.

(The former `docker-compose.soak.yml` paper-soak container is retired — real-money
operation replaced it as the source of operational truth. `data-soak/`/`logs-soak/`
dirs on hosts that ran it can be deleted.)

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
├── tsmCore{}              Majors trending sleeve (paper & live, default OFF)
│   ├── symbols[]          Core holdings (default ['BTC/USDC','ETH/USDC'])
│   ├── lookbackBars[]     Trailing-momentum windows (default [60,90,120] = 30/45/60 days)
│   ├── enterVotes         Positive votes to OPEN (default 3 — slow-in hysteresis)
│   ├── stayVotes          Positive votes to KEEP (default 2)
│   ├── deploymentPct      Sleeve share of equity (default 0.5)
│   ├── volTarget          Annualised vol target — slot × min(1, target/realized) (default 0.6)
│   ├── volWindowBars      Realized-vol window (default 60 = 30 days)
│   ├── minFraction        Vol-fraction floor (default 0.2)
│   ├── resizeThresholdPct Drift rebalance trigger, share of slot (default 0.15)
│   └── macroOverlay{}     Equity risk-off: ×riskOffFactor while NASDAQ < EMA(emaDays)
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
| TSM core positions (#core keys) | Coexist with scalper on same asset; `isCore: true` flag excludes them from risk-loop stops, correlation cap, daily-loss accounting (ring-fenced sleeve). The risk loop still marks their price each pass, and on restore core legs reserve their wallet coins before scalper attribution (`calcCoreClaims`) |
| Candle cache merge-preserving | `saveCachedCandles` keeps disk bars strictly older than payload's first timestamp; empty payload no-ops (preserves deep research history) |
| In-memory candle merge payload-wins | `dashboardState.updateCandles` lets the fresh exchange payload overwrite any overlapping timestamp. The old first-wins merge froze the forming candle captured mid-cycle and discarded its closed version, silently corrupting every indicator downstream and breaking live ≡ backtest (2026-07 soak: TIA scored CCI 49.1 live vs 76.7 in the backtester on identical on-disk data) |

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

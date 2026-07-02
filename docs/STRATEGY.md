# Strategy Documentation

Complete description of the trading strategy used by playAIStocks.

> **Robustness overhaul (branch `do_it_again_better`):** the engine was reworked to favour
> honest, statistically-defensible performance and low drawdown over headline CAGR. This document
> reflects that current state. Performance numbers below come from the committed baseline run
> (`src/scripts/runBaseline.mjs`), not from the inflated pre-overhaul figures.

---

## Overview

The bot trades **37 USDC spot pairs** on Binance using a **multi-strategy voting engine** on 12h
candles. Entries require consensus from multiple technical indicators, validated by multi-timeframe
filters, cross-asset context, and a BTC regime gate. Exits are rule-based (stop-loss, take-profit,
break-even, strategy SELL, position aging).

**Core philosophy:** robustness first — high-conviction entries through confidence-weighted
consensus + strict, portfolio-level downside protection. Capital preservation is prioritised over
absolute return (the bot is built to run unattended for a long time).

---

## Signal Generation

### Strategy Voting

**20 technical strategies** independently analyse each 12h candle and vote `BUY`, `SELL`, or `HOLD`.
The first 15 are classical TA; the last 5 (Phase 2) add deliberately orthogonal signal bases
(breakout, volume-weighted basis, participation, multi-component cloud, price action).

| # | Strategy | Indicator | BUY Signal | SELL Signal |
|---|----------|-----------|------------|-------------|
| 1 | RSI | RSI(14) | Oversold + turning up | Overbought + turning down |
| 2 | Bollinger Bands | BB(20,2) | Price at lower band | Price at upper band |
| 3 | CCI | CCI(20) | Below -100, reversing | Above +100, reversing |
| 4 | EMA | EMA crossover | Fast > Slow | Fast < Slow |
| 5 | MACD | MACD(12,26,9) | Histogram crossover up | Histogram crossover down |
| 6 | ADX | ADX(14) + DI | +DI > -DI with ADX > 20 | -DI > +DI with ADX > 20 |
| 7 | Stochastic | Stoch(14,3,3) | %K crosses above %D in oversold | %K crosses below %D in overbought |
| 8 | StochRSI | StochRSI(14) | Oversold crossover | Overbought crossover |
| 9 | MFI | MFI(14) | Below 20 (money flow oversold) | Above 80 (money flow overbought) |
| 10 | OBV | OBV + EMA | OBV trending above its EMA | OBV trending below its EMA |
| 11 | PSAR | Parabolic SAR | SAR flips below price | SAR flips above price |
| 12 | Williams %R | WR(14) | Below -80, reversing | Above -20, reversing |
| 13 | Supertrend | ATR-based trend | Price breaks above supertrend | Price breaks below supertrend |
| 14 | Heikin-Ashi | HA candles | Bullish reversal pattern | Bearish reversal pattern |
| 15 | Support & Resistance | S/R levels | Price bounces off support | Price rejected at resistance |
| 16 | Donchian | 20-bar channel | Close > 20-bar high + volume confirm | Close < 20-bar low |
| 17 | VWAP-σ | Anchored VWAP ± 2σ | Price ≤ VWAP − 2σ | Price ≥ VWAP + 2σ |
| 18 | Volume Surge | Vol vs 20-bar avg | Vol > 2× avg AND green candle | Vol > 2× avg AND red candle |
| 19 | Ichimoku | Cloud / Tenkan / Kijun | Cloud break up + TK cross + chikou | Cloud break down + TK cross + chikou |
| 20 | Pin Bar | Wick rejection | Bullish rejection wick at support | Bearish rejection wick at resistance |

Every strategy excludes the forming candle (closed bars only — no lookahead) and returns
`{ signal, confidence ∈ [0,1], reason }`.

### Per-Symbol Strategy Selection

Not all 20 strategies run on every coin. Each symbol has an optimised subset (typically 3) plus its
own `minConfidence`, `stopLossPct`, and `takeProfitPct`, selected by the holdout-validated optimizer
(`src/scripts/perSymbolOptimizer.mjs`). The optimizer enforces **MIN_TRADES ≥ 8** on the holdout,
rejects any combo whose **deflated Sharpe < 0.5** (even when raw Sharpe is high), and applies a
small-sample shrinkage penalty — guardrails added to fight the overfitting the Phase 0 baseline
exposed. Configs live in `config/default.js` under `perSymbol` and are treated as throwaway:
they are re-derived whenever the aggregator or strategy roster changes.

### Aggregator Logic (confidence-weighted)

The pure voting math lives in `src/engine/aggregatorVoting.js` and is consumed **identically** by the
live aggregator (`src/engine/signalAggregator.js`), the `PortfolioBacktester`, and the optimizer's
`aggregate()` — a parity fixture (`tests/engine/aggregatorParity.test.js`) guarantees they never drift.

1. Each strategy contributes a **weighted vote** to its chosen direction: `vote_weight = algoWeight × confidence`. A 0.9-confidence BUY now outweighs a 0.51-confidence BUY (the old engine counted direction only and discarded the confidence field).
2. The winning direction is the largest summed `vote_weight`.
3. Reported confidence = `winner_vote_weight / total_voters`, **with HOLD votes counted in the denominator**. This fixes the prior bug where 2/3 BUY + 1 HOLD scored the same (1.00) as 3/3 unanimous BUY:
   - 3/3 BUY @ conf 1.0 → 1.00 · 3/3 BUY @ conf 0.6 → 0.60
   - 2/3 BUY @ conf 1.0 + 1 HOLD → 0.67 · 1/3 BUY + 2 HOLD → 0.33
4. If confidence < the symbol's `minConfidence` threshold → decision = HOLD (no trade).

Because this formula is stricter, the legacy per-symbol thresholds are scaled by
`risk.confidenceThresholdScale = 0.65` so the bot keeps trading at a sensible frequency. The Phase 4
retune **measured** this scale rather than assuming it: 1.0 starves the bot (≈0 trades), 0.55 worsens
drawdown, and 0.65 gives the best risk-adjusted result (confirmed forward-only on the walk-forward
harness). It is the validated calibration, not a temporary hack.

### Multi-Bar Entry Confirmation

Borderline-confidence directional signals (within ~0.10 of `minConfidence`) are suppressed to HOLD
unless the **previous bar agreed** on the same direction — this kills one-bar fakeouts. It is opt-in
via `signals.multiBarConfirmation` (ON live + backtester) and was the single biggest robustness win
on the most-out-of-sample window (last-90d Sharpe 1.15 → 2.89, DD −22% → −10% at the time it shipped).
Exits are unaffected: the asymmetric exit reads raw votes, so a borderline SELL on an open position
is still rescued.

### Asymmetric Exit Threshold

For positions already open, SELL signals get a **30% lower confidence bar** (`entry × 0.7`). It's
easier to get out than to get in — the bot exits losing positions even on moderate SELL conviction.

---

## Market Regime (Phase 4)

A **BTC regime classifier** (`src/engine/regimeClassifier.js`) labels the market from BTC candles
into a 2×2 grid, with **3-bar hysteresis** to avoid flip-flop:

| Regime | Condition |
|---|---|
| `BULL_TREND` | BTC close > EMA200 **and** ADX(14) ≥ 25 |
| `BULL_RANGE` | BTC close > EMA200 **and** ADX(14) < 25 |
| `BEAR_TREND` | BTC close < EMA200 **and** ADX(14) ≥ 25 |
| `BEAR_CHOP`  | BTC close < EMA200 **and** ADX(14) < 25 |

**Bear policy (Phase 6a — cash-exit on bear):** when the regime transitions **into `BEAR_TREND`**,
all open positions are closed on that bar and new entries are blocked until the regime leaves
`BEAR_TREND`. `BEAR_CHOP` (sideways) is *not* blocked — mean-reversion still works there; blocking it
was measured as too costly. This replaces the old "halve size in bear" approach with an actual
cash-out on confirmed downtrends. Config: `bearPolicy` (`mode: 'trend_only'`).

**Regime routing** (regime-conditional strategy bundles, `src/engine/regimeRouter.js`) is shipped as
infrastructure but **default OFF** (`regimeRouting.enabled = false`). A 2026-06 deep-data study refuted
the core premise (the trend-alignment filters block mean-reversion, so "different archetype per regime"
isn't viable as built) and found the infra has latent bugs — leave OFF unless re-engineered. The viable
regime lever is **exposure** (regime-conditional sizing), not strategy swapping — untested.

Both live (`main.js`) and the backtester consume the same `RegimeTracker` — no behavioural divergence.

---

## Cross-Asset Context (Phase 3)

`src/data/marketContext.js` adds signals the bot was previously blind to (on-disk cached so the
backtester can replay them deterministically):

- **BTC Dominance gate** — BTC.D from CoinGecko (keyless). When the 7-day SMA of dominance is rising
  hard, alt entries are blocked (alts crash when dominance spikes). No-ops until 7 days of data exist.
- **ETH/BTC ratio** — from Binance public spot; a *sizing* multiplier on alts (altseason on/off), not
  a hard gate.
- **Fear & Greed modulator** — `data/fearGreed.json` (1000 daily samples). Extreme greed (>80)
  tightens `minConfidence` by +0.05; extreme fear (<20) relaxes it by −0.05 (contrarian).

Every cross-asset feed is optional with a neutral fallback — the bot keeps trading on local Binance
data alone if an external source is unavailable.

---

## Entry Filters

Every BUY signal must pass a cascade before execution:

1. **Bear-regime block** (Phase 6a) — no new entries while regime is `BEAR_TREND`.
2. **Max positions** — 4 concurrent slots (`maxConcurrentPositions`); excess BUYs are queued.
3. **Daily loss limit** — cumulative daily P&L < −5% blocks new trades for the day.
4. **Weekly DD circuit breaker** (Phase 7) — rolling 7-day P&L ≤ −10% pauses new entries for 72h.
5. **Portfolio correlation cap** (Phase 7) — block a BUY if it would open a position with rolling
   60-day correlation > 0.85 to an existing one (a hard cap on the new entry, not a reroute).
6. **15m MTF alignment** — recency-weighted score over the last 16×15m candles; < 0.30 blocks entry
   (relaxed from 0.50 in 2026-06: once all 37 symbols had 15m data the filter became portfolio-wide and
   0.50 was too tight; forward-only walk-forward confirmed the relaxation lifts Sharpe 1.01→1.50).
7. **4h momentum** — EMA(8) vs EMA(21) spread (60%) + RSI(14)/100 (40%); < 0.45 blocks entry.
8. **Momentum-leader** (2026-06-25) — require trailing 20-bar (10-day) return ≥ 0; blocks "falling-knife"
   buys (oversold dips in downtrends). Shared `utils/momentum.js` keeps live ≡ backtest. Forward-only WF:
   Sharpe 1.50→1.60, DSR 0.11→0.18, WR 60→70%.
9. **BTC.D gate / Fear & Greed modulator** — see Cross-Asset Context.
10. **Minimum confidence** — per-symbol threshold (× `confidenceThresholdScale` for now).

---

## Position Sizing

Multiplicative chain: `Final = Base × ATR × Confidence × Regime × Macro` (× ETHBTC on alts).

- **Base** — `maxPositionPct = 0.15` of available balance.
- **ATR scaling** — volatility-normalised vs the portfolio median ATR%.
- **Confidence scaling** — conf ≥ 0.65 → 1.0×–1.5×; conf < 0.65 → 0.6×–1.0×.
- **Regime sizing (ADX)** — ADX ≥ 25 → ×1.3; ADX < 15 → ×0.5; otherwise ×1.0.
- **Macro bear filter** — BTC below EMA200 → ×0.5 (now largely superseded by the bear-regime
  cash-exit, but retained as a sizing backstop).

---

## TSM Core Sleeve (experimental, paper-only, default OFF)

**Shipped infrastructure for majors trend-following:** a parallel core portfolio (BTC/ETH/BNB/SOL 
variants possible, default BTC+ETH) sized as a fixed sleeve (default 50% of equity, split equally) 
that holds LONG only while trailing momentum is positive. Exits ONLY on vote flip (reason 
`tsm_core_flip`) — no stop-loss, take-profit, break-even, or aging exit. Enabled via `TSM_CORE=true` 
env var; **paper-mode only** — enabling in live mode logs a warning and no-ops.

**The rule:** `computeTsmVote()` counts positive trailing-momentum votes on three lookback windows 
(default 60/90/120 bars = 30/45/60 days on 12h), with **slow-in hysteresis**: OPEN only when all 3 
votes are positive (`enterVotes: 3`), HOLD while ≥2 stay positive (`stayVotes: 2`), CLOSE below 
that. Validated on 9yr USDT data incl. the 2018 + 2022 bears: vs the symmetric 2-of-3 vote it 
raises Sharpe (0.93→1.04 BTC+ETH) and cuts round trips ~3×. Position key is `'<symbol>#core'` 
(e.g. `BTC/USDC#core`) with `isCore: true` flag, coexisting with the scalper's positions on the 
same asset.

**Portfolio treatment:** core positions are excluded from:
- Stop-loss/take-profit/break-even/aging (only exit trigger is vote flip)
- Portfolio correlation cap (don't block a new core entry or penalise it)
- Daily-loss accounting (core sleeve is ring-fenced, doesn't block scalper trades)
- Risk-loop SL/TP management (PaperTrader early-returns on core positions)

Trades tagged `note: '🧲 tsm-core'`.

**Rationale & performance:** 
time-series momentum is the defensible edge found in this codebase's data. On the full 6-year 
window (2020-06-27 → 2026-07-02, 4,066 candles), the vote BTC+ETH sleeve returns +596% / Sharpe 
0.99 / DD −52% vs +582% / 0.85 / −77% for equal-weight B&H of the same coins — captures upside, 
cuts the bear tail. DSR 0.72 (robust across 15–90d lookbacks on both universes tested — a plateau, 
not luck). Matches the crypto literature on TSM. See `docs/TREND_CORE_STUDY.md` for the full study 
and start-date sensitivity: it beats same-universe B&H on return/Sharpe/DD from every walk-in date 
tested (including the exact 2021 top), but absolute return still requires the asset class to go up.

**Caveat:** In-sample only — 2026 YTD the sleeve is ~−9% (Q1 chop whipsaws). Real drawdowns are 
−40/−60% at full deployment; sizing is a Sharpe-neutral risk dial. This is "smart beta" (captures 
asset-class upside, not alpha); infrastructure is shipped, operator chooses whether/when to 
activate and how much capital to allocate.

**Sizing (combo rule):** each slot is `deploymentPct/n × volFraction × macroFactor` —
vol targeting (`min(1, volTarget/realized 30d vol)`, floor 0.2, no leverage) times the equity
risk-off overlay (×0.5 while the NASDAQ Composite is below its 100d EMA; FRED keyless feed with
12h cache, neutral on fetch failure). Held positions drift-rebalance when they deviate >15% of
their slot (`resizeCorePosition`, partial fills carry post-state for restart restore). Full combo
on the 9yr study: Sharpe 1.27, DD −36%, DSR 0.94 — see `docs/TREND_CORE_STUDY.md`.

Implementation: `src/engine/tsmCore.js` (pure functions), `src/data/nasdaqTrend.js` (macro feed), 
`src/main.js` orchestration (`runTsmCoreCycle`), PaperTrader additions (`openCorePosition`, 
`closeCorePosition`, `resizeCorePosition`).

---

## Exit Rules

- **Stop-Loss** — per-symbol fixed % (3–8%, default 5%). *(ATR-derived stops exist as infrastructure
  but are **disabled** — A/B testing showed them net-negative vs the well-tuned per-symbol stops.)*
- **Take-Profit** — per-symbol fixed % (8–30%, default 12%).
- **Break-Even Stop** — at +5% unrealised, SL moves to entry. Once per position. Persisted to
  `data/position_state.json` (survives restarts).
- **Strategy SELL** — aggregator SELL above the asymmetric exit threshold closes the position.
- **Position aging exit** (Phase 7) — positions open > 14 bars (7 days) without hitting TP/SL are
  closed to free capital.
- **Two-stage exit** — partial-close + break-even-on-runner infrastructure exists but is **disabled**
  (tested −8pp return / −0.1 Sharpe under current tuning).

---

## Validation Framework (Phase 8)

Every change is measured honestly before it ships:

- **Baseline runner** (`runBaseline.mjs`) — full live filter stack across multiple windows
  (last 90d / 180d / Y2 365d / full history) plus stress windows where data allows.
- **Deflated Sharpe (DSR)** — Bailey & López de Prado (2014), corrects the observed Sharpe for the
  optimizer's multiple-testing burden (~16k implicit trials). DSR ≥ 0.95 = significant; < 0.50 =
  indistinguishable from data-dredging noise.
- **Walk-forward harness** (`runWalkForward.mjs`) — forward-only equity concatenation for honest
  out-of-sample numbers.
- **Monte Carlo trade shuffle** — SE bands on Sharpe / MaxDD / return; rejects fragile changes.
- **Stress stoplight** (`runBaseline.mjs --stoplight`) — runs the standard + natural BTC-drawdown
  windows and assigns each a 🟢/🟡/🔴 verdict (🔴 if DD ≤ −15% or Sharpe < 0.8). Exits non-zero on
  red so it can gate CI. Current overall: 🟢 GREEN.
- **Live drift monitor** (`src/monitor/driftMonitor.js`) — each cycle compares the rolling 30-day
  live per-trade Sharpe against the backtest reference and warns when they diverge beyond 2 standard
  errors (Lo 2002). Log-only until `monitor.driftRefSharpe` is configured.

**Cardinal rule:** if a change worsens risk-adjusted metrics vs the committed baseline, it is
**reverted, not patched**.

---

## Backtested Performance (honest baseline, full filter stack)

Committed baseline, 37 USDC pairs, 12h candles, BUY-at-next-open, tiered slippage
(large 0.10% / mid 0.20% / micro 0.35%):

| Window | Return | Sharpe | Sortino | Max DD | Win Rate | PF | DSR | PSR |
|--------|--------|--------|---------|--------|----------|----|----|----|
| last_90d (most OOS) | +15.3% | 3.04 | 7.09 | −4.44% | 53% | 2.51 | 0.00 | 0.96 |
| last_180d | +58.4% | 2.25 | 16.95 | −3.01% | 56% | 6.69 | 0.00 | 1.00 |
| y2_365d (in-sample) | +23.1% | 1.34 | 8.79 | −3.70% | 45% | 4.28 | 0.00 | 1.00 |
| full_history (386d) | +24.6% | 1.32 | 8.62 | −3.71% | 40% | 4.14 | 0.00 | 1.00 |

**Reading it honestly:** drawdown is now under 5% on every window (the user's top priority), and PSR
is ~1.0 (true Sharpe almost certainly positive). DSR is still 0.00 — after correcting for the
optimizer's search burden, the observed Sharpe (~1.3 on the long windows) has not yet cleared the
significance bar (~3.3 annualised). Lifting DSR is the goal of the remaining phases (walk-forward
retune, regime routing, meta-overlay). The pre-overhaul README claims (+152%/yr, Sharpe 2.33,
+1912% over 2y) were not reproducible on the on-disk data and are disregarded.

---

## What Was Tested & Decided

| Enhancement | Result | Decision |
|-------------|--------|----------|
| Confidence-weighted aggregator + multi-bar gate | DD nearly halved, WR up on most-OOS window | **Shipped** |
| Portfolio correlation cap (hard entry cap @ 0.85) | Better Sharpe *and* tighter DD with the new aggregator | **Shipped (ON)** — reverses the old "rejected" verdict |
| Weekly DD breaker + position aging exit | DD cut further, well inside safety margin | **Shipped (ON)** |
| Cash-exit on `BEAR_TREND` (not `BEAR_CHOP`) | last_180d DD −5.9% → −2.9%, small return cost | **Shipped (trend_only)** |
| ATR-based stops | Net-negative vs tuned per-symbol fixed stops on every window | **Infra kept, disabled** |
| Two-stage exit / chandelier runner | −8pp return, −0.1 Sharpe under current tuning | **Infra kept, disabled** |
| Regime archetype routing (trend pack in bull, mean-reversion in chop) | **Refuted (2026-06, deep 6yr data):** the trend-alignment filters (4h+15m MTF) structurally block mean-reversion entries (0 trades), and MR isn't range-specialized anyway. Routing infra also has latent bugs (dead code, unregistered strategy keys). | **Not viable as-is; infra stays OFF** |
| Logistic-regression meta-overlay (P(win) gate) | Held-out gate-admitted WR 12.5% vs 39.5% base (−27pp) — does not beat baseline on 376 samples | **Trainer + gate shipped, default OFF** |
| **15m MTF relaxation 0.50 → 0.30** (deep 6yr data) | Full 15m coverage made the filter portfolio-wide; 0.50 too tight. Forward-only WF Sharpe 1.01→1.50, DSR 0.01→0.11 | **Shipped (ON)** |
| **Momentum filter** (buy only positive 10-day trailing return — no falling knives) | Forward-only WF Sharpe 1.50→1.60, DSR 0.11→0.18, WR 60→70%, PF 4.7→6.6 | **Shipped (ON)** — live + backtest via shared `utils/momentum.js` (2026-06-25) |
| "Ride winners" (kill fixed TP + lift aging, trail the stop) | Looked great windowed (+167%/6yr) but **failed forward-only** (DSR 0.02 < relaxed-MTF baseline) | **Infra kept, disabled** |
| Deployment / position-size sweep | Pure **Sharpe-neutral risk dial** — scales return *and* DD ~linearly; not an edge | **No change (informational)** |
| Trailing stop (replace TP) | Gives back profit on retracements | Rejected (pre-overhaul) |
| More slots (5–8) | Dilutes capital, no DD benefit | Rejected (pre-overhaul) |

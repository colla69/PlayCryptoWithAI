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
| 4 | EMA | EMA crossover | Fast crosses above Slow | Fast crosses below Slow |
| 5 | MACD | MACD(12,26,9) | Histogram crossover up | Histogram crossover down |
| 6 | ADX | ADX(14) + DI | +DI > -DI with ADX ≥ 25 | -DI > +DI with ADX ≥ 25 |
| 7 | Stochastic | Stoch(14,3,3) | %K crosses above %D in oversold | %K crosses below %D in overbought |
| 8 | StochRSI | StochRSI(14) | Oversold crossover | Overbought crossover |
| 9 | MFI | MFI(14) | Below 20 (money flow oversold) | Above 80 (money flow overbought) |
| 10 | OBV | OBV + EMA | OBV crosses above its EMA | OBV crosses below its EMA |
| 11 | PSAR | Parabolic SAR | SAR flips below price | SAR flips above price |
| 12 | Williams %R | WR(14) | Below -80, reversing | Above -20, reversing |
| 13 | Supertrend | ATR-based trend | Price breaks above supertrend | Price breaks below supertrend |
| 14 | Heikin-Ashi | HA candles | Bullish reversal pattern | Bearish reversal pattern |
| 15 | Support & Resistance | S/R levels | Price bounces off support | Price rejected at resistance |
| 16 | Donchian | 20-bar channel | Close > 20-bar high + volume confirm | Close < 20-bar low |
| 17 | VWAP-σ | Rolling 20-bar VWAP ± 2σ | Price ≤ VWAP − 2σ | Price ≥ VWAP + 2σ |
| 18 | Volume Surge | Vol vs 20-bar avg | Vol > 2× avg AND green candle | Vol > 2× avg AND red candle |
| 19 | Ichimoku | Cloud / Tenkan / Kijun | Price above cloud + Tenkan > Kijun (fresh TK cross adds confidence) | Price below cloud + Tenkan < Kijun (fresh TK cross adds confidence) |
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

> **The scale must reach every gate.** Live evaluates a threshold twice — the aggregator forces HOLD
> below it, then `riskManager.canTrade()` re-gates — so both reads go through
> `scaleMinConfidence()` (`src/utils/strategyBuilder.js`). They used to disagree: `getRiskForSymbol()`
> returned the **raw** value, the stricter gate silently won, and live ran at an effective scale of
> 1.0 — the starved case above. The 2026-07-02 → 07-29 live soak took **zero trades in 27 days**
> (15 BUY signals, all blocked; three of them purely by this gate after clearing every other filter)
> while the backtester reported the committed baseline. `tests/utils/confidenceThresholdParity.test.js`
> now pins the two gates together.

### Multi-Bar Entry Confirmation

Borderline-confidence directional signals (within ~0.10 of `minConfidence`) are suppressed to HOLD
unless the **previous bar agreed** on the same direction — this kills one-bar fakeouts. It is opt-in
via `signals.multiBarConfirmation` (ON live + backtester) and was the single biggest robustness win
on the most-out-of-sample window at the time it shipped ([measurements](MEASUREMENTS.md#what-was-tested-and-decided)).
Exits are unaffected: the asymmetric exit reads raw votes, so a borderline SELL on an open position
is still rescued.

### Asymmetric Exit Threshold

For positions already open, SELL signals get a **30% lower confidence bar** (`entry × 0.7`). It's
easier to get out than to get in — the bot exits losing positions even on moderate SELL conviction.
It applies only when the aggregator returned HOLD, more than half of the strategies vote SELL, and the
confidence is ≥ 0.7 × the symbol's scaled `minConfidence` (`resolveDecision`, `src/core/decisionCore.js`).

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
cash-out on confirmed downtrends. Config: `bearPolicy` (`restrictTo: 'trend_only'`).

**Regime routing** (regime-conditional strategy bundles, `src/engine/regimeRouter.js`) is shipped as
infrastructure but **default OFF** (`regimeRouting.enabled = false`). A 2026-06 deep-data study refuted
the core premise (the trend-alignment filters block mean-reversion, so "different archetype per regime"
isn't viable as built) and found the infra has latent bugs — leave OFF unless re-engineered. The viable
regime lever is **exposure** (regime-conditional sizing), not strategy swapping — untested.

Both live (`src/core/engine.js`) and the backtester consume the same `RegimeTracker` — no behavioural divergence.

---

## Cross-Asset Context (Phase 3)

`src/data/marketContext.js` adds signals the bot was previously blind to (on-disk cached so the
backtester can replay them deterministically):

- **BTC Dominance gate** — BTC.D from CoinGecko (keyless). When the 7-day SMA of dominance is rising
  hard, alt entries are blocked (alts crash when dominance spikes). No-ops until 7 days of data exist.
- **ETH/BTC ratio** — from Binance public spot; a *sizing* multiplier on alts (altseason on/off), not
  a hard gate.
- **Fear & Greed modulator** — `data/fearGreed.json` (1000 daily samples, re-read each cycle). Extreme greed (≥80)
  tightens `minConfidence` by +0.05; extreme fear (≤20) relaxes it by −0.05 (contrarian).

Every cross-asset feed is optional with a neutral fallback — the bot keeps trading on local Binance
data alone if an external source is unavailable.

---

## Entry Filters

Every BUY signal must pass a cascade before execution. Numbering below is by topic; the order in
code is: venue veto, bear-regime block, weekly DD breaker, BTC.D gate, correlation cap, 15m MTF, 4h
momentum, momentum-leader (`src/core/decisionCore.js`), then in `riskManager.canTrade()` the
F&G-adjusted minimum confidence, max positions and daily loss limit.

0. **Fresh-data guard** — the symbol is skipped entirely (no signal, no trade) when its newest 12h
   bar is older than `maxCandleStalenessPeriods` (default 2 periods = 24h). Thin or delisted markets
   keep returning klines that never advance, and the old "did the fetch come back empty?" check
   missed that: LSK, TON and GMX each fed the aggregator a frozen series for weeks during the
   2026-07 soak, every cycle re-deriving an identical confidence. The guard covers the signal cycle,
   the startup seed, and the TSM core sleeve (`src/utils/candleFreshness.js`).
   - **Binance venue veto** (`exchangeEvents`, section E item 2 of the 2026-10 rebuild plan) — no
     new entry in a coin from the day Binance gives it a monitoring tag (until the tag is lifted)
     or announces the removal of its USDC pair or the delisting of the token; a held scalper
     position in such a coin is sold at the next cycle. After the halt the fresh-data guard skips
     the symbol before any exit runs, so a position held through a removal is stranded. In 2026
     LSK/USDC and GMX/USDC were removed with three days' notice and VANRY was delisted a month
     after its tag; TON was renamed GRAM (the bot now trades GRAM/USDC). Feed: Binance's
     announcement pages (`src/data/exchangeEventsFeed.js`, cache `data/exchangeEvents.json`,
     re-read every 4h; an outage keeps the cache). The replay reads the same file. Covers the
     scalper and the satellites (short limit-order trades on large coins, OFF by default —
     `SATELLITES=true` enables them, `config.satellites`; not part of the default live bot).
1. **Bear-regime block** (Phase 6a) — no new entries while regime is `BEAR_TREND`.
2. **Max positions** — 4 concurrent slots (`risk.maxOpenPositions`; core sleeve legs don't count);
   a BUY that arrives with every slot full is skipped, not queued. The backtester fills free slots
   from same-bar candidates in confidence order.
3. **Daily loss limit** — cumulative daily P&L < −5% blocks new trades for the day.
4. **Weekly DD circuit breaker** (Phase 7) — rolling 7-day P&L ≤ −10% pauses new entries for 72h.

Both %-limits are measured against **live account equity** (free quote + open position value,
refreshed every cycle), so they scale with deposits, withdrawals, and growth;
`config.risk.initialBalance` is only the fallback before the first balance reading.
The backtester uses the same rule against simulated equity (parity by construction).
5. **Portfolio correlation cap** (Phase 7) — block a BUY if it would open a position with rolling
   60-day correlation > 0.85 to an existing one (a hard cap on the new entry, not a reroute).
6. **15m MTF alignment** — recency-weighted score over the last 16×15m candles; < 0.30 blocks entry
   (relaxed from 0.50 in 2026-06: once all 37 symbols had 15m data the filter became portfolio-wide and
   0.50 was too tight; forward-only walk-forward confirmed it, [measurements](MEASUREMENTS.md#what-was-tested-and-decided)).
7. **4h momentum** — EMA(8) vs EMA(21) spread (60%) + RSI(14)/100 (40%); < 0.45 blocks entry.
8. **Momentum-leader** (2026-06-25) — require trailing 20-bar (10-day) return ≥ 0; blocks "falling-knife"
   buys (oversold dips in downtrends). Shared `utils/momentum.js` keeps live ≡ backtest. Confirmed
   forward-only ([measurements](MEASUREMENTS.md#what-was-tested-and-decided)).
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

## TSM Core Sleeve (experimental, default OFF — live-capable)

**Shipped infrastructure for majors trend-following:** a parallel core portfolio (BTC+ETH;
BTC+ETH+BNB+SOL only on the top equity-ladder rung) sized as a fixed sleeve (default 50% of equity, split equally) 
that holds LONG only while trailing momentum is positive. Exits ONLY on vote flip (reason 
`tsm_core_flip`) — no stop-loss, take-profit, break-even, or aging exit. Enabled via `TSM_CORE=true` 
env var; runs in **paper and live** — on the live bot it places real orders (IOC limits capped 0.5% past the price) sized to 
`deploymentPct` of the account, so enabling it is a deliberate capital-deployment decision. A 
vote-flip close that fails on the exchange fires a Telegram alert and is retried by the fast risk 
loop (~2 min) until it fills.

**The rule:** `computeTsmVote()` counts positive trailing-momentum votes on three lookback windows 
(default 60/90/120 bars = 30/45/60 days on 12h), with **slow-in hysteresis**: OPEN only when all 3 
votes are positive (`enterVotes: 3`), HOLD while ≥2 stay positive (`stayVotes: 2`), CLOSE below 
that. It beats the symmetric 2-of-3 vote on 9 years of data with ~3× fewer round trips
([measurements](MEASUREMENTS.md#tsm-sleeve-studies)). Position key is `'<symbol>#core'` 
(e.g. `BTC/USDC#core`) with `isCore: true` flag, coexisting with the scalper's positions on the 
same asset.

**Faster exit with a buy-back proof (built, OFF):** `stayVotes: 3` sells on the first negative
vote; `rebuyConfirmBars: 40` then buys a sold coin back only on a close above its 20-day high
while a majority of votes is still positive (a broken trend clears the wait). It improved the
six-year replay ([measurements](MEASUREMENTS.md#tsm-sleeve-studies)). Its checks before a switch-on
(bootstrap, simulator ↔ replay match, monthly shadow comparison by `runBuybackShadow.mjs`) are in
[the 2026-11 plan](plans/2026-11-multi-asset-trend.md). `reentryPauseHours` adds a pause after
a sell (§ L, not adopted). The wait and the last-sell times persist in
`data/tsm_sleeve_state.json` (`src/data/sleeveStateStore.js`), so a restart does not buy back early.

**Portfolio treatment:** core positions are excluded from:
- Stop-loss/take-profit/break-even/aging (only exit trigger is vote flip)
- Portfolio correlation cap (don't block a new core entry or penalise it)
- Daily-loss accounting (core sleeve is ring-fenced, doesn't block scalper trades)
- Risk-loop SL/TP management (both traders early-return on core positions before any stop
  logic; core legs are still marked to market — by `markPrice()` from the 5s price poll in
  paper and live, and by the live fast risk loop each pass. Leaving core legs unmarked froze
  the equity valuation the HWM ladder reads for six days in 2026-08. The risk loop also
  retries a failed vote-flip close)
- The scalper's `maxOpenPositions` slots (core positions have their own capital budget)

Trades tagged `note: '🧲 tsm-core'`.

**Rationale:** time-series momentum is the defensible edge found in this codebase's data. It
beats same-universe buy-and-hold on return, Sharpe and drawdown from every start date tested, and
the four-coin universe (rung C) beats BTC+ETH on every measure. **Vol targeting is load-bearing:**
without it the wider universe draws down deeper, so keep `volTarget` on. Absolute return still
needs the asset class to go up. Numbers: [MEASUREMENTS.md](MEASUREMENTS.md#tsm-sleeve-studies);
full study: `docs/TREND_CORE_STUDY.md`.

**Sizing follows an equity ladder with a high-water-mark ratchet** (`tsmCore.equityLadder`,
2026-07-29). The selector input is the account's all-time-high equity (daily snapshots in
`data/equity_history.json`, deposits included) — never current equity, which would size UP after
losses (martingale). Risk only ever steps down; after a drawdown the unchanged small fraction of a
smaller account can fall under Binance's $11 notional floor, parking the sleeve in cash until
recovery. Rungs are individually validated static profiles (never interpolated):

| Rung | HWM ≥ | Profile |
|---|---|---|
| A | $0 | 2 majors @ 0.50 |
| B | $320 | 2 majors @ 0.30 (the ~10% drawdown-budget rung) |
| C | $970 | 4 majors @ 0.20 |

Thresholds sit ~10% above each rung's floor-viability equity so a rung is never selected before it
can place an order; `sleeveFeasibility()` alerts (once per boot) when the active rung can't clear
the floor at current equity, including the equity it becomes viable from — the DCA signpost.

**Caveat:** in-sample only, and at full deployment the real drawdowns are large. This is "smart
beta" (asset-class upside, not alpha); the operator chooses whether and how much to deploy.

**Sizing (combo rule):** each slot is `deploymentPct/n × volFraction × macroFactor` —
vol targeting (`min(1, volTarget/vol)`, floor 0.2, no leverage; vol = Deribit DVOL implied vol for
BTC and ETH — `impliedVol`, section E1 of the 2026-10 rebuild plan, cache `data/dvol.json`, realized
vol when no DVOL close is under 24h old — and realized 30d vol for BNB and SOL) times the equity
risk-off overlay (×0.5 while the NASDAQ Composite is below its 100d EMA; FRED keyless feed with
12h cache, neutral on fetch failure). Held positions drift-rebalance when they deviate >15% of
their slot (`resizeCorePosition`, partial fills carry post-state for restart restore).

Implementation: `src/engine/tsmCore.js` (pure functions), `src/data/nasdaqTrend.js` (macro feed), 
`src/core/engine.js` orchestration (`runTsmCoreCycle`), PaperTrader additions (`openCorePosition`, 
`closeCorePosition`, `resizeCorePosition`).

---

## Exit Rules

- **Stop-Loss** — per-symbol fixed % (7.5–9%, default 7.5%). *(ATR-derived stops exist as infrastructure
  but are **disabled** — A/B testing showed them net-negative vs the well-tuned per-symbol stops.)*
- **Take-Profit** — per-symbol fixed % (18–45%, default 18%).
- **Break-Even Stop** — at +10% unrealised (`risk.breakEvenTriggerPct`), SL moves to entry (+0.2% for fees). Once per position. Persisted to
  `data/position_state.json` (survives restarts).
- **Strategy SELL** — aggregator SELL above the asymmetric exit threshold closes the position.
- **Position aging exit** (Phase 7) — positions open ≥ 14 bars (7 days) without hitting TP/SL are
  closed to free capital.
- **Two-stage exit** — partial-close + break-even-on-runner infrastructure exists but is **disabled**
  (net-negative when tested, [measurements](MEASUREMENTS.md#what-was-tested-and-decided)).

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
  red so it can gate CI. Current verdicts: [MEASUREMENTS.md](MEASUREMENTS.md#stress-windows).
- **Live drift monitor** (`src/monitor/driftMonitor.js`) — each cycle compares the rolling 30-day
  live per-trade Sharpe against the backtest reference and warns when they diverge beyond 2 standard
  errors (Lo 2002). Log-only until `monitor.driftRefSharpe` is configured.

**Cardinal rule:** if a change worsens risk-adjusted metrics vs the committed baseline, it is
**reverted, not patched**.

---

## Backtested Performance

All results live in [MEASUREMENTS.md](MEASUREMENTS.md): the current baseline (scalper alone and
the whole account, both candle sets, stress windows), the TSM sleeve studies, the record of what
was tested and decided, and the earlier baselines. In short (2026-11-26): the scalper is
positive on every window with drawdowns under 8%, but its deflated Sharpe stays below 0.5, so
the edge is not proven; the whole account made 18.9% a year over six years with a 6.5% worst
drop.

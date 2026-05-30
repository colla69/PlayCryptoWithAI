# Strategy Documentation

Complete description of the trading strategy used by playAIStocks.

---

## Overview

The bot trades **37 USDC spot pairs** on Binance using a **multi-strategy voting engine** on 12h candles. Entries require consensus from multiple technical indicators, validated by multi-timeframe filters. Exits are rule-based (stop-loss, take-profit, break-even).

**Core philosophy:** High win-rate entries through consensus + aggressive per-trade sizing (3 slots, ~33% each) + strict downside protection.

---

## Signal Generation

### Strategy Voting

15 technical strategies independently analyze each 12h candle and vote `BUY`, `SELL`, or `HOLD`:

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

### Per-Symbol Strategy Selection

Not all 15 strategies run on every coin. Each symbol has an optimised subset (typically 3-4 strategies) selected via holdout-validated backtesting:

```
BTC: RSI + BB + Stoch + SR    (conf threshold: 0.70)
ETH: RSI + BB + EMA           (conf threshold: 0.55)
SOL: RSI + EMA + MACD         (conf threshold: 0.55)
...etc (37 symbols configured in config/default.js)
```

The optimizer (`src/scripts/perSymbolOptimizer.mjs`) tests all strategy combinations with MIN_TRADES ≥ 3 and validates on a holdout year.

### Aggregator Logic

The signal aggregator (`src/engine/signalAggregator.js`) combines votes:

1. Each strategy votes with a confidence (0–1) and a weight (default 1.0)
2. **HOLD suppression** — HOLD votes don't count toward total weight:
   - 1 BUY + 2 HOLD = 100% BUY confidence (not 33%)
   - This prevents inactive strategies from diluting clear signals
3. Votes are summed per direction: `BUY_weight`, `SELL_weight`, `HOLD_weight`
4. Winning direction = highest weighted sum
5. Final confidence = `winning_votes / total_directional_weight`
6. If confidence < `minConfidence` threshold → decision = HOLD (no trade)

### Asymmetric Exit Threshold

For positions already open, SELL signals get a **30% lower confidence bar**:
```
Normal entry threshold: 0.70
Exit threshold: 0.70 × 0.7 = 0.49
```
This allows the bot to exit losing positions even when SELL conviction is moderate — it's easier to get out than to get in.

---

## Entry Filters

Every BUY signal must pass through a cascade of filters before execution:

### 1. Max Positions (Slot Limit)
- Maximum 3 concurrent open positions
- If all slots filled, new BUY signals are queued (logged but not executed)

### 2. Daily Loss Limit
- If cumulative daily P&L drops below −5%, all new trades are blocked for the rest of the day
- Existing positions continue with normal SL/TP management

### 3. 15m MTF Alignment Filter
- Before entering on a 12h BUY, checks the last 16 × 15m candles (4h window)
- Recency-weighted: recent candles have ~2× influence vs oldest
- **Score < 0.50 → entry blocked** (short-term trend disagrees)
- Blocks ~38 false entries per year across 8 symbols with 15m data

### 4. 4h Momentum Filter
- EMA(8) vs EMA(21) on 4h candles → normalized spread (60% weight)
- RSI(14) on 4h candles → raw RSI/100 (40% weight)
- Combined score: `emaScore × 0.6 + rsiScore × 0.4`
- **Score < 0.45 → entry blocked** (4h trend is clearly bearish)
- Blocks ~80 bad entries per year, boosts WR by +10pp

### 5. Minimum Confidence
- Per-symbol threshold (0.55–0.70 depending on strategy count)
- With 3 strategies: need 2/3 agreement minimum (conf ≥ 0.67)
- With 4 strategies: need 3/4 agreement (conf ≥ 0.75) or strong 2/4 (conf ≥ 0.55 with high individual confidence)

---

## Position Sizing

Position size is computed through a multiplicative chain:

```
Final size = Base × ATR × Confidence × Regime × Macro
```

### Base Size
- `maxPositionPct = 0.15` (15% of available balance)
- With 3 slots and full sizing, each position uses up to ~33% of capital

### ATR Scaling
- Computes ATR% (Average True Range as % of price) for each coin
- Portfolio median ATR% is the reference point
- Coins more volatile than median → position reduced proportionally
- Coins less volatile → position increased (up to a cap)

### Confidence Scaling
- `conf ≥ 0.65` (mid point) → linear scale from 1.0× to 1.5×
- `conf < 0.65` → linear scale from 0.6× to 1.0×
- Ensures high-conviction signals deploy more capital

### Regime Sizing (ADX-based)
- Computes ADX(14) on the last 50 candles at entry time
- **ADX ≥ 25** (strong trend): position × 1.3
- **ADX < 15** (choppy range): position × 0.5
- **15 ≤ ADX < 25**: no adjustment (1.0×)

### Macro Bear Filter
- Checks if BTC price is below its EMA(200)
- If bearish: all new positions × 0.5 (half size)
- Protects against systematic drawdown during bear markets (e.g., 2022 LUNA/FTX)

---

## Exit Rules

### Stop-Loss
- Per-symbol fixed percentage (range: 3–8%, default 5%)
- Checked every cycle against current market price
- Triggers immediate market sell

### Take-Profit
- Per-symbol fixed percentage (range: 8–20%, default 12%)
- Checked every cycle against current market price
- Triggers immediate market sell

### Break-Even Stop
- Trigger: position reaches +5% unrealized profit
- Action: stop-loss moved to entry price (risk-free trade)
- Only activates once per position; cannot move back down

### Strategy SELL Signal
- If the aggregator produces a SELL decision with confidence above the exit threshold (entry threshold × 0.7)
- AND the symbol has an open position
- Triggers immediate market sell regardless of current P&L

---

## Backtested Performance

**Test conditions:**
- 37 USDC pairs, 12h candles
- BUY fills at next-candle open (no execution lookahead)
- Tiered slippage: large caps 0.10%, mid caps 0.20%, micro caps 0.35%
- Starting capital: $1,000
- 3 concurrent position slots

| Window | Return | Sharpe | Sortino | Max DD | Win Rate | Profit Factor |
|--------|--------|--------|---------|--------|----------|---------------|
| Y2 (in-sample, 730 candles) | +87.1% | 2.15 | — | −7.2% | 63.6% | 5.70 |
| Y1+Y2 (full OOS, 1460 candles) | +1912% | — | 10.33 | −13.0% | 62.8% | — |

**Monthly breakdown (2 years):** 20 green months, 6 red months. Bear market (mid-2022) correctly avoided via macro filter + reduced sizing.

---

## What Was Tested & Rejected

| Enhancement | Result | Reason |
|-------------|--------|--------|
| Trailing stop | Underperforms fixed TP | Gives back profits on retracements; hard TP captures the move |
| More slots (5-8) | Lower returns, same DD | Dilutes capital per trade without reducing downside |
| Adaptive confidence threshold | Zero impact | Redundant with 4h filter (both block the same bad entries) |
| OBV divergence detection | Neutral | Existing filters already select good entries |
| Correlation filter | −7.6pp return | Correlated coins tend to be right together; blocking wastes alpha |
| 4h standalone trading | 38% WR | Strategies need multi-day patterns; 4h is too noisy |

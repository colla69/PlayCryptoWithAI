---
name: risk-management
description: >-
  Skill for changes that touch risk controls: stop-loss, take-profit, trailing stop,
  break-even stop, position sizing, daily loss limits, correlation filter, or regime filter.
---

# Risk Management Skill

## What This Skill Covers

- Stop-loss and take-profit logic in `src/executor/paperTrader.js` / `liveTrader.js`
- Trailing stop and break-even stop logic
- Position sizing (`maxPositionPct`, `minPositionUsd`, `maxConcurrentPositions`)
- Daily loss limits (`dailyLossLimit`)
- Correlation filter (`correlationThreshold`, correlation matrix in `main.js`)
- Regime filter (ADX threshold in `src/risk/index.js` or strategy)

## Risk Parameter Reference

All default values are in `config/default.js`:

| Parameter | Meaning | Typical Range |
|---|---|---|
| `stopLossMultiplier` | ATR multiplier for dynamic stop | 1.5–3.0 |
| `takeProfitMultiplier` | ATR multiplier for take-profit | 2.0–5.0 |
| `trailingStopPct` | Trailing stop as % of peak price | 0.01–0.05 |
| `breakEvenTriggerPct` | Move price must make before break-even activates | 0.01–0.03 |
| `maxPositionPct` | Max % of portfolio in a single position | 0.05–0.20 |
| `minPositionUsd` | Minimum position in USD (Binance min notional = $10) | 11 |
| `maxConcurrentPositions` | Max simultaneous open positions | 3–8 |
| `dailyLossLimit` | Max portfolio loss per UTC day before halting | 0.02–0.10 |
| `correlationThreshold` | Pearson r above which two coins count as correlated | 0.7–0.9 |
| `adxThreshold` | Minimum ADX for trending-market filter | 20–30 |
| `entryThreshold` | Minimum weighted confidence to enter | 0.4–0.7 |

## Key Invariants

1. **Stop-loss fires before take-profit is checked** — never skip the stop check.
2. **Trailing stop state is per-position** — `position.peakPrice` must be updated every price tick.
3. **Break-even only activates once** — use a `position.breakEvenSet` flag.
4. **Daily loss limit is cumulative** — sum of realised P&L since last UTC midnight.
5. **Correlation filter blocks entry** — if a candidate symbol's correlation with any open position exceeds `correlationThreshold`, skip it.
6. **Regime filter (ADX) blocks entry** — only enter when ADX ≥ `adxThreshold`.
7. **Minimum notional** — never place an order below `minPositionUsd` ($11 for testnet/live).

## Modification Checklist

- [ ] Stop-loss still fires before take-profit
- [ ] `position.peakPrice` updated on every `#checkRisk()` call (trailing stop)
- [ ] Break-even flag set exactly once per position
- [ ] Daily loss sum recalculated from closed trade history (not in-memory sum that resets on restart)
- [ ] Correlation matrix updated each cycle in `main.js`
- [ ] ADX threshold still applied in signal aggregator or risk manager
- [ ] All changed parameters documented in `config/default.js` with comment
- [ ] `node --check` passes on all modified files

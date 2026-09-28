---
name: risk-management
description: >-
  Skill for changes that touch risk controls: stop-loss, take-profit, trailing stop,
  break-even stop, position sizing, daily loss limits, correlation filter, or regime filter.
---

# Risk Management Skill

## Where risk lives

| Concern | Code | Config |
|---|---|---|
| SL / TP / trailing / break-even exits | `src/executor/traderUtils.js` (`calcExitSignal`, `calcTrailingStop`, `calcBreakEven`), used by both traders | `risk.stopLossPct`, `risk.takeProfitPct`, `risk.trailingStopPct`, `risk.breakEvenTriggerPct`; per-symbol SL/TP in `perSymbol` |
| Entry gate (threshold, daily loss) | `src/risk/riskManager.js` → `canTrade()` | `risk.minConfidence` × `risk.confidenceThresholdScale`, `risk.maxDailyLossPct` |
| Sizing chain (ATR, macro, ADX regime, confidence, MTF) | `src/core/positionSizing.js` → `computePositionSize()` | `risk.maxPositionPct`, `risk.minSizeMultiplier`, `atr`, `macroFilter`, `regimeSizing`, `confSizing` |
| Portfolio gates (correlation cap, weekly DD breaker, position aging) | `src/risk/portfolioRisk.js` | `correlation`, `risk.weeklyDDBreaker`, `risk.positionAgingExit` |
| Concurrent positions | both traders | `risk.maxOpenPositions` (core sleeve legs not counted) |
| Exchange floor | `src/exchange/exchangeLimits.js` (`FALLBACK_MIN_NOTIONAL` = $11), shared with the simulator | — |
| Sleeve sizing ladder | `src/engine/tsmCore.js` → `selectSleeveRung()` | `tsmCore.equityLadder` |

## Parameter reference

Values as of this writing — `config/default.js` is authoritative; per-symbol overrides in `perSymbol`.
The typical range is a sanity bound for review, not a validated optimum.

| Parameter | Meaning | Current | Typical range |
|---|---|---|---|
| `risk.stopLossPct` / `risk.takeProfitPct` | Fixed stop / target distance from entry | 0.05 / 0.12 | per-symbol tuned |
| `risk.trailingStopPct` | Trailing stop as a fraction of the high-water mark | 0 (off globally) | 0.01–0.05 |
| `risk.breakEvenTriggerPct` | Gain at which the stop moves to break-even | 0.05 (validated) | 0.01–0.05 |
| `risk.maxPositionPct` | Base fraction of free quote per position, before the multiplier chain | 0.15 | 0.05–0.20 |
| `risk.maxOpenPositions` | Concurrent scalper positions | 4 | 3–8 |
| `risk.maxDailyLossPct` | Realised loss per UTC day, as a fraction of live equity, before entries stop | 0.05 | 0.02–0.10 |
| `correlation.threshold` | Pearson r above which a new entry is blocked | 0.85 | 0.70–0.90 |
| `adx.threshold` | ADX strategy votes only above it (trend strength) | 25 | 20–30 |
| `regimeSizing.boostThresh` / `penaltyThresh` | ADX above → size ×1.3; below → size ×0.5 | 25 / 15 | — |
| `risk.minConfidence` × `risk.confidenceThresholdScale` | Entry threshold on aggregated confidence | 0.70 × 0.65 | 0.4–0.7 raw, per symbol |

## Key Invariants

- **Sleeve sizing keys off HIGH-WATER-MARK equity, never current equity.** Current-equity selection
  sizes up after losses (martingale). The `tsmCore.equityLadder` rungs are individually validated
  static profiles — never interpolate between them, never add or edit a rung without a backtest of
  that exact profile, and keep each `minHwmEquity` above the rung's $11-floor viability equity
  (`sleeveFeasibility()`).
- **Fixed dollar floors beat fractional sizing on small accounts.** Binance's $11 min notional is
  ~6% of a $189 account; any sizing change must be checked against it at CURRENT live equity, not
  the $1000 research budget (where it never binds).
- **Mark-to-market is part of risk management.** `calcEquityFromStatus()` — and through it every
  %-of-equity gate and the sleeve's HWM ladder — values positions from `position.currentPrice`, written by `markPrice()` (both traders,
  5s price poll) and `checkRisk()`. A path that lets a class of open positions go unmarked freezes
  their valuation silently — the dashboard hides it by overriding prices from its own map (frozen
  core-equity incident, 2026-08-04→09, when only `checkRisk` wrote the mark and the risk loop
  skipped core legs). Exempting a position from stops never exempts it from the mark; `markPrice()`
  stays valuation-only and must never touch state the stop maths reads.
- **Wallet coins are attributed core-first on restore.** Free balances are fungible; `calcCoreClaims()`
  reserves what every core leg owns — persisted AND in-memory — before the scalper restore claims
  the remainder. Omitting in-memory legs created a phantom position inflating equity ~25%
  (2026-08-03). Guarded by `tests/executor/coreClaims.test.js` and the
  `INTENTIONALLY_LIVE_ONLY` entry in `tests/backtester/liveParityInventory.test.js`.
- **Every live gate has a backtest twin.** A new rule that can reject or resize a live entry ships
  with its backtest counterpart and a row in `tests/backtester/liveParityInventory.test.js`.
- **Exit order:** the stop is checked before the target, on every price check — never skip the stop check.
- **Trailing stop state is per position** and ratchets up only: `position.highWaterMark` and the
  stop are updated on every price check (`calcTrailingStop`).
- **Break-even fires once:** `calcBreakEven()` only triggers while the stop is below entry, then
  lifts it to entry + 0.2% (round-trip fees). It never lowers a stop.
- **Daily loss is cumulative realised P&L since UTC midnight**, measured against LIVE equity
  (`calcEquityFromStatus`), not the static `initialBalance`. On restart it is re-seeded from
  persisted trade history (`riskManager.seedFromHistory`), so a reboot never resets the limit.
- **The correlation cap blocks an entry** whose correlation with any open position exceeds
  `correlation.threshold`. The matrix is rebuilt every cycle in `main.js` (`buildCorrelationMatrix`).
- **Regime:** the bear policy closes positions and blocks entries on the transition into
  `BEAR_TREND`; ADX regime sizing scales position size (boost trends, penalise chop) rather than
  blocking entries.
- **Minimum notional:** no order below the $11 floor from `exchangeLimits.js`, live or simulated.

## Modification Checklist

- [ ] Stop still checked before target; trailing stop still ratchets from `highWaterMark`
- [ ] Break-even still fires once and never lowers a stop
- [ ] Daily-loss and weekly-DD limits still scale off live equity; daily P&L still re-seeded from
      persisted history on restart (not an in-memory sum that resets)
- [ ] Correlation matrix still rebuilt each cycle in `main.js`; bear policy and ADX regime sizing
      still applied
- [ ] Sizing change checked against the $11 floor at current live equity
- [ ] New parameter in `config/default.js` with a safe default and a comment
- [ ] Live-side rule has its backtest twin and inventory row
- [ ] `node --check` and `npm test` pass

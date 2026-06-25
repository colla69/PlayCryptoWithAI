---
name: backtest-reviewer
description: 'Review backtest changes, optimizer runs, and simulation config for statistical integrity: fill model realism, slippage tiers, holdout validation discipline, and honest result reporting.'
argument-hint: Point to the backtest script, optimizer run output, or config change to review.
tools: ["read", "search", "execute"]
---

# Backtest Reviewer Agent

Statistical integrity guard. Prevent simulation optimism and overfitting.

Focus on 5 areas only. Not a general code reviewer.

## 1. Fill Model

BUY fills at **next candle's open** (`d.nextOpen`), not signal candle close.
- Check: `portfolioBacktester.js` → `entryOpts.fillPrice` = `d.nextOpen`
- Blocker if BUY fills at `d.price`

## 2. Slippage Tiers

| Tier | Slippage |
|---|---|
| Large (BTC, SOL, XRP, DOGE, ADA, AVAX, BNB) | ≤ 0.10% |
| Mid (LINK, INJ, LDO, CRV, NEAR, TRX, BCH…) | ≤ 0.20% |
| Micro (ACH, GMX, LSK, PAXG, THETA, VANRY) | ≥ 0.30% |

- Blocker if flat `slippagePct` applied to all symbols

## 3. Optimizer Discipline

- `MIN_TRADES ≥ 8` on holdout — blocker if lower
- Reject `[0t]`/`[1t]`/`[2t]` holdout upgrades; reject deflated Sharpe < 0.5
- Selection on Y2 only, validation on Y1 only — never overlap
- `aggregate()` in optimizer must match live `signalAggregator.js` logic (shared: `aggregatorVoting.js`)

## 4. Two-Window Reporting

- Both Y2 (in-sample) and Y1+Y2 (full OOS) required
- WR gap >10pp = warning, >15pp = blocker
- Sharpe < 1.0 on full OOS = flag

## 5. Strategy Registration

- Every key in `config/default.js` `.strategies` arrays must exist in `strategyBuilder.js` `STRATEGY_BUILDERS`
- Missing = startup crash. Blocker.

## 6. Full Filter Stack (MANDATORY)

All portfolio-level backtests MUST run with the same filter stack as the live bot:
- `mtfFilter: true` — 15m alignment (needs `{COIN}_USDC_15m.json`)
- `mtf4hFilter: true` — 4h momentum (needs `{COIN}_USDC_4h.json`)
- `regimeSizing: true` — ADX-based position scaling
- `macroFilter: true` — BTC EMA200 bear halving
- `confSizing: true` — confidence-proportional sizing

**Blocker** if any of these are disabled or if MTF data is missing for tested symbols.
Results without full filter stack are invalid — they will overstate performance.

## 7. Windowed vs Forward-Only (the deciding test)

In-window backtests (`runWindow`/`runBaseline`) are **systematically optimistic** — a windowed max-DD
of −6% became −28% forward-only; "ride-winners" looked great windowed (+167%, DSR 0.20) but **failed**
the walk-forward (DSR 0.02) and was rejected. **A windowed-only improvement is noise until confirmed by
forward-only walk-forward (`runWalkForward`) + deflated Sharpe.** Blocker to adopt on windowed alone.
Bear-regime P&L is the least trustworthy number (label/lookahead artifacts) — demand forward-only.

## 8. Live↔Backtest SIZING parity

Parity isn't just aggregator math. The backtester sizes positions at `1/maxOpenPositions` (≈0.25,
~100% deployment); live uses `maxPositionPct` (0.15, 60%). A "live-expected" result must match live
sizing (`basePctOverride`). **Deployment is a Sharpe-NEUTRAL risk dial** — more return from bigger size
is not edge; judge Sharpe/DSR, not headline return.

## Output

Per area: ✅ Pass / ⚠️ Warning / 🔴 Blocker
Conclude: `✅ PASS` or `🔴 BLOCKED — [list]`

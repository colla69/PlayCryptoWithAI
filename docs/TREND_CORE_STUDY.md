# Trend-Core Study — TSM majors edge & leader-rotation refutation

_2026-07-02, branch `tsm-core-sleeve` (based on `origin/master`, the running version)._
_Tool: `src/scripts/runTrendCore.mjs`; raw grids in `data/trend_core*.json` (gitignored)._

Context: the honest re-examination of the ensemble-TA strategy found no statistically
demonstrable edge (deflated Sharpe ≈ 0 on every window; +59% over a 6-year cycle in which the
underlying ~10×'d). This study tests the flagged "deeper fix": a **majors-beta trend core**
(time-series momentum, TSM) and a **cross-sectional momentum-leader rotation**, as standalone
constructs — sim-only, honest next-open fills, 0.1% fee per leg + tiered slippage
(0.10/0.20/0.35%), closed candles only, pre-registered grid, DSR deflated for the full search.

Window 2020-06-20 → 2026-06-25 (4,066 × 12h bars — full bull top + 2022 bear + recovery).

## Results

| Construct | Return | CAGR | Sharpe | Max DD | 2021-11→2022-12 | DSR |
|---|---|---|---|---|---|---|
| BTC buy&hold (benchmark) | +554% | 40% | 0.87 | −73% | −67.5% | — |
| ETH buy&hold (benchmark) | +613% | 42% | 0.84 | −79% | −67.5% | — |
| **A. TSM majors core — family plateau** (15–90d lookbacks, both universes) | +320→900% | 29–51% | **0.9–1.1** | −42→−67% | −20→−54% | 0.5–0.74 |
| A. best cell (mom30d BTC+ETH) — *a spike; do not quote* | +1,794% | 70% | 1.32 | −41.8% | −20.5% | 0.88 |
| **A. vote 30/45/60d BTC+ETH (shipping rule)** | **+615%** | **42%** | **1.01** | **−51.8%** | −47.4% | 0.73 |
| A. vote 30/45/60d BTC+ETH+BNB+SOL | +1,065% | 55% | 1.16 | −51.8% | −38.3% | 0.83 |
| B. Leader rotation (top-K by trailing return, all 4 cells) | +31→125% | 5–16% | 0.38–0.55 | −67→−77% | −20→−46% | ≤0.27 |
| C. 50/50 blend (prior cells) | +61% | 9% | 0.43 | −58% | −28.5% | 0.18 |

## Findings

1. **The TSM majors overlay is the one defensible edge found in this codebase's data.** Long
   BTC/ETH when trailing momentum is positive, cash otherwise. *Every* lookback 15–90d, on both
   universes, matches or beats buy-and-hold with roughly half the drawdown and higher Sharpe —
   a plateau, not a lucky cell — matching the well-documented crypto time-series-momentum
   literature. It is "smart beta" (harvests asset-class upside, cuts the bear tail), not alpha:
   ~50% exposure, ~15–35 round trips/yr/sleeve.
2. **The 30d lookback is a spike above the plateau** (Sharpe 1.32 vs neighbors 0.9–1.1).
   The shipping rule is therefore a **majority vote of 30/45/60d momentum** — plateau-level
   performance (Sharpe 1.01, +615%, positive 5 of 7 calendar years) without single-lookback
   overfit, and less flip churn than any single short lookback.
3. **DSR 0.65–0.88: better than anything the ensemble produced (~0.0) but below the 0.95 bar.**
   Six years ≈ 2–3 crypto cycles cannot statistically prove an edge; the case rests on plateau
   robustness + external literature. That is as good as this data allows.
4. **Cross-sectional leader rotation is refuted** (Sharpe ≤0.55 every cell; −49→−62% in calendar
   2025 — *despite* a survivorship-biased universe in its favor). Alt leaders mean-revert
   violently on this timeframe and churn costs compound it. Don't re-try naive top-K chasing.
5. **The "canonical" 200d EMA filter is the worst TSM rule here** (whipsawed; Sharpe 0.48).
6. **Caveats:** real troughs are −40/−60% at full deployment — position sizing is the
   (Sharpe-neutral) dial, e.g. 50% deployment ≈ roughly half the DD; all cells are negative in
   2026 YTD (whipsaw chop — an overlay adopted today starts in its worst regime); deep candle
   history predates real USDC-pair liquidity for some coins.

## Bottom line vs the ensemble bot (same window, honest fills)

Ensemble: +59% / Sharpe 0.95 / DD −10.5% / DSR ~0.02 — proven-null, barely participates.
TSM vote core: +615% / Sharpe 1.01 / DD −52% / DSR 0.73 — literature-backed, captures the
upside, real drawdowns. No configuration of this codebase gets both the upside capture *and*
−10% DD; the honest construction is a **sized TSM core sleeve** (deployment fraction chosen for
DD tolerance) alongside the scalper. Implementation: `config.tsmCore` (paper-first, default OFF).

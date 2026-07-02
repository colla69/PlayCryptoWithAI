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

## Start-date sensitivity ("didn't you just test in a bull window?")

Legitimate challenge: the full window starts June 2020, right before a historic bull run, so
*absolute* returns flatter any long-exposure strategy. `runTrendCore --from` re-measures the same
simulated curves from adversarial walk-in dates. (Numbers here differ slightly from the table
above — the 12h data was re-downloaded through 2026-07-02 after the cache-truncation incident;
e.g. the full-window vote cell is +596%/Sharpe 0.99 on the new vintage vs +615%/1.01 originally.) Vote 30/45/60d BTC+ETH vs the honest same-universe
benchmark (equal-weight BTC+ETH buy-and-hold):

| Walk-in date | TSM vote | EW B&H (same coins) | BTC-only B&H |
|---|---|---|---|
| 2020-06 (full, bull-favored) | +596% / Sh 0.99 / DD −52% | +582% / 0.85 / −77% | +558% / 0.87 / −73% |
| **2021-11-08 (exact cycle top — worst entry)** | **+7.9% / 0.22 / −52%** | −51.1% / 0.03 / −77% | −8.9% / 0.22 / −73% |
| 2023-03 (bear over — B&H-favored) | +105% / 0.82 / −38% | +50.6% / 0.50 / −61% | +181% / 0.90 / −53% |
| 2024-01 (recent chop) | +47.8% / 0.63 / −38% | −7.3% / 0.23 / −61% | +41.1% / 0.53 / −53% |

Reading this honestly, both ways:

- **The critique is right about absolute numbers.** Walk in at the top and TSM returns ~0% for
  4.6 years. The +596% headline needs the 2020–21 bull inside the window. TSM cannot manufacture
  return when the asset class gives none — it is an overlay on crypto beta, not alpha.
- **The relative claim survives every window, including B&H-favored ones.** Against equal-weight
  B&H of the same coins, the TSM vote wins return, Sharpe, AND drawdown in all four windows —
  the worst-case entry turns −51% into +8%. (BTC-only B&H wins the 2023 window because half the
  TSM sleeve sat in weak ETH — a universe-selection effect, not a timing failure.)

**Data caveat (affects all studies on this dataset, including the original):** Binance USDC pairs
have a gap 2022-09-29 → 2023-03-12 (BUSD-era delisting), so the FTX crash and the exact bear
bottom are invisible to the sim. This *flatters buy-and-hold* (true BTC DD was −77.6%, measured
−72.7%) and is ~neutral for TSM (its momentum votes were OFF through that whole stretch — it
would have been in cash). Directionally the gap biases against TSM's relative case, not for it.

## Recent regime (last two months)

Vote 30/45/60d BTC+ETH vs single-asset benchmarks, 2026-05-01 → 2026-07-02:

| Construct | Return | Max DD |
|---|---|---|
| TSM vote BTC+ETH (core sleeve) | **−4.2%** | **−9.6%** |
| BTC buy&hold | −22.3% | −29.0% |
| ETH buy&hold | −29.2% | −36.0% |
| Equal-weight BTC+ETH B&H | −26.0% | −32.3% |

**Flip trace:** BTC LONG 2026-04-05 @69,019 → CASH 2026-05-28 @73,547 (exited +6.6% above entry, before the fall to ~60,200); ETH LONG 04-05 @2,110 → CASH 05-15 @2,258 (+7%), two small whipsaw flips around 2,130, fully CASH since 05-22 (ETH later 1,618). Both signals are currently CASH — the sleeve sat out the June crash entirely, holding no positions while the benchmarks fell 22–29%.

**2026 YTD counterweight:** the sleeve is ~−9% on the year — Jan–Mar chop produced whipsaw losses
(e.g. BTC LONG @70,108 → CASH @68,789, −1.9%). That is the deal in one sentence: the overlay pays a
small whipsaw cost in sideways markets and, in exchange, steps out of large crashes. Deployment
sizing (50% sleeve share) remains the dial for absolute DD tolerance.

## Widening the edge (2017+ data, hysteresis, vol targeting)

To escape the USDC data limits, USDT-pair 12h history was downloaded back to **2017-08-17**
(6,482 bars, gap-free — adds the 2018 bear (−84%) and covers the 2022 USDC hole). On this 9-year
window, pre-declared widening experiments (`--quote USDT --universe ... --hysteresis --vol-target
0.6`; every DSR deflated for the cumulative 33-trial search):

| Rule (BTC+ETH+BNB+SOL universe) | Return | CAGR | Sharpe | Max DD | DSR | Round trips |
|---|---|---|---|---|---|---|
| EW 4-major B&H (reference: BTC B&H Sh 0.78, DD −84%) | — | — | ~0.8 | ~−85% | — | — |
| vote 2-of-3 (previous shipping rule) | +4,108% | 52% | 1.07 | −60% | 0.86 | 482 |
| + slow-in (enter 3/3, stay ≥2) | +4,260% | 53% | 1.12 | −58% | 0.89 | **160** |
| + vol-target 0.6 (sizing ∝ 0.6/realized vol) | +1,590% | 38% | 1.12 | −49% | 0.88 | 482 |
| **+ both (combo)** | +1,925% | 40% | **1.23** | **−44%** | **0.94** | 160 |

**Findings (each replicated across all three universes tested — BTC+ETH, 4-major, 8-major):**

1. **Slow-in hysteresis widens the edge for free**: higher Sharpe everywhere, ~3× fewer round
   trips (86 vs 251 on BTC+ETH), same architecture. **Adopted in the sleeve config**
   (`enterVotes: 3, stayVotes: 2`). The open position itself is the hysteresis state.
2. **Vol targeting works as the literature says**: sizing down when 30d realized vol spikes cuts
   DD by ~10–25pp at equal-or-better Sharpe. **Stacks with slow-in** — the combo is the best
   cell family this project has produced (Sharpe 1.15–1.23, DSR 0.90–0.94 on 9yr with two full
   bears). Requires fractional position resizing in the sleeve — documented next step, not yet
   implemented live.
3. **Worst-entry robustness improved**: combo walked in at the 2021-11-08 top = **+54→59%**
   (holding: −29→−37%); walked in at the 2018-01-06 top = CAGR 32–35% (holding: 6–17%).
4. **Slow-out hysteresis (exit only at 0/3) — refuted** (Sharpe flat, DD worse).
5. **Majors-only rotation — refuted**: far better than the 37-coin version (Sharpe up to 0.93 vs
   ≤0.55) but still below the plain 4-major vote at worse DD, with heavy survivorship bias.
6. **Universe: 4 majors > 2 majors > 8 majors.** Adding BNB+SOL diversifies trend bets (Sharpe
   1.07 vs 0.93); adding the weaker alts (XRP/ADA/LTC/DOGE) dilutes back down (0.93). Caveat:
   BNB/SOL are today's survivors — the ex-ante argument is diversification, not coin-picking,
   so BTC+ETH stays the default and the 4-major universe is a documented config option.

## Bottom line vs the ensemble bot (same window, honest fills)

Ensemble: +59% / Sharpe 0.95 / DD −10.5% / DSR ~0.02 — proven-null, barely participates.
TSM vote core: +615% / Sharpe 1.01 / DD −52% / DSR 0.73 — literature-backed, captures the
upside, real drawdowns. No configuration of this codebase gets both the upside capture *and*
−10% DD; the honest construction is a **sized TSM core sleeve** (deployment fraction chosen for
DD tolerance) alongside the scalper. Implementation: `config.tsmCore` (paper-first, default OFF).

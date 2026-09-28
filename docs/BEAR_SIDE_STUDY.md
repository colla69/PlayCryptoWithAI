# Bear-Side Study — what to do with the capital in a bear market

**Status (2026-09-28): research complete, nothing to build on the trading side.** Every short-selling
and gold angle fails its gate on its own returns. The only thing that raises the numbers is parking
idle USDC in a yield product — a cash-management question, not an edge, and one that depends on
Binance Earn being open to an EU account (checked with the read-only probe, not yet run).

Plan: [`docs/plans/2026-09-bear-side-and-weekly-review.md`](plans/2026-09-bear-side-and-weekly-review.md)
(Phase 1). Script: [`src/scripts/runBearSide.mjs`](../src/scripts/runBearSide.mjs) — its header holds
the pre-registration (written before the first run) and the post-review corrections.

## The question

Since Route 6A the bot goes to cash when BTC enters `BEAR_TREND` (27.7% of the 12h bars since 2021).
`docs/SHORTING_FEASIBILITY.md` left open whether that idle capital could earn instead — by shorting, or
by holding something that doesn't fall with crypto. This study measures every angle, singly and in
combination, as an **overlay on the bot as it trades today**.

## Can the account do it at all? (venue, as of 2026-09-28)

| Product | Finding | Source |
|---|---|---|
| USDⓈ-M / USDC perpetual futures | Unavailable to users in **Germany**, Italy and the Netherlands | Binance announcement "Unavailability of Futures and Derivatives Products in Germany, Italy, and the Netherlands" |
| Spot margin (cross / isolated) | Stays available to EEA users with **USDC** borrowing; USDT borrowing halted under MiCA | Binance "USDC is Now MiCA-Compliant: How It Affects Your Binance Account"; "MiCA Stablecoin Rules Implementation Announcement" |
| Margin on the bot's pairs | 31 of 37 USDC pairs are margin-enabled exchange-wide (not: MANTA, PIXEL, TON, GMX, VANRY, LSK) | public `GET /api/v3/exchangeInfo` (`isMarginTradingAllowed`) |
| Binance's EU licence | No MiCA authorisation since the 2026-07-01 deadline; reports conflict on what EU users keep (France lost spot, margin and futures; others cite reverse solicitation, which ESMA disputes). This account's spot orders still filled in September 2026 | cryptonomist.ch 2026-09-08 "Binance EU MiCA licensing"; zyphe.com "Binance MiCA licence: EU lockout (July 2026)"; casptracker.eu/exchange/binance |
| This account's margin / Earn access | **Not yet run** — `src/scripts/probeMarginAccess.mjs` reads it from the account with a read-only API key | — |

Germany is assumed (Europe/Berlin host). No short cell passes, so the venue question now only
matters for idle-cash yield.

## Design

- **Book B0** — the scalper through `runWindow` with the full live filter stack at 0.15 base size, plus
  the TSM long sleeve (vote 60/90/120 bars, slow-in, vol target 0.6, BTC+ETH) at a constant 30% of
  equity. The TSM curve is re-simulated and matches `runTrendCore`'s own curve to 2×10⁻¹⁶ on all
  4,786 bars (the run aborts otherwise). **Caveat:** the scalper leg comes from `PortfolioBacktester`,
  which steps symbols by array index, so symbols with later or gapped histories are misaligned in time
  ([engine plan](plans/2026-09-backtester-time-alignment.md)); its equity also marks other open
  positions at entry price, and the TSM leg leaves out the live NASDAQ macro overlay
  (`tsmCore.macroOverlay`). B0 is engine output, not what the live bot would have earned — which is
  why the verdicts below rest on each overlay's **own** returns.
- **Overlay** — while `BEAR_TREND` the scalper is flat, so 30% of equity goes to the bear sleeves
  (combos split it equally).
- **Cells:** S1g short BTC+ETH at 1× isolated margin, the live TSM rule mirrored, only in `BEAR_TREND` ·
  S1u the same ungated · S1g2 / S1u2 at 2× · S2 short the scalper's own SELL decisions on 28
  margin-enabled alts in `BEAR_TREND` (4 slots, mirrored SL/TP, cover on BUY / regime exit / 14 bars) ·
  S3 hold PAXG in `BEAR_TREND` · S4 4% APR on the parked USDC in `BEAR_TREND` · combos C1 S1g+S3,
  C2 S1g+S4, C3 S3+S4, C4 S1g+S2, C5 S1g+S3+S4, C6 all four.
- **Costs and mechanics:** 0.1% fee per leg; the shared slippage tiers; borrow interest 10% APR on
  BTC/ETH and 20% on alts; isolated-margin liquidation at margin level 1.1 with a 2% fee, at the open
  if a bar opens beyond it. Shorts are held at constant leverage (rebalanced at bar opens like the long
  sleeve), so the tail risk is a move inside one 12h bar, reported as the lowest margin level reached.
  Overlay sleeves go flat before a data hole. `--selftest` checks the accounting on synthetic prices:
  costs on a flat price, falling and rising prices, 40% and 90% one-bar wicks at 1× and 2×, equity
  after a liquidation, fill timing (signal at bar 10 → fill at bar 11's open), and a bad print after a
  data hole.
- **Gate** — each cell is judged on its overlay's returns: deflated Sharpe ≥ 0.5 (58 trials: 45 prior
  sleeve-family trials + 13 cells; 65 counting the sensitivity rows), positive Sharpe in both
  2021–23 and 2024–26, book max DD not worse, no 1× liquidation, venue confirmed. S4 is not a trial:
  a fixed yield raises any Sharpe measured with a zero risk-free rate and cannot deepen a drawdown,
  so it would pass any Sharpe/DD gate by construction; combos are judged on their trading members.
- **Data:** USDC only for the primary run, 2021-01-01 → 2026-08-10 (the end of the 15m data the
  scalper's filters need). USDC has no bars 2022-09-28 → 2023-03-12 (BUSD era), and PAXG/USDC starts
  2025-04. A second run uses public **USDT price history as a labelled proxy** — nothing is traded in
  USDT — for standalone sleeves over 2018-01-01 → 2026-08-10: the 2018 bear and a gap-free 2022.
  Flagged bad prints (reported by the script): BTC/USDC 2023-03-12 12:00 high 50,000 on the first bar
  after the hole; PAXG/USDC 2025-04-15 high 9,999 on its listing bar.

### Corrections after review

`backtest-reviewer` blocked the first write-up. Corrected before the numbers below were produced:
the first run held the ungated short through the USDC hole into the 50,000 print and reported
liquidations that never happened (now: flat across holes, tested); PAXG used 0.20% slippage instead
of the shared 0.35%; counters ran over all history instead of the window; S2 filled gapped stops at
the stop price, sized off the fill bar's close and counted wins before costs; the trial count was
33 + 14 instead of 45 + 13; and a DSR on the whole book mostly measured B0, so the gate now looks at
each overlay alone. Corrections that helped the overlays and corrections that hurt them were both
applied. None changed a verdict on a trading leg; the one verdict that moved is **C3 (PAXG + yield)**,
which passed the first gate and passes it still on the fresh numbers — entirely because of its
yield half. Judged on its trading leg (PAXG), it fails: that leg's overlay Sharpe is 0.00 in 2021–23
(no PAXG/USDC data yet) and 0.06 in 2024–26, DSR 0.01. The gate change moved it, not a data fix.

## Results — USDC, overlaid on B0 (2021-01-01 → 2026-08-10)

| Cell | Book return | Book Sharpe | Book max DD | Overlay Sharpe | Overlay DSR | Overlay Sharpe 2021–23 / 2024–26 | Gate |
|---|---|---|---|---|---|---|---|
| **B0** (engine output — see caveat) | +113.6% | 1.33 | −10.6% | — | — | — | — |
| S1g short majors in bear | +115.6% | 1.16 | −18.5% | 0.06 | 0.01 | 0.30 / −0.19 | ✗ |
| S1u short majors ungated | +109.4% | 1.03 | −19.8% | 0.01 | 0.01 | −0.01 / 0.02 | ✗ |
| S1g2 same at 2× | +99.1% | 0.79 | −26.4% | −0.01 | 0.01 | 0.17 / −0.19 | ✗ |
| S1u2 ungated 2× | +88.7% | 0.64 | −30.9% | −0.01 | 0.01 | −0.12 / 0.08 | ✗ |
| S2 short alts on SELLs | +121.0% | 1.36 | −13.2% | 0.26 | 0.04 | 0.96 / −0.30 | ✗ |
| S3 PAXG in bear | +114.6% | 1.30 | −10.6% | 0.04 | 0.01 | 0.00 / 0.06 | ✗ |
| S4 yield on idle USDC | +117.3% | 1.36 | −10.4% | — | — | — | cash note |
| C1 S1g+S3 | +116.1% | 1.29 | −14.6% | 0.07 | 0.02 | 0.30 / −0.15 | ✗ |
| C2 S1g+S4 | +117.3% | 1.30 | −14.5% | 0.06 | 0.01 | 0.30 / −0.19 | ✗ |
| C3 S3+S4 | +116.1% | 1.34 | −10.5% | 0.04 | 0.01 | 0.00 / 0.06 | ✗ |
| C4 S1g+S2 | +119.0% | 1.30 | −15.5% | 0.13 | 0.02 | 0.52 / −0.25 | ✗ |
| C5 S1g+S3+S4 | +116.7% | 1.33 | −13.2% | 0.07 | 0.02 | 0.30 / −0.15 | ✗ |
| C6 all four | +117.9% | 1.35 | −13.0% | 0.14 | 0.02 | 0.52 / −0.22 | ✗ |

**Inside the bears** (book total):

| | 2021-11 → 2022-12 (USDC hole inside) | 2026-04 → 2026-07 |
|---|---|---|
| B0 | −5.6% (DD −7.7%) | +1.8% (DD −2.5%) |
| + S1g short majors | **+3.9%** (DD −7.8%) | +1.0% (DD −6.3%) |
| + S2 short alts | −1.8% (DD −8.0%) | +1.3% (DD −3.2%) |
| + S1g+S2 | +1.2% (DD −6.4%) | +1.2% (DD −3.8%) |
| + S3 PAXG | −5.6% (no PAXG/USDC data yet) | −0.2% (DD −5.8%) |

Shorting BTC/ETH does what it promises *inside* the 2022 bear — the book goes from −5.6% to +3.9% —
but the same rule loses in bear-market rallies and in 2024–26, so across the cycle it costs Sharpe and
nearly doubles the drawdown. Shorting alts made money in 2021–23 (overlay Sharpe 0.96; +4.0% of
equity as an overlay in the 2022 window, +13.6% on its own capital) and lost in 2024–26 (−0.30).

**Sleeves on their own capital:** S1g −8.5% (Sharpe 0.06, DD −46.3%, 69 round trips, active 21% of
bars, lowest margin level 1.75, no liquidation) · S1u −24.4% (DD −60.8%, lowest margin level 1.61) ·
S2 +10.3% (Sharpe 0.26, DD −25%, 78 trades, win rate 46% after costs) · S3 −0.1% · S4 +5.9%.

## Results — USDT price proxy, standalone (2018-01-01 → 2026-08-10)

| Sleeve | Return | Sharpe | Max DD | DSR | 2018 bear | 2022 bear | 2026 drop |
|---|---|---|---|---|---|---|---|
| S1g short majors in bear | −7.6% | 0.09 | −51.9% | 0.02 | +22.8% | +16.6% | −0.2% |
| S1u ungated | −38.3% | 0.01 | −77.2% | 0.01 | +80.9% | +12.0% | +2.1% |
| S1g2 at 2× | −59.9% | 0.06 | −86.4% | 0.02 | +44.2% | +5.4% | −1.2% |
| S3 PAXG in bear | −13.6% | −0.13 | −32.4% | 0.00 | 0% | −13.5% | −8.1% |
| C1 S1g+S3 | −2.5% | 0.04 | −25.5% | 0.01 | +12.6% | +2.6% | −3.9% |

Nine years and two full bears say the same thing more sharply: the short leg earns in the deep bears
and gives it all back in the rallies between them, and **PAXG lost money in the 2022 bear** — gold
priced in dollars is no hedge against a strong-dollar crypto bear. Nothing was liquidated, even at 2×
(lowest margin level 1.22): the constant-leverage rebalancing deleverages a losing short.

Borrow-cost sensitivity (S1g standalone, USDC): 2% APR −1.5% · 5% −3.9% · 10% −8.5% · 20% −15.9% —
cheaper borrowing does not rescue it; the losses are in the trades, not the carry.

## Verdicts

| Angle | Verdict | Why |
|---|---|---|
| Short BTC/ETH in `BEAR_TREND` (S1g, S1u, 2× variants) | **Rejected** | Earns inside deep bears, loses across the cycle: overlay Sharpe ≤ 0.06, DSR 0.01, negative in 2024–26; the book's max DD roughly doubles |
| Short alts on the scalper's SELLs (S2) | **Rejected** | Worked in 2021–23, lost in 2024–26; overlay DSR 0.04; book max DD −10.6% → −13.2% |
| PAXG while `BEAR_TREND` (S3) | **Rejected** | No effect on USDC data; lost 13.5% in the 2022 bear on proxy data |
| Every combination (C1–C6) | **Rejected** | Their trading legs are the rejected sleeves; overlay DSR ≤ 0.02 |
| Yield on idle USDC (S4) | **Cash note, not a strategy** | A fixed yield on cash that sits idle anyway: ≈ +0.3%/yr at 30% of equity for 28% of the time. It "improves" any Sharpe measured with a zero risk-free rate by construction. The real questions are whether Earn is open to an EU account after 2026-07-01 and whether keeping funds there is acceptable |
| Perpetual futures | **Not available** | Binance derivatives are closed to users in Germany |

**Recommendation:** keep Route 6A (cash in `BEAR_TREND`) and close the shorting question as measured
and rejected. Run the probe once with a read-only key to settle whether USDC Earn is open to the
account; if it is, idle-cash management (all idle cash, in every regime) is a small separate design
question — it would move funds, so it needs its own live code, a backtest counterpart and a security
review.

## Caveats

- B0's scalper leg is subject to the backtester's time-alignment bug (above); the verdicts use the
  overlays' own returns, which the bug does not touch.
- USDC data has no bars 2022-09-28 → 2023-03-12 (the FTX crash and the 2022 bottom are missing); the
  USDT proxy run covers it for standalone sleeves.
- Survivorship: S2's universe is today's margin-enabled symbol list.
- No parameter was fitted — every rule mirrors a live rule or is fixed in the header — so the
  2021–23 / 2024–26 halves act as the forward check.

## Reproduce

```bash
# in a checkout whose data/ is NOT the live bot's (see docs/plans/2026-09-bear-side-and-weekly-review.md)
npm run download-history -- --timeframe 4h --years 7 --repair
node src/scripts/rebuildDeepHistory.mjs --write
npm run download-history -- --timeframe 12h --years 9.2 --symbols BTC/USDT,ETH/USDT,PAXG/USDT,BNB/USDT
# exchange-level margin flags for the bot's pairs (public endpoint)
SYMS=$(node -e 'import("./config/default.js").then(({default:c})=>console.log(JSON.stringify(c.symbols.map(s=>s.replace("/","")))))')
curl -s -G https://api.binance.com/api/v3/exchangeInfo --data-urlencode "symbols=$SYMS" | python3 -c 'import sys,json; d=json.load(sys.stdin); json.dump({"symbols":{s["symbol"]:{"status":s["status"],"margin":bool(s.get("isMarginTradingAllowed"))} for s in d["symbols"]}}, open("data/margin_pairs_public.json","w"), indent=1)'
node src/scripts/runBearSide.mjs --selftest
node src/scripts/runTrendCore.mjs --quote USDC --vote 30,45,60 --hysteresis --vol-target 0.6 \
  --dump-curves data/tc_curves.json --curve-keys 'vote30/45/60d slow-in volT0.6 BTC+ETH' --out data/tc.json
node src/scripts/runBearSide.mjs --curves data/tc_curves.json      # ~6 min
node src/scripts/runBearSide.mjs --quote USDT                        # proxy, seconds
```

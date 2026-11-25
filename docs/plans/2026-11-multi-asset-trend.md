# Other assets and the scalper/sleeve split

**Status (2026-11-25): Part A measured and decided (stop rule below). Part B stopped at the fee
check; no study built. Added the same day: the sleeve buy-back checks and a pre-registered
futures-positioning test.** Goal, in the user's words: money,
not learning. Run on the research PC, never on the live host.

## Do not repeat these

| Question | Answer so far | Where |
|---|---|---|
| Do per-coin settings beat one shared setting? | Not on data neither was fitted on (2020 → 2024-05): every shared trend combo matched or beat them. Since 2024-05 only the in-sample per-coin setting made money | [one-engine plan](2026-10-single-engine-rebuild.md), section C8 |
| Does re-fitting or per-coin picking help? | No | same file, section C8 and section E item 4 |
| Short in a bear? | Rejected; Binance futures closed to German users | branch `research/bear-side`, `docs/BEAR_SIDE_STUDY.md` |
| Hold PAXG while BTC is in `BEAR_TREND`? | Rejected; lost in the 2022 bear on proxy data | same file, cell S3 |
| Yield on idle USDC? | Small cash gain, not an edge. Account access not yet probed | same file, cell S4 |

The bear-side study is not merged into `master`, and its baseline used the backtester before the
time-alignment fix. Its verdicts rest on each overlay's own returns.

## Part A — decide the scalper/sleeve split (no new strategy research)

C8 says the scalper's edge has been near zero since mid-2024 on every setting nobody fitted to that
period. The sleeve rests on a simpler rule with stronger evidence and deeper drawdowns.

1. Rerun the current engine for: scalper only, sleeve only, both as shipped. Same data, same costs.
2. Report each on the unseen span and on 2024-05 onward separately. Label the latter in-sample for
   the scalper.
3. Put the user's choice in plain terms: return per year and worst drop for each split.

The user decides. Changing the live split is not part of this plan.

## Part B — the sleeve's trend rule on other assets (new)

S3 held gold only during crypto bears. This asks something else: does the same trend rule, applied
to each asset's **own** trend and running all the time, improve the book?

### Check first, before any data work
- Which instruments can an EU retail account buy? US-listed ETFs are normally not available (PRIIPs),
  so expect UCITS ETFs and gold ETCs. Verify.
- Which broker, what fee per order, is there an API, what are the FX cost and the minimum order?
- Taxes in Germany differ between crypto, ETFs and ETCs. The user checks this.
- If fees on an account of a few hundred dollars eat the expected gain, say so and stop here.

### Pre-registration (fix before the first run, then do not tune)
- **Assets:** world equities, US tech, gold, government bonds. One instrument or long index proxy
  each. Record the data source and every symbol before running.
- **Data:** daily closes, at least 2007 onward (includes 2008 and 2022), total return where possible.
- **Rule T1:** the sleeve's shipped rule unchanged: 30/45/60 calendar-day momentum vote, slow-in,
  vol target 0.6, long or cash. At 0.6 the vol target will rarely bind on these assets; report that.
- **Rule T2:** one classic comparison: 12-month momentum, checked monthly, long or cash.
- **Fills and costs:** decide on a closed bar, fill at the next open, real broker fee, spread and FX.
- **Benchmarks:** buy and hold the same assets; buy a world equity ETF monthly; cash.
- **Trials:** count T1, T2 and the earlier sleeve-family trials in the deflated Sharpe.

### Pass rule
All of these, net of costs:
1. The trend sleeve's own deflated Sharpe is at least 0.5.
2. Adding it to the crypto sleeve (same total capital) raises Sharpe and does not deepen the worst
   drop, in both halves of the common period.
3. It beats buy and hold of the same assets on return relative to worst drop.

If it fails, the answer is the benchmark: a plain index ETF savings plan, no bot.

### Code
`src/scripts/runTrendCore.mjs` holds the rule, but reads 12h USDC candle files and crypto costs.
Write a separate research script for daily multi-asset data. Check that it reproduces the sleeve's
BTC+ETH numbers before trusting it on anything new. No live code, no broker integration.

## Part A results (2026-11-25)

`runSuperbot.mjs --cell bot` (no satellites), $190 + $10 a week, three runs per window: both as
shipped, `--no-sleeve` (scalper alone), `--per-symbol '{"minConfidence":2}'` (sleeve alone: no
scalper entry can reach the threshold; 0 scalper trades confirmed). Deep set `126 724b7eed…` for
2020-06-01 → 2026-08-10, live set `126 193218ef…` for 2026-08-10 → 10-24; both fingerprints checked
after the runs. 0 min-notional rejections. Returns are on the whole account, idle cash included.

| Span | Scalper alone | Sleeve alone | Both (shipped) |
|---|---|---|---|
| 2020-06 → 2024-05, unseen by both | 0.7%/yr · Sharpe 0.30 · drop 4.0% | 18.0% · 1.85 · 6.2% | 17.9% · 1.76 · 6.2% |
| 2024-05 → 2026-08, **scalper in-sample to 2026-05** | 22.8% · 2.68 · 3.5% | 0.6% · 0.14 · 5.7% | 20.5% · 2.07 · 6.5% |
| of which 2026-05-29 → 08-10, unseen | −0.6% total · drop 0.7% | −0.1% total · drop 1.0% | −0.8% total · drop 1.7% |
| 2026-08-10 → 10-24, unseen (11 weeks) | +7.2% total · drop 2.1% | +9.5% total · drop 6.2% | +12.6% total · drop 7.0% |
| Whole 2020-06 → 2026-08 | 8.3%/yr · 1.58 · 4.2% | 11.3% · 1.39 · 6.2% | 18.9% · 1.87 · 6.5% |

Final balance of $3,420 paid in: scalper $4,988, sleeve $4,059, both $5,692.

What it shows:
- **The scalper barely traded before its tuning window.** 14 trades in the four unseen years, −$35 in
  total. 63 trades from 2024-05 on, +$1,603. All of its six-year profit sits in the period its
  settings were chosen on. C8's "bot 20.2%/yr on 2020 → 2024" was the sleeve: that figure included it.
- **The sleeve is the reverse.** +$595 before 2024-05, +$32 after: flat for the last 27 months of the
  deep set.
- **Unseen by the scalper so far:** 2026-05-29 → 10-24, about five months, −0.6% then +7.2%. Too
  short to settle anything.
- The two streams made money in different periods, so the combined curve is smoother than either.
  For the scalper that is partly an artefact of the in-sample window.

The choice in plain terms, per year and worst drop: scalper alone has no evidence outside its tuning
window (0.7%/yr over four years, then five months that net positive); sleeve alone has four good
unseen years and two flat ones (11.3%/yr, drop 6.2%); both as shipped gives 18.9%/yr, drop 6.5%, with
the scalper's share of that not proven. Nothing in live is changed by this.

### Was the scalper ever tuned alone? Yes, and it failed (checked 2026-11-25)

- The per-coin optimizer has always scored the scalper without the sleeve. Since 2026-10-27 it
  scores through the live filter stack, and the walk-forward refit run that day (2,280 trials a
  coin, refit every 6 months on the prior 24) failed: Sharpe −0.13 over 2022-06 → 2026-08, median
  PBO 0.43 ([one-engine plan](2026-10-single-engine-rebuild.md), section E item 4 part 2). Do not rerun it.
- New here: C8's six shared combos were replayed with the sleeve on, so their 19–33%/yr on
  2020 → 2024 included the sleeve's 18%. Scalper alone (`--no-sleeve`, same replay, deep set):

| Setting, scalper alone | 2020-06 → 2024-05 | 2024-05 → 2026-05 | 2026-05-29 → 08-10 | Six years |
|---|---|---|---|---|
| today's per-coin (tuned on the middle span) | 0.7%/yr · Sharpe 0.30 · 14 trades | 25.7% · 2.85 · 56 | −$32 · 7 | 8.3% · 1.58 · drop 4.2% |
| ADX+MACD+Supertrend | 12.1% · 1.33 · 87 | −7.8% · −0.57 · 148 | −$63 · 10 | 4.3% · 0.46 · drop 19.6% |
| ADX+EMA+MACD | 11.2% · 1.35 · 88 | −16.4% · −1.43 · 154 | −$59 · 12 | 0.4% · 0.09 · drop 36.4% |
| EMA+HeikinAshi+PSAR | 7.1% · 1.52 · 49 | −0.6% · −0.02 · 90 | −$63 · 11 | 3.9% · 0.62 · drop 14.0% |
| MFI+SR+Supertrend | 1.3% · 0.65 · 15 | 0.4% · 0.10 · 36 | −$56 · 3 | 0.6% · 0.21 · drop 5.1% |
| ADX+EMA+SR | 0.7% · 0.16 · 69 | 3.9% · 0.33 · 169 | −$85 · 13 | 1.4% · 0.19 · drop 19.8% |
| HeikinAshi+SR+WilliamsR | −0.8% · −0.59 · 8 | −3.1% · −0.80 · 24 | −$20 · 3 | −1.6% · −0.66 · drop 10.4% |

  No setting made money in both long spans. Three shared trend combos earned 7–12%/yr before
  2024-05 and lost after; today's per-coin setting did the reverse, on the span it was chosen on.
  Every setting lost in 2026-05-29 → 08-10.

### Decision (user, 2026-11-25): no more scalper tuning; a stop rule fixed in advance

- Scalper and sleeve stay as shipped. No scalper setting is re-tuned.
- **Scalper stop rule:** count the scalper's own closed trades from 2026-05-29 (the first day its
  settings never saw). Review at 40 such trades or on **2027-05-29**, whichever comes first. If
  their net P&L, fees included, is negative at the review, switch the scalper off. The rule is
  not changed before the review.
- Sources for the count: `runSuperbot.mjs --no-sleeve` to 2026-10-24, live's trade log after.
  State on 2026-10-24: 7 trades to 08-10 (−$32 in the six-year replay's money) and +7.2% on the
  account over the next 11 weeks.
- The sleeve stays on. Next candidate with evidence: the breakout satellite, built and off; its
  paper soak and reconciliation are still to do (one-engine plan, "The live side of the satellites").

## Sleeve buy-back rule: the two open checks (2026-11-25)

The rule is section M2 of the [one-engine plan](2026-10-single-engine-rebuild.md): sell on the first
negative vote (`stayVotes` 3), buy back only on a close above the previous 20 days' closes
(`rebuyConfirmBars` 40). Two of its three open checks are now done. Nothing is switched on.

**Check 1 — paired block bootstrap, charged for the family.** `runTrendCore.mjs` rerun on freshly
downloaded Binance USDT 12h bars (2017-08-17 → 2026-08-10); it reproduces section M's Sharpe
(1.21 → 1.47, 1.27 → 1.50, 0.91 → 1.16; 90 round trips against 91 in one cell). 12h returns of M2
minus the shipped sleeve, circular blocks of 30 days, 5,000 draws. Family = the 21 sleeve-exit
variants of sections J–M (3 stops, 4 fast exits, 8 pauses, 6 buy-back rules); the family p-value is
the share of draws where the best centred variant beats M2's observed gain (White's reality check).

| Universe | Sharpe gain · 90% interval · draws above 0 | Yearly return gain · 90% interval | p, charged for 21 |
|---|---|---|---|
| BTC+ETH | +0.26 · 0.04 to 0.51 · 97.3% | +3.7 pts · −3.9 to 11.2 | 0.24 |
| BTC+ETH+BNB+SOL | +0.23 · 0.02 to 0.44 · 96.5% | +1.6 pts · −4.9 to 7.9 | 0.26 |
| XRP+ADA+LTC+DOGE (never used in selection) | +0.25 · 0.03 to 0.47 · 97.1% | +3.6 pts · −2.5 to 10.0 | 0.21 |

Reading: on the coins the rule was chosen on, the gain does not survive the charge for 21 tries
(p 0.24, 0.26). On the four coins no selection ever saw, the charge does not apply — one rule, fixed
beforehand — and the Sharpe gain is positive in 97% of draws. A return gain is not shown anywhere;
what the rule buys is a smaller drop.

**Check 2 — simulator ↔ engine replay, trade by trade.** `runTrendCore.mjs` gained `--dump-fills`
(full entries and exits per cell; no result changes). Simulator on the deep USDC set against the
six-year engine replay of the sleeve alone (rule on by a preload), full round trips per coin:

| | BTC | ETH | BNB | SOL |
|---|---|---|---|---|
| shipped: replay / simulator / same entry and exit bar | 31 / 31 / 30 | 28 / 28 / 27 | 24 / 24 / 23 | 20 / 20 / 20 |
| M2: replay / simulator / same entry and exit bar | 45 / 45 / 44 | 41 / 41 / 40 | 49 / 49 / 49 | 29 / 29 / 29 |

Every exit falls on the same 12h bar. The five entries that differ are the replay's first buy of a
coin (its start on 2020-06-01, and BNB joining when the equity ladder reaches four coins) while the
simulator already held. The two engines trade the rule alike.

**Sleeve alone in the six-year replay** ($190 + $10 a week, whole account): shipped 11.3%/yr ·
Sharpe 1.39 · drop 6.2% · $4,059; M2 10.6% · 1.46 · 4.4% · $4,044. Before 2024-05: 18.0% → 16.0%,
drop 6.2% → 4.4%; 2024-05 → 2026-05: 0.7% → 2.5%, drop 5.4% → 3.6%.

**Check 3 — shadow log, to 2027-02-10.** Proposed without live code: once a month, replay live's own
candles with the rule off and on (`runSuperbot.mjs`, the preload) and list the trades that differ.
A gate log inside the live engine would need a second sleeve state there, since M2 also sells earlier.

## Perp positioning as a breakout filter (pre-registered 2026-11-25, before any futures data was read)

Idea: a breakout joined by new futures money continues; one made of short covering fades. Open
interest is not a function of the spot price, unlike most of what failed before.

- **Data:** Binance USDⓈ-M daily metrics files (`data.binance.vision/data/futures/um/daily/metrics/
  <COIN>USDT/`, 5-minute rows, from 2020-09-01), the 8 breakout coins, downloaded to the session
  scratchpad. Reachability was checked (HTTP 200); no row was read before this text was committed.
- **Trades:** the filled breakout trades of the six-year replay, bot + breakout as committed
  (`runSuperbot.mjs --cell bot+bo`, deep set, 2020-06-01 → 2026-08-10). Net return = P&L ÷ entry cost.
  Trades before 2020-09-01 or with no metric row in the 2 hours before the signal are left out and counted.
- **Signal time T:** the 4h close before the fill (fill time floored to 4h). Every value is the last
  row at or before T.
- **P1 (decides):** skip the breakout when open interest in coins (`sum_open_interest`) at T is below
  its value 24 hours earlier.
- **P2 (reported; counts only if P1 passes):** skip when the account long/short ratio
  (`count_long_short_ratio`) at T is above its median over the prior 30 days.
- **Pass, as section D:** the skipped trades' mean net return is below 0 **and** below the kept
  trades', and both hold in each half (fills before 2024-01-01, and from then on). A fail ends the
  idea; no other threshold, window or column is tried. The opposite sign is a new hypothesis, not a pass.
- **Stage 2, only on a pass:** the rule on both sides with a `liveParityInventory` row; the six-year
  replay must beat bot + breakout's Sharpe and its Sharpe in at least half of the 6-month folds.
- **Expected in advance:** a fail, more likely than not. About 250 trades is a small sample, funding
  (the nearest relative) already failed, and D9's taker-buy filter failed on these same trades.

### Result (2026-11-25): FAIL at the estimate, nothing built

Reference replay reproduced ($6,762.89; 257 filled breakouts). The metrics archive starts 2020-09-01
for BTC only; the other seven coins start 2021-12-01, so 168 trades could be scored (17 before
2020-09-01, 72 with no metric row). Script `positioning.py` in the session scratchpad.

| Rule | Kept: n · mean · before 2024 / 2024 on · P&L | Skipped: n · mean · before 2024 / 2024 on · P&L |
|---|---|---|
| P1 open interest below 24h ago (decides) | 148 · +0.53% · −0.60% / +0.89% · $466 | 20 · +0.65% · +0.51% / +0.74% · $31 |
| P2 long/short ratio above 30-day median (reported) | 138 · +0.78% · −0.69% / +1.31% · $627 | 30 · −0.52% · +1.15% / −1.03% · −$130 |

- **P1 fails:** the trades it skips made money in both halves, and more per trade than the kept ones.
  It also has little to act on: open interest was already rising at 148 of 168 breakouts.
- **P2 does not count** (P1 failed), and its sign flips between the halves on 7 and 23 trades.
- Per the pre-registration the idea ends here: no other window, threshold or column is tried.

## Part B: stopped at the fee check (2026-11-25)

- An API needs Interactive Brokers: about €1.25 minimum per Xetra order on tiered pricing, by
  third-party guides (not confirmed on IBKR's 2026 price list). Trade Republic (€1) and Scalable
  (€1.99) have no confirmed official trading API; their savings plans are free.
- Kraken xStocks (tokenised SPY, QQQ, GLD) is open to German retail, but its support page says
  order-book trading over the API is not available to EEA clients. Spreads are not published.
- With a few hundred dollars over four assets a slot is $50–100, so one order costs 1.25–2.5% and a
  round trip 2.5–5%. Rule T1 flips several times a year. Fees stop mattering at about €600–1,250 an
  order, which is €3–5k in this sleeve.

By the rule above the study is not built. Free daily history exists if the account reaches that
size (Yahoo adjusted closes: SPY, QQQ, GLD, IEF from before 2007; the EUR UCITS versions only from
2008–2010). Until then the answer is the benchmark: a free index ETF savings plan. Taxes unchecked.

## Setup on the research PC
- `git fetch && git switch plan/multi-asset-trend`, `npm install`, Node 22+.
- `data/` is git-ignored: copy it from the live host (without `dashboard_persist.json` and
  `position_state.json*`) or download again.
- No `.env`; run with `PAPER_MODE=true`.

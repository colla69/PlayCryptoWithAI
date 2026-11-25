# Other assets and the scalper/sleeve split

**Status (2026-11-25): Part A measured, the user's decision is open. Part B stopped at the fee
check; no study built.** Goal, in the user's words: money,
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

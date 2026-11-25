# Other assets and the scalper/sleeve split

**Status (2026-11-25): plan only. Nothing run, nothing built.** Goal, in the user's words: money,
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

## Setup on the research PC
- `git fetch && git switch plan/multi-asset-trend`, `npm install`, Node 22+.
- `data/` is git-ignored: copy it from the live host (without `dashboard_persist.json` and
  `position_state.json*`) or download again.
- No `.env`; run with `PAPER_MODE=true`.

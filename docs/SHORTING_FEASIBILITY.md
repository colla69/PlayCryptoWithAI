# Shorting / Bear-Side Hedging — Feasibility Note (Phase 6b)

**Status (updated 2026-09-28): closed — measured and rejected.** The open checklist below is now
answered by [`BEAR_SIDE_STUDY.md`](BEAR_SIDE_STUDY.md):

- **Perps (Route 6B):** Binance futures/derivatives are unavailable to users in Germany, Italy and
  the Netherlands (Binance announcement "Unavailability of Futures and Derivatives Products in
  Germany, Italy, and the Netherlands"). Route 6B is closed for this account.
- **Spot margin (the route this note never analysed):** EEA margin stays available with USDC
  borrowing (Binance "USDC is Now MiCA-Compliant…"), and 31 of the bot's 37 USDC pairs are
  margin-enabled. It was measured anyway: shorting BTC/ETH in `BEAR_TREND` earns inside deep bears
  (+22.8% in 2018, +16.6% in 2022 on proxy data) but loses across the cycle: as an overlay its Sharpe
  is 0.06 (deflated Sharpe 0.01) and negative in 2024–26, and it nearly doubles the book's max DD.
  Shorting alts on the scalper's SELLs worked in 2021–23 and lost in 2024–26. Rejected — not a
  regulatory call, a measured one.
- **Account-level check:** `src/scripts/probeMarginAccess.mjs` reads margin, futures and Earn access
  from the account itself with a read-only key. It no longer decides anything for shorting, since no
  short cell passed.
- Binance has had no MiCA authorisation since 2026-07-01; see the venue table in the study.

Route 6A (cash in `BEAR_TREND`) stays the bear-side answer. The original analysis follows unchanged.

> ⚠️ Regulatory facts below reflect general context as of this writing and **must be re-verified by
> the user for their own jurisdiction and account before any action**. This is an engineering
> feasibility analysis, not legal or financial advice.

---

## 1. Context

The user asked whether the bot could short ("if you feel frisky"), with the hard constraint of not
breaking the GUI or live↔backtest synchronicity. The plan split this into two routes:

- **Route 6A — cash-exit on bear (SHIPPED).** When BTC regime transitions into `BEAR_TREND`, close
  all open positions and block new entries until the regime leaves `BEAR_TREND`. This is the
  defensive obligation and it is already live (`src/engine/regimeRouter.js`, `bearPolicy.mode =
  'trend_only'`). It captures most of the downside-protection value of "going to cash in a bear"
  without leaving the spot-only, EU-compliant architecture.
- **Route 6B — actual short via Binance USDC perpetual futures.** Analysed here.

The current architecture is **Binance spot, USDC pairs only** — chosen deliberately for EU
compliance (USDC over USDT). Spot cannot short: you can only sell what you hold.

---

## 2. Route 6B: the regulatory blocker (assess first)

Actual shorting requires a derivatives venue (futures/perps) or margin borrowing. Both run into the
EU regulatory picture:

- **MiCA** (Markets in Crypto-Assets Regulation) governs crypto-asset services in the EU/EEA, with
  the services regime phasing in through 2024–2025.
- **Binance Futures / derivatives for EEA users** have been progressively restricted; Binance has
  notified EEA users of derivatives wind-downs/limitations. For an EEA-resident retail account,
  **USDC-margined perpetuals may simply be unavailable**, which makes Route 6B moot regardless of how
  cleanly we could build it.

**Action before any engineering:** the user must confirm, for their specific residency and Binance
account, that USDC-margined perpetual futures are (a) offered and (b) permitted. If not available,
stop here — Route 6A remains the answer.

Alternatives if Binance Futures is unavailable in-region are explicitly **out of scope** (new
exchange = violates the "Binance only" constraint; offshore access = compliance risk).

---

## 3. If 6B were available — engineering shape

Assuming the user confirms availability, the minimal, parity-preserving design:

| Concern | Approach |
|---|---|
| Execution | New `FuturesTrader` mirroring `LiveTrader`'s interface (`execute`, `getStatus`, position restore) but with inverted P&L and perp order types. `binanceClient.js` stays the sole exchange caller — add futures endpoints there. |
| Credentials | Separate `BINANCE_FUTURES_API_KEY` / `_SECRET` from `.env` (never in code). Futures-only API permissions; no withdrawal scope. |
| Margin / leverage | **Isolated margin, 1× leverage** at first. No cross-margin (one bad short can't drain spot collateral). |
| Entry rule | SHORT only on `BEAR_TREND` (never `BEAR_CHOP` — low-vol chop squeezes shorts). Reuse the existing regime classifier; SHORT is the symmetric counterpart of the bear cash-exit. |
| Slots / risk | **Max 1 short slot**, hard daily-loss gate stays at −5%, weekly DD breaker and position-aging apply identically. Shorts never stack with longs on the same underlying. |
| Funding cost | Perps charge funding every 8h. The backtester **must** model it from historical funding-rate data, or short backtests overstate edge. Source: Binance public funding history (read-only). |
| Liquidation | Model the maintenance-margin liquidation price; treat it as a hard stop strictly tighter than any strategy SL. |

### Live↔backtest synchronicity (the hard constraint)

This is the real cost. Today `PortfolioBacktester` simulates **spot longs only**. Route 6B requires:

1. A backtest path that opens/*closes* short positions with inverted P&L **and** funding accrual,
   reaching exact parity with `FuturesTrader` — same fill model, same fees, same funding.
2. The aggregator parity rule extends: a SHORT decision must be produced identically in live and
   backtest. The `BEAR_TREND`-only SHORT trigger is simple, but the exit logic (cover on regime
   flip, SL/TP, funding-aware) must be mirrored bar-for-bar.
3. New dashboard surfacing (short positions, funding paid, net exposure) — append-only, as always.

That is a multi-week project with real blow-up risk (a leveraged short in a low-vol squeeze is the
classic account-killer), which is why the plan classifies it as an **opt-in follow-up**, not part of
the robustness overhaul.

---

## 4. Recommendation

1. **Keep Route 6A as the bear-side answer.** It is shipped, spot-only, EU-clean, and already cuts
   bear-market drawdown (last_180d DD −5.9% → −2.9% in the cash-exit A/B). The user's stated priority
   is *low drawdown / don't run the bot into the ground* — cash-out achieves that without leverage.
2. **Do not implement Route 6B now.** It is gated on a regulatory availability check that is likely
   to fail for an EEA retail account, and it imports leverage/liquidation/funding risk plus a heavy
   parity burden for a marginal, conditional upside.
3. **Re-open only if** the user confirms USDC-perp availability for their account *and* explicitly
   accepts leverage risk. At that point this note's Section 3 is the build spec; ship it as an
   isolated, 1×, 1-slot, `BEAR_TREND`-only module behind a default-OFF config flag with full
   backtest parity before a single live order.

---

## 5. Decision checklist (for the user)

- [x] Confirm Binance USDC-margined perps are offered to my account/region under current rules.
      → **No** (2026-09-28): Binance derivatives are unavailable to users in Germany.
- [x] Confirm I accept leverage + liquidation + funding-cost risk on a hedging sleeve.
      → Moot: the short sleeve was measured on spot margin instead and failed on its merits
      ([BEAR_SIDE_STUDY.md](BEAR_SIDE_STUDY.md)).
- [ ] ~~If both yes → greenlight the Section 3 build~~ — not reached.
- [x] If either no → Route 6A (already live) is the final answer; close this out. → **Closed.**

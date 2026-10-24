# Notes: external bots answer (verbatim, 2026-10-24)

Saved verbatim from a Claude Code session on 2026-10-24, answering "Nothing interesting we could
need in this project [NostalgiaForInfinity]? Do you know other bot worth looking at?". File and
line references are to commit `401e898`. The checked and expanded version is
[EXTERNAL_BOTS_REVIEW.md](../EXTERNAL_BOTS_REVIEW.md); the stop gap is item 4 in
[the backtester follow-ups](2026-09-backtester-parity-followups.md).

---

**Short answer: there's one idea worth taking, but it comes from Freqtrade (the framework NFI runs on), not from NFI. It points at a real gap in your backtester.**

## The gap: stops are checked at different times in live and in backtests

- **Live:** `src/main.js:1296` checks stop-loss, trailing stop and break-even every 2 minutes against ticker prices.
- **Backtest:** `portfolioBacktester.js:796` passes `price: Number(candle.close)` to the simulator. The checks at `backtestSimulator.js:165` and `:172` only compare against that close. So stop-loss, take-profit, trailing stop and the +5% break-even trigger are only checked once per 12h bar, at the close. The bar's high and low are never used for exits.

Over a 12h bar, this changes results in both directions:
- **Backtest too optimistic:** A wick through the stop that recovers by the close stops you out live but not in the backtest.
- **Backtest too pessimistic:** A crash that closes far below the stop fills at the close in the backtest, but near the stop live.
- **Missed events:** An intra-bar spike to take-profit or to +5% counts live but not in the backtest. The trailing stop's high-water mark also tracks only closes.

So I can't tell whether your baseline is too high or too low without measuring it. I found no row in `liveParityInventory.test.js` and nothing in `docs/` that covers this. Freqtrade solves it with `--timeframe-detail`, which replays exits on smaller candles inside each bar. You already require 15m data for every symbol, so the backtester could check exits on the 15m bars inside each 12h bar. If a 15m bar touches both the stop and the target, count the stop first. I only read the portfolio backtester path, not the optimizer's.

Under your own rules this belongs in the engine, with an inventory row. If the baseline gets worse after the fix, that's the true performance showing, not a reason to revert. Should I build it in a worktree?

## What else NFI has
- **Profit-tiered exits:** `long_exit_main` uses 1% profit bands, and the RSI level that triggers an exit rises with the band (RSI below 10 at +0–1%, below 28 at +1–2%, below 30 at +2–3%, and so on). A coarse version (an exit threshold that loosens as profit grows) could be tested against your fixed stops and targets. But NFI tunes each band by hand, which is exactly the overfitting risk.
- **The rest doesn't carry over:** NFI uses 5m candles with 15m, 1h, 4h and 1d as extra timeframes, and has 51 numbered entry conditions across 10 modes (grind, rebuy, pump, scalp…). The grind and rebuy averaging-down logic conflicts with your rule against sizing up after losses.

## Other bots worth reading
These are from what I already know (as of mid-2026), not checked today. All are Python, so you'd take ideas, not code.

- **Freqtrade itself:** besides `--timeframe-detail`, its `recursive-analysis` tool checks whether indicator values change with how much history you load. That matters for you because live computes indicators on a fetched window, while the backtest uses slices of full history. EMA200 and ADX depend on where the series starts. I haven't checked whether your bot pins the window length.
- **NautilusTrader:** the same strategy and risk code runs in backtest and live, and only the data and order adapters change. Your parity table is the cost of not having that design.
- **Jesse:** a simpler version of the same idea, with multiple timeframes and no lookahead.
- **López de Prado's methods (in `skfolio`):** combinatorial purged cross-validation and probability-of-backtest-overfitting (PBO). These would be the next step after your deflated Sharpe and walk-forward, for an optimizer that picks combos across 37 symbols.
- **Skip:** Hummingbot (market making), Passivbot and grid bots (averaging down), OctoBot and Superalgos (less rigorous), Gekko and Zenbot (abandoned).

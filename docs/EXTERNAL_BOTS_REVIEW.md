# External bots review (2026-10-24)

What other open-source trading bots do that this bot could use, and what it should not copy.

**Sources.** The NostalgiaForInfinity facts come from its README and a shallow clone of `main` at
commit `6d45984` (2026-10-24). The facts about this bot come from reading its code at `401e898`.
The notes on Freqtrade's tools, NautilusTrader, Jesse, vectorbt and skfolio come from general
knowledge as of mid-2026 and were not re-checked against those projects.

## Summary

- One finding needs action: the backtester checks stops once per 12h bar, at the close, while
  live checks them every 2 minutes. It is item 4 in
  [the backtester follow-ups](plans/2026-09-backtester-parity-followups.md).
- NostalgiaForInfinity has one idea worth a test (exits that loosen as profit grows) and a lot
  that this bot should not copy (averaging down, hundreds of hand-tuned thresholds).
- NautilusTrader shows the architecture that would make most parity breaks impossible: one engine,
  with only the data and order adapters changing between backtest and live.

## NostalgiaForInfinity (iterativv/NostalgiaForInfinity)

A strategy for the Freqtrade framework. GPL-3.0, about 3k GitHub stars, updated often.

| Property | Value |
|---|---|
| Main timeframe | 5m (`timeframe = "5m"`) |
| Extra timeframes | 15m, 1h, 4h, 1d (`info_timeframes`); BTC on 4h (`btc_info_timeframes`) |
| Size | `NostalgiaForInfinityX7.py` alone is 79,825 lines; the eight `X*` files total ~417k |
| Entry conditions in X7 | 51 numbered conditions across 10 modes (normal, pump, quick, rebuy, rapid, grind, scalp, …) |
| Recommended setup | 6–12 open trades, 40–80 stablecoin pairs, volume pairlist, leveraged tokens blacklisted |
| Published validation | none: the README points to comments on individual commits for backtests |

### Worth testing here

**Exits that loosen as profit grows.** `long_exit_main` splits open profit into 1% bands. Above
EMA200, it exits at RSI-14 < 10 when profit is 0.1–1%, < 28 at 1–2%, < 30 at 2–3%, < 32 at 3–4%,
and so on. So the bigger the open profit, the smaller the momentum drop needed to take it. This
bot uses fixed per-symbol stops and targets, a break-even stop at +5%, and a 0.7× exit threshold
when SELL votes lead. A coarse version (two or three bands, not one per 1%) is a candidate. Test it
like any exit change: full filter stack, `runBaseline.mjs`, forward-only walk-forward. NFI tunes
every band by hand, which is the overfitting risk to avoid.

### Do not copy

- **Grind and rebuy (averaging down).** `long_grind_adjust_trade_position` and
  `long_rebuy_adjust_trade_position` add to losing positions. Loss thresholds such as
  `stop_threshold_doom_spot = 0.20` and `regular_mode_derisk_1_spot = -0.24` decide when to cut
  them (the exact mechanics were not traced). Averaging down raises the win rate and hides drawdown
  until one large loss. It conflicts with this project's rule against sizing up after
  losses.
- **Hundreds of hand-tuned thresholds.** No walk-forward, deflated Sharpe or out-of-sample result is
  published. A rule set this large, fitted to history by trial and error, is expected to do worse
  live than in backtests.
- **Its timeframe choices.** A 5m strategy with 6–12 positions has a different cost and noise
  profile from this 12h, 4-position bot. Its thresholds do not transfer.

### Small ideas

- **Update sidecar.** The `nfi-updater` container checks GitHub on a cron schedule and restarts the
  bot only when files changed.
- **Pair hygiene.** Stablecoin quote pairs and a maintained blacklist. This bot already covers the
  dangerous case (frozen series) with `checkCandleFreshness()`.

## Freqtrade (the framework)

More useful here than NFI itself:

- **`--timeframe-detail`** replays exits on smaller candles inside each bar. This is the fix for
  the close-only stop check (follow-ups item 4). The 15m data it needs is already required for
  every tested symbol.
- **`recursive-analysis`** checks whether indicator values change with how much history is loaded.
  Live computes indicators on a fetched window, while the backtester uses slices of the full
  history. EMA200, ADX and other recursive indicators depend on where the series starts. Not yet
  checked: whether this bot pins the window length on both sides.
- **`lookahead-analysis`** compares signals computed on full data with signals computed bar by bar.
  This bot's `candles.slice(0, -1)` rule covers the same risk by construction.

## NautilusTrader — the architecture this bot does not have

NautilusTrader (Python on a Rust core) runs the **same** strategy, risk and order-management code in
backtest and live. Only two adapters change: the data client (historical replay or live feed) and
the execution client (simulated exchange or real exchange). A rule cannot exist on one side only,
because there is only one side.

This bot has two engines:

- **Live:** `main.js` orchestrates `signalAggregator.js`, `riskManager`, `portfolioRisk.js`,
  `positionSizing.js` and `liveTrader.js` / `paperTrader.js`.
- **Backtest:** `PortfolioBacktester` and `BacktestSimulator` re-implement the cycle and call some
  of the same modules.

Parity is kept by extracting shared modules (`aggregatorVoting.js`, `exchangeLimits.js`,
`mergeCandles.js`, `buildCorrelationMatrix`) and by tests (`aggregatorParity.test.js`,
`liveParityInventory.test.js`). All nine breaks in the parity table, and the close-only stop
check, are places where the two engines differ. Even the stop rules exist twice:
`liveTrader.js` and `paperTrader.js` import `calcTrailingStop` and `calcBreakEven` from
`traderUtils.js`, while `backtestSimulator.js` re-implements them, and its copy has already gained
a knob (`trailArmPct`) that live does not have.

The two-engine layout dates from the first commit (`c3529a5`, 2026-05-20), which already had
`backtestSimulator.js`.

### Moving towards one engine without a rewrite

A rewrite of a bot that trades real money is the riskiest option. A path in steps:

1. **One decision core.** Move every per-cycle decision (aggregate, gate, size, exit check) into
   pure functions that take candles, positions and account state and return actions. Live and the
   backtester both call them; neither keeps its own copy. The stop rules (`traderUtils.js`) are the
   first candidate, because follow-ups item 4 needs them shared anyway.
2. **One clock and event loop.** A replay data source emits the same "bar closed" and "price tick"
   events that the live scheduler and price poll emit. The 15m replay for item 4 is the first
   "price tick" source.
3. **One order path.** `paperTrader`, `liveTrader` and `BacktestSimulator` become execution adapters
   behind one interface. The simulator keeps the fill model (next open, slippage tiers, min notional).

Each step is its own PR with a before/after baseline. When step 1 is done,
`liveParityInventory.test.js` can check that both sides call the same function, not only that a
substring is present on both sides.

## Other projects

| Project | What to take | Notes |
|---|---|---|
| Jesse | Same design idea as Nautilus, smaller: one strategy class runs in backtest and live; multiple timeframes without lookahead | Python |
| vectorbt | Fast parameter sweeps and robustness heatmaps: check that a chosen parameter sits on a plateau, not on a spike | Python; research only |
| skfolio (López de Prado methods) | Combinatorial purged cross-validation and probability of backtest overfitting (PBO): the next step after deflated Sharpe for an optimizer that picks combos across 37 symbols | Python; research only |

**Not worth the time:** Hummingbot (market making, a different business), Passivbot and grid bots
(averaging down), OctoBot and Superalgos (less rigorous validation), Gekko and Zenbot (abandoned).

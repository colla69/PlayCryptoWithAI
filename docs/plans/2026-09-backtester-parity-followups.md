# Plan: backtester measurement gaps found while fixing its clock (2026-09-29)

**Status (2026-10-24): all twelve items fixed** on branch `feat/backtester-reconciliation`, except
the calibration notes at the end. The original analysis of each item is kept below.

| Item | Side | Fix |
|---|---|---|
| 1. Fills and gates one bar off | backtester | fills at the cycle-time open (`d.price`); gates on bars closed by `T` (`closedIdx`, `MIN_WARMUP - 1`); the optimizer and the single-symbol backtester follow |
| 2. Equity marks one position | backtester | one `markEquity` point per step, every position at its latest price |
| 3. Held symbol with no bar | backtester | stops still replay; bear cash-exit at the last known price |
| 4. Stops at the close only | backtester | `replayBar` on each period's 15m bars through the shared helpers; stop before target; gaps fill at the open |
| 5. Stale bar on thin pairs | live | `withFormingBar` |
| 6. Failed klines loses the cycle | live | one retry after 2 s (`refreshSymbolCandles`) |
| 7. Private strategy builders | backtester | `baselineFramework` and `walkForward` import live's `buildStrategiesForSymbol` |
| 8. Asymmetric exit live-only | backtester | `sellMajority` + 0.7× threshold |
| 9. MTF caches on a boot timer | live | refreshed at each cycle; filters read bars closed by now (`closedNow`) |
| 10. Aging exit one cycle late | live | age from the start of the opening bar |
| 11. ATR sizing never applied | backtester | `FULL_LIVE_FILTERS` reads `config.atr` |
| 12. Gates on the previous cycle's candles | live | fetch first, then matrix / median ATR / macro / regime from `closedCandles()` |

**Left, calibration not timing:** the simulator's slippage tier (0.2% for mid caps) also moves the
break-even reference, while live's fills in the replay had about zero slippage (INJ, PEPE exit
at break-even earlier than live). PEPE's prices also lose precision at 8 decimals.

## 1. Entries and exits fill one bar later than live

Every strategy drops the last candle it is given (`candles.slice(0, -1)  // exclude forming candle`,
all 20 files in `src/strategies/`), because live hands the aggregator a series whose last bar is
still forming. `#precomputeData` hands it `candles.slice(0, i + 1)` where bar `i` is *closed*, so
row `i`'s decision is made on bars `0..i-1` — and is then filled at `d.nextOpen`, the open of bar
`i + 1`.

| | Decision uses | BUY fills at | SELL fills at |
|---|---|---|---|
| Live (cycle at close of bar `i-1` + 3s) | bars `0..i-1` | ≈ open of bar `i` | ≈ open of bar `i` |
| Backtest row `i` | bars `0..i-1` | open of bar `i + 1` | close of bar `i` |

So the backtest trades 12h after live on the same signal. This is lag, not lookahead: it is
pessimistic or optimistic depending on whether the edge decays within a bar, and there is no way to
know which without measuring. The backtest-reviewer checklist states the intended model ("the
earliest real fill is the open of candle `i`") but the code fills at `i + 1`.

The MTF, 4h, regime and macro gates at row `i` read data through the close of bar `i` — consistent
with a fill at `i + 1`, but one bar more than live has at decision time.
**Measured 2026-10-24** (reconciliation layer 2): on the 31 live BUYs the gates as coded give
live's pass/block 28/31 times and live's logged value 2/25 times; computed from bars closed by the
cycle time they give 31/31 and 12/25 (15m and momentum exact). So the fix target for the gates is
"bars closed by `T`", not "through bar `i`".

**Fix shape:** decide on bars `0..i` (pass `slice(0, i + 2)` so the strategies' drop-last lands on
bar `i`, or feed a synthetic forming bar) and fill at `nextOpen` — or keep the slice and fill at
the open of bar `i`. The gates must move with it. `perSymbolOptimizer.aggregate()` and the parity
fixture (`tests/engine/aggregatorParity.test.js`) must follow, since the optimizer precomputes the
same way. Re-baseline, then re-run the optimizer: the per-symbol thresholds were selected under the
lagged fill.

## 2. The equity curve marks only one open position at market

`BacktestSimulator.#recordEquitySnapshot(symbol, price)` values the symbol being executed at
`price` and **every other open position at its entry price**. The portfolio backtester records one
snapshot per symbol per step, so:

- **Max drawdown** (over every point) sees one position's unrealised loss at a time. Four positions
  each 10% under water show as a 2.5%-of-book dip four times, never as the real 10%.
- **Sharpe / DSR** (last point per UTC day) see the last symbol executed that day, usually one with
  no position — i.e. close to realised-only equity, which understates volatility.

A two-symbol probe (one position 30% under water, a flat symbol executed after it) produces equity
points alternating 700 / 1000 within the same bar; the day's closing point reads 1000.

Two more consequences: `finalBalance` is the last equity point, so a window's headline return is
misstated whenever positions are still open at its end; and the snapshot taken on a BUY marks the
new position at the signal close (`d.price`), not at its fill.

**Fix shape:** after each step's executions, record one equity point with every open position
marked at its latest price (the backtester has every symbol's row at the step; a symbol with no
bar keeps its last known price). Keep the per-execute points out of the metrics. Re-baseline: the
"drawdown under 5% on every window" reading in `docs/STRATEGY.md` was measured on this curve.

## 3. A held symbol with no bar at a step is skipped entirely

The engine now steps on one clock, and a symbol with no bar at a step (a hole in its history, or
delisted mid-run) simply has no row that step. A position held in it gets no SL/TP check, no aging
exit, no bear cash-exit and no mark until its next bar. Aging matches live (live's aging exit runs
after the freshness guard), but two do not:

- **Bear cash-exit:** live closes every non-core position on the transition into `BEAR_TREND`
  regardless of its candle state; the backtest skips a gapped symbol on that bar, and the exit
  fires only on the transition, so the position survives the bear.
- **SL/TP:** live's price poll manages stops from the ticker; the backtest waits for the next bar.
- A symbol delisted with a position open holds its slot to the end of the run.

Rare on 12h data (the old index-stepping engine had the same behaviour past an array's end), but it
belongs with item 2: once every step marks all positions, it can also exit them at the last known
price.

Also noted: live's macro filter (`main.js`, `isBullTrend(getCandles('BTC/USDC'))`) reads the
forming bar, while live's regime classifier drops it — a live-side inconsistency to settle with
item 1.

## 4. Stops are checked once per bar, at the close (added 2026-10-24)

Found while comparing the bot with Freqtrade's `--timeframe-detail` (see
[EXTERNAL_BOTS_REVIEW.md](../EXTERNAL_BOTS_REVIEW.md)). Read at commit `401e898`; not measured yet.

| | Price fed to the stop check | How often |
|---|---|---|
| Live / testnet | ticker `last` (`main.js`, fast risk loop, `RISK_CHECK_MS = 2 * 60_000`) | every 2 min |
| Backtest | `price: Number(candle.close)` (`portfolioBacktester.js` `#precomputeData`) | once per 12h bar |

`BacktestSimulator.#checkRisk` compares only that close against SL and TP. The bar's high and low
are never used for exits. On a 12h bar this moves results both ways:

- **Optimistic:** a wick through the stop that recovers by the close stops live out; the backtest
  holds.
- **Pessimistic:** a crash through the stop that closes far below it fills at the close in the
  backtest; live fills near the stop.
- **Missed events:** a take-profit, the +5% break-even trigger, or a new trailing high reached
  inside the bar counts live and not in the backtest.

The fast risk loop runs only when `!paperMode`, so paper mode does not have the 2-minute check
either. `PaperTrader.#checkRisk` is reached only through `execute()`, i.e. once per signal cycle
(its own `markPrice` comment says so), and the 5 s price poll only marks positions. So paper
matches the backtest on stop timing, not live. A paper run is therefore not a faithful shadow of
live until the risk loop also runs in paper mode.

**The stop logic also exists twice.** `paperTrader.js` and `liveTrader.js` import
`calcTrailingStop` and `calcBreakEven` from `traderUtils.js`. `backtestSimulator.js` imports only
`calcPartialExit` and `calcATRStopPrices`, and re-implements both rules inline
(`checkAndUpdateTrailingStop`, `#checkRisk`). The copies have already drifted: `trailArmPct`
exists only in the simulator. It is a research knob for riding mode with default 0, so it does not
change the baseline today. The `Break-even stop` row in `liveParityInventory.test.js` passes on the
substring `breakEven` on both sides, so it cannot see either difference.

**Fix shape:** replay each 12h bar's exits on its 15m bars (every tested symbol already needs
`{COIN}_USDC_15m.json`), in time order. When one 15m bar touches both the stop and the target,
count the stop first. Fill a stop at `min(stop, bar open)` so a gap down fills at the open. Make
the simulator call `calcTrailingStop` and `calcBreakEven` instead of its own copies. Keep the
`trailArmPct` check in the simulator, around the shared call, so `traderUtils.js` and live do not
change. Pin the inventory row to the shared helpers.
Re-baseline: if the metrics get worse, that is the measurement getting honest, not a regression to
revert. Then re-run the optimizer, since its per-symbol stops were chosen under close-only exits.
Check `perSymbolOptimizer` — this item was read on the portfolio backtester path only.

## 5. Live can decide on a stale bar for thin pairs (added 2026-10-24) — FIXED 2026-10-24

**Fixed** on branch `feat/backtester-reconciliation`: `src/utils/formingBar.js` (`withFormingBar`)
adds a flat placeholder bar for the current period when the newest bar is the one that just
closed. `runCycle` sends that series to the aggregator, the entry filters, sizing and ATR, and
`runInitialSignals` sends it to the aggregator. The candles held in `dashboardState` are not changed, so
the placeholder is never persisted. Proof: `tests/utils/formingBar.test.js` (all 20 strategies
and the aggregator for every configured symbol give identical results with the placeholder and
with a real forming bar), plus a replay of the five affected symbols on the frozen candles: the
old behaviour reproduces all 37 mismatches (MANTA's carry-over included), the fix gives 0 over 131
cycles each. Inventory row: "Decision series ends with the forming bar". It ships as its own live
release. The original analysis follows.

Found by the live reconciliation ([layer 1](2026-10-single-engine-rebuild.md#steps)), not by reading
code. **This one is a live-side defect**, not a backtester gap: the backtester already assumes the
bar is present, so it is the reference and live is what moves.

The cycle fires at candle close + 3 s. If the exchange has no bar yet for the new period (a thin
USDC pair with no trade in its first seconds), the fetched series ends at the bar that just
closed. Every strategy drops its last bar (`slice(0, -1)`, assuming it is the forming one), so it
drops the bar that just closed and decides one bar older than the backtester does. Live logged it:
`[CYCLE] ENS/USDC … lastTs=2026-10-07T12:00:00.000Z` at `2026-10-08T00:00:04Z`.

Measured 2026-08-20 → 10-24: 37 of 4,307 compared signals, all in ENS, JUP, THETA, MANTA and BNB;
0 mismatches in the 1,943 logged cycles whose series included the forming bar. No order was
affected (no BUY on either side, no held position) — but a BUY on a thin pair would be.

**Fix shape:** make the decision series independent of whether the new bar has printed. Either
drop bars by timestamp (everything with `timestamp >= cycle open`) in one shared helper that all 20
strategies call, or have `runCycle` append a placeholder forming bar when the newest bar is older
than the cycle's open time. Prove "no change elsewhere" with the reconciliation: the 4,270 matching
signals must stay identical and the 36 stale-bar ones must move to match. Add a row to
`liveParityInventory.test.js` and a test that feeds a series ending one bar early.

## 6. A failed `klines` call loses the symbol's cycle for 12 h (added 2026-10-24)

Six cycles in 30 days (LTC, THETA, LDO, TIA, BTC, RENDER) died on `binance … 500` or `-1001` 8–10 s
after the close, when the exchange is busiest. `runCycle` logs `cycle failed` and returns; nothing
retries, so a 12 h strategy misses that symbol's whole bar. The backtester has no failures.
Not a decision-logic parity break, but a measurable live-only loss. **Fix shape:** one retry with a
short backoff for transient 5xx / `-1001` inside `runCycle`, before the freshness check.

## 7. The backtester builds strategies with its own copy of the builder (added 2026-10-24)

`baselineFramework.js` has `STRATEGY_BUILDERS` with 15 strategies and defaults a symbol with no
`strategies` list to `['RSI']`. Live's `strategyBuilder.js` has 20 and defaults to all of them.
`portfolioBacktest.mjs` carries a third copy. No live symbol uses the five newer strategies today,
so results do not differ — the first config that does would crash the backtester or silently drop
a voter. **Fix shape:** have the backtester import `buildStrategiesForSymbol`; this belongs in step
3 (one decision core). `runReconciliation.mjs` already uses live's builder.

## 8. Asymmetric exit has no backtest counterpart (added 2026-10-24, unmeasured)

`main.js` ("Easier SELL for open positions") lowers the exit bar to 0.7× when a position is open and
SELL votes are a majority. Nothing in `src/backtester/` does, and `liveParityInventory.test.js` has
no row for it. The reconciliation could not measure it: the rule never fired in the 2026-08 → 10
live window (0 log lines, 0 held SELL records). Keep it open until a live period exercises it; then
either implement it in the backtester or move it to `INTENTIONALLY_LIVE_ONLY` with a reason.

## 9. Live's 15m and 4h filter data depends on boot time (added 2026-10-24)

Found by layer 2 of the live reconciliation. **A live-side defect.** `runCycle` reads 15m and 4h bars
from `mtf15mCache` / `mtf4hCache`. `refreshMtfCache` fills them on a `setInterval` that starts at
boot (15 min and 4 h). So what the filters see at a cycle depends on when the bot last booted:
before the 2026-10-17 boot the 4h refresh ran at `:43:56` (03:43, 07:43, …), after it at `:06`.
At a 00:00 cycle the newest 4h bar is the 20:00 bar, fetched 17–54 min before the close while it
was still forming. The filter then scores that part-formed bar as if it were the newest closed one.
The rules already ban this pattern for the cycle itself ("cycle timing from a fixed
`setInterval`").

Measured: computed from bars closed by the cycle time, the 15m score and momentum match live's
logged values exactly, and pass/block agrees on 31 of 31 live BUYs. The 4h score is off by 1–4
points on most blocked BUYs. No pass/block flipped in this window, but a score near 45% would flip.

**Fix shape:** at each cycle, use only 15m and 4h bars closed by the cycle time. Either refresh both
caches right after each candle close (before the cycle reads them), or drop bars with
`timestamp + period > cycle time` before scoring. Then make the backtester read the same bars
(item 1), so both sides use "bars closed by `T`" — the method layer 2 shows reproduces live.

## 10. Live's aging exit fires one cycle late (added 2026-10-24)

Found by layer 3 of the live reconciliation. `main.js` measures a position's age from `openedAt`,
the order's fill time, about 15 s after the cycle that opened it. At the cycle 14 bars later the
age is 14 bars minus ~12 s, so `calcPositionAgingExit` does not fire, and the exit comes one cycle
(12 h) later: BTC opened 2026-09-19 00:00:15, closed 09-26 12:00 (held 180 h = 15 bars). The
backtester measures from the bar time and exits at 14 bars. **A live-side defect:** the rule says
14 bars. **Fix shape:** count bars from the start of the period the position was opened in
(`floor(openedAt / period) * period`). It changes when live exits, so it is its own release.

## 11. Backtests never applied ATR sizing (added 2026-10-24) — FIXED in the backtester

Found by layer 3. Live sizes every entry with `applyATRSizing` (`config.atr.enabled: true`):
`basePct × clamp(medianATR / symbolATR, 0.5, 2)`. The backtester has the same rule
(`atrPositionSizing`), but `FULL_LIVE_FILTERS` never turned it on, and `liveParityInventory`
had no row, so every baseline and walk-forward was sized without it. BTC 2026-09-19: live 0.273 of
free balance, backtest 0.141. **Fixed:** `FULL_LIVE_FILTERS` sets `atrPositionSizing` from
`config.atr`, the backtester's ATR% calls live's `computeATRPct`, and the inventory has the row.
**Left:** live's median ATR runs over every configured symbol, the four frozen pairs included,
at the start of the cycle loop; the backtester's runs over the symbols with a bar at the step.
The replay's remaining size errors (0.004–0.010) fit that and item 1.

## 12. Live's cycle-level gates read the previous cycle's candles (added 2026-10-24)

Found while reconciling the sizing. **A live-side defect.** `runAllSymbols` computes the
correlation matrix (`buildCorrelationMatrix`), the median ATR for sizing, the macro filter
(`isBullTrend` on BTC) and the regime (`regimeTracker.update`) **before** `runCycle` fetches each
symbol's new candles, and nothing else updates `dashboardState` candles between cycles. So at the
cycle on `T` every series still ends with the bar that was seconds old at the previous cycle. The
regime drops it (`btc.slice(0, -1)`) and classifies on the bar that closed at `T − 12h`; the macro
filter and the median ATR read that seconds-old bar as the newest. Log evidence: the 3 `[REGIME]`
lines that print the BTC close all show the close of the bar ending 12 h before the cycle (e.g.
2026-10-09 00:00: logged 82455 = the 10-08 00:00 bar; the bar that had just closed: 81718).

The backtester reads these gates through bar `T`'s close (item 1), so for regime, macro, the
correlation cap and the median ATR the two sides are 24 h apart. The TSM sleeve runs after the
fetches and is not affected: its replayed votes match live on 118 of 118 logged cycles.

**Fix shape:** in `runAllSymbols`, fetch and merge every symbol's candles first, then compute the
matrix, median ATR, macro and regime from bars closed by `T` (through `withFormingBar`), then run
the per-symbol decisions. Then move the backtester's gates to "bars closed by `T`" (item 1), so both
sides meet in the middle. It changes live entries and sizes, so it is its own release.

**Item 11 before/after (2026-10-24).** Deep set (`126 36a73a13…`), research context files,
`runBaseline.mjs`. First the new engine with `atrPositionSizing` forced off: its summary equals
`data/mac_bl_c3_summary.txt` line for line, so every other change on the branch is an identity.
Then with ATR sizing on (`data/mac_bl_atron_summary.txt`):

| Window | c3 | ATR sizing (as live) |
|---|---|---|
| last_90d | +0.25%, Sh 0.14, DD −3.28% | −2.51%, Sh −1.68, DD −2.68% |
| last_180d | +62.43%, 2.37, −4.20% | +37.42%, 2.45, −2.81% |
| y2_365d | +25.09%, 1.36, −4.37% | +13.33%, 1.16, −4.77% |
| y1_holdout | +91.95%, 2.72, −5.33% | +86.48%, 2.72, −4.88% |
| y1y2_full | +137.59%, 2.04, −8.84% | +113.08%, 2.05, −6.78% |
| full_history | +140.68%, 1.08, −8.84%, DSR 0.13 | +115.44%, 1.03, −8.52%, DSR 0.10 |

Trade counts are the same in every window; only sizes change. Forward-only walk-forward at live
sizing (`runWalkForward.mjs --live-sizing`): +80.82% / Sharpe 1.20 / DD −4.00% / DSR 0.22 →
+68.69% / 1.21 / −3.81% / 0.23, 75 trades both. Returns fall about a sixth, risk-adjusted metrics
are equal or slightly better. This is the measurement getting honest — live already sizes this
way — so it is kept, not reverted. Every earlier baseline number overstates live's return by that much.

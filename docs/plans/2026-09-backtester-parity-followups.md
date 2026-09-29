# Plan: backtester measurement gaps found while fixing its clock (2026-09-29)

**Status: open — not fixed.** Found while fixing the portfolio backtester's time alignment
(branch `fix/backtester-time-alignment`). Items 1 and 2 change every window's metrics, so each gets
its own PR and its own before/after baseline. None was folded into the alignment fix, which had to
be shown to be an identity on aligned data.

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

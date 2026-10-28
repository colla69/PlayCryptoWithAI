/**
 * One coin's trial through the live filter stack, for the per-symbol optimizer
 * (plan 2026-10 single-engine rebuild, section E item 4).
 *
 * The optimizer used to score each combo on its raw votes in a bare simulator: no
 * 15m/4h/momentum/regime gates, no multi-bar confirmation, no live sizing. It picked
 * combos the live bot never trades (C8: 21 of 37 coins took 0 trades in six years).
 * A trial here is a `PortfolioBacktester` run — the engine `engineReplayParity`
 * holds equal to live — in which only the coin under test has strategies. Every
 * other coin is context: its bars feed the regime and macro gates (BTC) and the
 * median ATR that sizes the entry, and it never trades. What a single-coin trial
 * cannot show is the competition for the 4 slots and the correlation cap; the
 * portfolio replay (`runSuperbot.mjs`) stays the deciding test for a config change.
 *
 * Speed: the strategies' results are computed once per coin and replayed through
 * the real `SignalAggregator` (multi-bar memory included) for each combo, so a
 * combo costs one vote pass and one portfolio run.
 */
import { PortfolioBacktester } from './portfolioBacktester.js';

const MIN_WARMUP = 50; // PortfolioBacktester's first row

/**
 * Each strategy's result at every bar from the first row on, keyed by the bar's
 * timestamp. A result depends only on the bars up to its own, so one pass over the
 * full history serves every window cut from it.
 * @param {Array} candles
 * @param {Record<string, {analyze: Function}>} strategies — name → instance
 */
export function precomputeStrategyResults(candles, strategies) {
  const out = {};
  for (const [name, strategy] of Object.entries(strategies)) {
    const byTs = new Map();
    for (let i = MIN_WARMUP; i < candles.length; i++) {
      byTs.set(Number(candles[i].timestamp), strategy.analyze(candles.slice(0, i + 1)));
    }
    out[name] = byTs;
  }
  return out;
}

/** A strategy that answers from `precomputeStrategyResults` output. */
export function cachedStrategy(name, byTs) {
  return {
    analyze(candles) {
      const ts = Number(candles.at(-1).timestamp);
      const r = byTs.get(ts);
      if (!r) throw new Error(`${name}: no cached result at ${new Date(ts).toISOString()}`);
      return r;
    },
  };
}

/**
 * The context of one window, computed once and shared by every trial in it: every
 * coin's rows with no strategies (always HOLD) and the run's candle-only series.
 * @param {object} args
 * @param {Record<string, Array>} args.symbolCandles — every coin, cut at the window's end
 * @param {object} args.btConfig — PortfolioBacktester config (live filters, sizing, tradeFromTs)
 */
export function trialContext({ symbolCandles, btConfig }) {
  const bt = new PortfolioBacktester(
    Object.fromEntries(Object.keys(symbolCandles).map((s) => [s, []])),
    btConfig,
  );
  const rows = bt.computeSignalRows(symbolCandles);
  const shared = bt.computeSharedSeries(symbolCandles);
  bt.destroy();
  return { symbolCandles, btConfig, rows, shared };
}

/**
 * Run `symbol` alone with `strategies` at `minConfidence` (raw, as config holds it;
 * the backtester scales it like live), on top of the window's context.
 * @returns the PortfolioBacktester result
 */
export function runSymbolTrial(ctx, { symbol, strategies, minConfidence }) {
  if (!ctx.symbolCandles[symbol]) throw new Error(`${symbol}: not in the trial context`);
  const bt = new PortfolioBacktester({ [symbol]: strategies }, {
    ...ctx.btConfig,
    symbolMinConfidence: { ...(ctx.btConfig.symbolMinConfidence ?? {}), [symbol]: minConfidence },
  });
  try {
    // The context rows hold this coin's price-only fields already; only the vote is new.
    const own = bt.computeSignalRows({ [symbol]: ctx.symbolCandles[symbol] }, { base: ctx.rows });
    return bt.run(ctx.symbolCandles, { rows: { ...ctx.rows, ...own }, shared: ctx.shared });
  } finally {
    bt.destroy();
  }
}

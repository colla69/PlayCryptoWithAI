/**
 * runBearSide.mjs — what should the bot do with its capital in a bear market?
 * (docs/plans/2026-09-bear-side-and-weekly-review.md, Phase 1)
 *
 * Sim-only research. Touches no live code or config and places no orders. Fills are
 * honest: decide on CLOSED bar i, execute at bar i+1 OPEN, 0.1% fee per leg + tiered
 * slippage, no lookahead.
 *
 * ── PRE-REGISTERED (written before the first run; every cell is reported) ──────────
 * Book B0 — the bot as it trades today:
 *   scalper  = PortfolioBacktester via runWindow, full live filter stack, 0.15 base size
 *              (bear policy: flat and blocked while BTC regime is BEAR_TREND)
 *   TSM long = vote 60/90/120 bars, enter 3/3, stay ≥2/3, vol target 0.6, BTC+ETH, held at a
 *              constant d = 0.30 of equity (the ladder rung live runs on since HWM ≥ $320)
 *   The TSM curve is simulated here and must reproduce runTrendCore's own curve exactly
 *   (--curves); the run aborts otherwise. The short sleeve below is that simulator mirrored.
 *
 * Bear overlay: while BEAR_TREND the scalper is flat, so its capital is idle. A cell deploys
 *   w = 0.30 of total equity into its sleeves; combos split w equally between members.
 *
 *   S1g   short BTC+ETH, 1× isolated margin — mirror of the live TSM rule (enter at 0/3
 *         positive votes, stay while ≤1/3, vol target 0.6) — only while BEAR_TREND
 *   S1u   the same, ungated
 *   S1g2  S1g at 2×   (stress: liquidation check)
 *   S1u2  S1u at 2×   (stress)
 *   S2    short the scalper's own SELL decisions on margin-enabled alts while BEAR_TREND:
 *         4 slots, per-symbol SL/TP mirrored, cover on BUY, regime exit or 14 bars
 *   S3    hold PAXG while BEAR_TREND
 *   S4    earn yield on the parked USDC while BEAR_TREND (4% APR)
 *   C1 S1g+S3 · C2 S1g+S4 · C3 S3+S4 · C4 S1g+S2 · C5 S1g+S3+S4 · C6 S1g+S2+S3+S4
 *
 * Costs: 0.1% fee per leg; slippage tiers (large 0.10%, mid 0.20%, micro 0.35%); borrow
 *   interest on the shorted notional, 10% APR for BTC/ETH and 20% for alts (primary;
 *   2/5/20% reported as sensitivity); yield bands 2/4/6%. (Slippage: see correction 2.)
 * Liquidation: isolated margin liquidates at margin level 1.1 — a 1× short at +81.8% against
 *   it, 2× at +36.4% — checked on bar highs, with a 2% liquidation fee. Shorts are held at
 *   constant leverage (rebalanced at bar opens with the long sleeve's 15% band), so the risk
 *   is a move inside one 12h bar; it is reported as the minimum margin level reached.
 *   `--selftest` checks the short accounting on synthetic prices (added after the first run;
 *   it changed the reported risk metric only, not the simulation).
 * Gate — a cell is "worth building" only if, against B0: combined Sharpe is higher on the full
 *   window AND on both halves (split 2024-01-01); combined max DD is not worse; DSR ≥ 0.5;
 *   zero liquidations at 1×; and the margin probe confirms the account can do it.
 * Trials (as pre-registered: 33 + 14 = 47 — both numbers were wrong, see below).
 *
 * ── POST-REVIEW CORRECTIONS (backtest-reviewer, 2026-09-28, after the first run) ───────────
 *   1. Data holes: overlay sleeves go flat at the last bar before a gap in the BTC grid. The first
 *      run held S1u through the 2022-09 → 2023-03 USDC hole into a bad print (BTC/USDC high 50000
 *      on 2023-03-12) and reported liquidations that never happened. Filling at the close of that
 *      last bar knows the hole is coming; for this hole that is defensible (Binance announced the
 *      USDC→BUSD conversion in advance). On one-bar maintenance holes the rule only costs a round
 *      trip, so it is conservative.
 *   2. Slippage: the shared SLIPPAGE_TIERS (PAXG is micro, 0.35%), not a private table.
 *   3. Counters (liquidations, margin level, activity, trips) cover the reporting window only.
 *   4. Fills: a short under water at the open is liquidated at the open; S2 stops gapped through
 *      fill at the open; S2 sizing marks at the last closed bar; S2 regime/age exits no longer need
 *      a decision that bar; S2 win rate is net of costs.
 *   5. Trials: 45 prior (TREND_CORE_STUDY, cumulative) + 13 cells = 58; 65 with sensitivity rows.
 *   6. Gate: a DSR on the whole book mostly measured B0, so each cell is now judged on its OVERLAY
 *      returns — incremental DSR ≥ 0.5, positive incremental Sharpe in both halves, book max DD not
 *      worse, no 1× liquidation, venue. S4 (fixed yield) is a cash note, not a trial: a risk-free
 *      carry passes any rf = 0 Sharpe/DD gate by construction, so combos are judged on their
 *      trading members only.
 *   Corrections 1 and 3 help the overlays, 2 and 4 hurt them, 5 and 6 change the gate; none was
 *   chosen after seeing its effect.
 *   NOT fixed here: PortfolioBacktester steps symbols by array index, so symbols whose history
 *   starts later or has holes are misaligned in time. B0's scalper leg is engine output, not "the
 *   bot as it trades today"; the verdicts rest on the overlays' own returns.
 *
 * Data (USDC first — EU account, nothing is ever traded in USDT):
 *   primary  USDC 12h; BTC/ETH deep history via rebuildDeepHistory.mjs. PAXG/USDC exists only
 *            from 2025-04, so S3 is flat before that. Window 2021-01-01 → 2026-08-10 (the end
 *            of the 15m data the scalper's filters need). USDC has no bars 2022-09-29 →
 *            2023-03-12 (BUSD era); overlay sleeves go flat before it (see correction 1).
 *   --quote USDT  price-history PROXY only: standalone sleeves (no scalper, no MTF data),
 *            2018-01-01 → 2026-08-10 — the 2018 bear and a gap-free 2022. Labelled as proxy.
 *
 * Usage:
 *   node src/scripts/runTrendCore.mjs --quote USDC --vote 30,45,60 --hysteresis \
 *     --vol-target 0.6 --dump-curves data/tc_curves.json --out data/tc.json
 *   node src/scripts/runBearSide.mjs --curves data/tc_curves.json [--out data/bear_side.json]
 *   node src/scripts/runBearSide.mjs --quote USDT [--out data/bear_side_usdt_proxy.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../../config/default.js';
import { deflatedSharpeRatio } from '../backtester/deflatedSharpe.js';
import { classifySeries } from '../engine/regimeClassifier.js';
import { SLIPPAGE_TIERS } from '../backtester/baselineFramework.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDLE_DIR = path.resolve(__dirname, '../../data/candles');

const BARS_PER_YEAR = 730;
const FEE = 0.001;
const N_TRIALS = 45 + 13;            // prior sleeve-family trials (TREND_CORE_STUDY, cumulative) + cells here
const N_TRIALS_SENS = N_TRIALS + 7;  // …also counting the sensitivity rows
const D_TSM = 0.30;          // TSM long sleeve weight in the book (live rung)
const W_OVERLAY = 0.30;      // bear overlay weight while BEAR_TREND
const LIQ_LEVEL = 1.1;       // isolated-margin liquidation margin level
const LIQ_FEE = 0.02;
const MAJOR_APR = 0.10;
const ALT_APR = 0.20;
const YIELD_APR = 0.04;
const SPLIT_TS = Date.UTC(2024, 0, 1);
const END_TS = Date.UTC(2026, 7, 10, 23, 59);

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const quote = String(arg('--quote', 'USDC')).toUpperCase();
const proxy = quote !== 'USDC';
const curvesFile = arg('--curves');
const outFile = arg('--out', proxy ? 'data/bear_side_usdt_proxy.json' : 'data/bear_side.json');
const FROM_TS = proxy ? Date.UTC(2018, 0, 1) : Date.UTC(2021, 0, 1);

// The shared tiers (BTC and ETH are 0.10% there too, so the TSM parity check is unaffected).
const slipFor = (coin) => SLIPPAGE_TIERS[`${coin}/USDC`] ?? 0.0035;

// ── Data on the BTC 12h grid ─────────────────────────────────────────────────
function loadCandles(coin, q = quote) {
  const file = path.join(CANDLE_DIR, `${coin}_${q}_12h.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.candles ?? null;
}
const btcCandles = loadCandles('BTC');
if (!btcCandles?.length) { console.error(`BTC_${quote}_12h missing`); process.exit(1); }
const grid = btcCandles.map((c) => c.timestamp);
const gridIdx = new Map(grid.map((t, i) => [t, i]));
const coins = new Map();
function addCoin(coin, q = quote) {
  if (coins.has(coin)) return coins.get(coin);
  const candles = loadCandles(coin, q);
  if (!candles?.length) return null;
  const bars = new Array(grid.length).fill(null);
  let firstIdx = null;
  for (const c of candles) {
    const gi = gridIdx.get(c.timestamp);
    if (gi == null) continue;
    bars[gi] = c;
    if (firstIdx === null || gi < firstIdx) firstIdx = gi;
  }
  const closes = new Array(grid.length).fill(null);
  let last = null;
  for (let gi = 0; gi < grid.length; gi++) { if (bars[gi]) last = bars[gi].close; closes[gi] = last; }
  const entry = { bars, closes, firstIdx };
  coins.set(coin, entry);
  return entry;
}
for (const c of ['BTC', 'ETH', 'PAXG']) addCoin(c);

const W0 = Math.max(grid.findIndex((t) => t >= FROM_TS), 0);
const W1 = (() => { const i = grid.findIndex((t) => t > END_TS); return i === -1 ? grid.length - 1 : i - 1; })();
const SPLIT = grid.findIndex((t) => t >= SPLIT_TS);

// A jump in the BTC grid is a data hole (USDC: 2022-09-29 → 2023-03-12, BUSD era). Overlay
// sleeves go flat at the last bar before it: nothing can be held through months with no market,
// and the first bar after that hole carries a bad print (BTC/USDC high 50000 on 2023-03-12).
const PERIOD_MS = 12 * 3_600_000;
const gapAfter = grid.map((t, gi) => gi + 1 < grid.length && grid[gi + 1] - t > 1.5 * PERIOD_MS);
let countAll = false;                                   // --selftest counts every bar
const inWin = (gi) => countAll || (gi >= W0 && gi <= W1);

// BTC regime per bar — same classifier and config the bot and the backtester use.
const regimeAt = classifySeries(btcCandles, config.regimeClassifier).map((r) => r.regime);
const bear = (gi) => regimeAt[gi] === 'BEAR_TREND';

// ── TSM vote (live rule) and its mirror ──────────────────────────────────────
const LOOKBACKS = config.tsmCore.lookbackBars;      // [60, 90, 120]
const ENTER = config.tsmCore.enterVotes;            // 3
const STAY = config.tsmCore.stayVotes;              // 2
const VOL_T = config.tsmCore.volTarget;             // 0.6

function votes(coin, gi) {
  const { closes, firstIdx } = coins.get(coin);
  let pos = 0, valid = 0;
  if (firstIdx === null) return { pos, valid, total: LOOKBACKS.length };
  for (const b of LOOKBACKS) if (gi - b >= firstIdx) { valid++; if (closes[gi] > closes[gi - b]) pos++; }
  return { pos, valid, total: LOOKBACKS.length };
}
// Slow-in hysteresis, exactly as runTrendCore: long enters at ENTER positive, stays ≥ STAY.
// The short mirror enters at ENTER negative (0 positive) and stays while ≥ STAY negative.
function voteSeries(coin, side) {
  const out = new Array(grid.length).fill(false);
  let on = false;
  for (let gi = 0; gi < grid.length; gi++) {
    const { pos, valid, total } = votes(coin, gi);
    const n = side > 0 ? pos : valid - pos;
    if (valid < total) on = false;
    else if (!on && n >= ENTER) on = true;
    else if (on && n < STAY) on = false;
    out[gi] = on;
  }
  return out;
}
const volCache = new Map();
function realizedVol(coin) {
  if (volCache.has(coin)) return volCache.get(coin);
  const { closes, firstIdx } = coins.get(coin);
  const W = 60; const v = new Array(grid.length).fill(null);
  if (firstIdx !== null) {
    for (let gi = firstIdx + W + 1; gi < grid.length; gi++) {
      let mean = 0; const rets = [];
      for (let k = gi - W + 1; k <= gi; k++) { const r = closes[k] / closes[k - 1] - 1; rets.push(r); mean += r; }
      mean /= W;
      v[gi] = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (W - 1)) * Math.sqrt(BARS_PER_YEAR);
    }
  }
  volCache.set(coin, v);
  return v;
}

/**
 * One coin, one sleeve, equity normalised to 1. side +1 = long (runTrendCore's simSleeve,
 * bar for bar), side -1 = short on isolated margin at `lev`× with borrow interest and a
 * margin-level liquidation. `signal(gi)` is evaluated on the CLOSED bar gi.
 */
function simSleeve(coin, signal, { side = 1, volTarget = null, lev = 1, apr = 0, flatAcrossGaps = false } = {}) {
  const { bars, closes } = coins.get(coin);
  const vol = volTarget ? realizedVol(coin) : null;
  const slip = slipFor(coin);
  let cash = 1, qty = 0, pending = null;
  const eq = new Array(grid.length).fill(1);
  // The simulation runs over all history; the counters cover the reporting window only.
  const st = { roundTrips: 0, liquidations: 0, minMarginLevel: Infinity, activeBars: 0, firstFill: null };
  const liquidate = (px, gi) => {
    cash -= -qty * px * (1 + slip) * (1 + LIQ_FEE);
    qty = 0;
    if (inWin(gi)) { st.liquidations++; st.roundTrips++; }
  };
  for (let gi = 0; gi < grid.length; gi++) {
    const bar = bars[gi];
    // A short already past its liquidation price at the open is liquidated at the open.
    if (side < 0 && qty < 0 && bar && bar.open >= cash / (LIQ_LEVEL * -qty)) liquidate(bar.open, gi);
    if (pending !== null && bar) {
      const open = bar.open;
      const e = cash + qty * open;
      const deltaUsd = pending * e - qty * open;
      if (deltaUsd !== 0 && st.firstFill === null) st.firstFill = gi;
      if (side > 0) {
        if (deltaUsd > 0) {
          const spend = Math.min(deltaUsd, cash);
          if (spend > 0) { qty += (spend * (1 - FEE)) / (open * (1 + slip)); cash -= spend; }
        } else if (deltaUsd < 0) {
          const sellQty = Math.min(-deltaUsd / open, qty);
          cash += sellQty * open * (1 - slip) * (1 - FEE);
          qty -= sellQty;
          if (pending === 0) { qty = 0; if (inWin(gi)) st.roundTrips++; }
        }
      } else if (deltaUsd < 0) {                       // open / grow the short: sell borrowed coin
        const units = -deltaUsd / open;
        cash += units * open * (1 - slip) * (1 - FEE);
        qty -= units;
      } else if (deltaUsd > 0 && qty < 0) {            // shrink / cover: buy back
        const units = Math.min(deltaUsd / open, -qty);
        cash -= (units * open * (1 + slip)) / (1 - FEE);
        qty += units;
        if (pending === 0 || qty > -1e-12) { qty = 0; if (inWin(gi)) st.roundTrips++; }
      }
      pending = null;
    }
    if (side < 0 && qty < 0 && bar) {
      cash -= -qty * closes[gi] * (apr / BARS_PER_YEAR);          // borrow interest
      // Rebalancing only happens at bar opens, so the risk is a move WITHIN one 12h bar.
      if (inWin(gi)) st.minMarginLevel = Math.min(st.minMarginLevel, cash / (-qty * bar.high));
      const liqPx = cash / (LIQ_LEVEL * -qty);                     // assets / liabilities = 1.1
      if (bar.high >= liqPx) liquidate(liqPx, gi);
    }
    eq[gi] = cash + qty * (closes[gi] ?? 0);
    if (flatAcrossGaps && gapAfter[gi]) {                          // flat at this close, before the hole
      if (qty !== 0) {
        const px = closes[gi];
        if (qty > 0) cash += qty * px * (1 - slip) * (1 - FEE);
        else cash -= (-qty * px * (1 + slip)) / (1 - FEE);
        qty = 0;
        if (inWin(gi)) st.roundTrips++;
        eq[gi] = cash;
      }
      pending = null;
      continue;
    }
    if (qty !== 0 && inWin(gi)) st.activeBars++;
    const on = signal(gi);
    let tf = on ? 1 : 0;
    if (on && vol) { const rv = vol[gi]; if (rv && rv > 0) tf = Math.min(1, Math.max(0.2, volTarget / rv)); }
    tf *= side * (side < 0 ? lev : 1);
    const cur = eq[gi] > 0 ? (qty * (closes[gi] ?? 0)) / eq[gi] : 0;
    const full = (tf === 0 && qty !== 0) || (tf !== 0 && qty === 0);
    pending = full || Math.abs(tf - cur) > 0.15 ? tf : null;
  }
  return { eq, ...st };
}
const blend = (curves) => grid.map((_, gi) => curves.reduce((s, c) => s + c[gi], 0) / curves.length);

// --selftest: the short-side accounting on synthetic prices, before any result is trusted.
if (argv.includes('--selftest')) {
  const synth = (name, priceAt) => {
    const bars = grid.map((t, gi) => ({ timestamp: t, open: priceAt(gi), high: Math.max(priceAt(gi), priceAt(gi + 1)), low: Math.min(priceAt(gi), priceAt(gi + 1)), close: priceAt(gi + 1) }));
    coins.set(name, { bars, closes: bars.map((b) => b.close), firstIdx: 0 });
  };
  countAll = true;
  const N = 400, on = (gi) => gi >= 10 && gi < N;
  const check = (label, got, lo, hi) => {
    const ok = got >= lo && got <= hi;
    console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got.toFixed(4)} (expected ${lo}…${hi})`);
    if (!ok) process.exitCode = 1;
  };
  synth('FLAT', () => 100);
  const flat = simSleeve('FLAT', on, { side: -1, apr: 0.10 });
  // Synthetic coins get micro-tier slippage: two legs of 0.35% + 0.1% fee (~0.9%), plus 390 bars
  // of 10% APR interest (~5.3%).
  check('flat price, 1× short, 10% APR → equity', flat.eq[N + 5], 0.935, 0.945);
  // Constant-leverage short (rebalanced like the long sleeve): between static (1.5) and continuous (2.0).
  synth('DOWN', (gi) => (gi <= 10 ? 100 : Math.max(50, 100 - (gi - 10) * 0.25)));
  check('price 100 → 50, 1× rebalanced short → equity', simSleeve('DOWN', on, { side: -1 }).eq[N + 5], 1.80, 2.00);
  // A steady rise is deleveraged bar by bar (continuous limit P0/P ≈ 0.34), never liquidated.
  synth('UP', (gi) => (gi <= 10 ? 100 : 100 + (gi - 10) * 0.5));
  const up = simSleeve('UP', on, { side: -1 });
  check('price 100 → ~295 steady, 1× → equity', up.eq[N + 5], 0.25, 0.50);
  check('steady rise → liquidations', up.liquidations, 0, 0);
  // Gaps inside one 12h bar are the real risk: +90% wick liquidates 1× (at +81.8%), +40% only 2× (at +36.4%).
  const gap = (name, wick) => {
    const bars = grid.map((t, gi) => ({ timestamp: t, open: 100, high: gi === 200 ? 100 * (1 + wick) : 100, low: 100, close: 100 }));
    coins.set(name, { bars, closes: bars.map((b) => b.close), firstIdx: 0 });
  };
  gap('GAP90', 0.90);
  check('+90% wick, 1× → liquidations', simSleeve('GAP90', on, { side: -1 }).liquidations, 1, 1);
  gap('GAP40', 0.40);
  check('+40% wick, 1× → liquidations', simSleeve('GAP40', on, { side: -1 }).liquidations, 0, 0);
  check('+40% wick, 2× → liquidations', simSleeve('GAP40', on, { side: -1, lev: 2 }).liquidations, 1, 1);
  check('+40% wick, 1× → min margin level', simSleeve('GAP40', on, { side: -1 }).minMarginLevel, 1.40, 1.45);
  // What a 1× liquidation leaves: 2E of assets minus the buy-back at ~1.82× entry plus fees.
  check('equity right after a 1× liquidation', simSleeve('GAP90', on, { side: -1 }).eq[201], 0.10, 0.20);
  // Timing: a signal on closed bar 10 fills at bar 11's open, never earlier.
  synth('TIMING', (gi) => 100 + gi * 0.01);
  check('first fill bar for a signal first true at bar 10', simSleeve('TIMING', on, { side: -1 }).firstFill, 11, 11);
  // A data hole: overlay sleeves are flat before it, so a bad print on the first bar after it is
  // never held. Without the rule this reproduces the first run's phantom liquidation.
  const hole = gapAfter.findIndex(Boolean);
  if (hole > 0) {
    const bars = grid.map((t, gi) => ({ timestamp: t, open: 100, high: gi === hole + 1 ? 200 : 100, low: 100, close: 100 }));
    coins.set('HOLE', { bars, closes: bars.map((b) => b.close), firstIdx: 0 });
    const across = (gi) => gi >= hole - 50 && gi <= hole + 50;
    check('bad print after a data hole, flat across gaps → liquidations', simSleeve('HOLE', across, { side: -1, flatAcrossGaps: true }).liquidations, 0, 0);
    check('same without the rule (the first run\'s bug) → liquidations', simSleeve('HOLE', across, { side: -1 }).liquidations, 1, 1);
  } else console.log('  – no hole in this grid; data-hole test skipped');
  process.exit();
}

// ── Metrics ──────────────────────────────────────────────────────────────────
const toReturns = (eq, a, b) => { const r = []; for (let gi = a + 1; gi <= b; gi++) r.push(eq[gi - 1] > 0 ? eq[gi] / eq[gi - 1] - 1 : 0); return r; };
function stats(returns) {
  const n = returns.length;
  const mean = returns.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  let v = 1, peak = 1, dd = 0;
  for (const r of returns) { v *= 1 + r; if (v > peak) peak = v; dd = Math.min(dd, v / peak - 1); }
  const sharpeRaw = sd > 0 ? (mean / sd) * Math.sqrt(BARS_PER_YEAR) : 0;
  return {
    returnPct: +((v - 1) * 100).toFixed(1),
    cagrPct: +((Math.pow(v, BARS_PER_YEAR / n) - 1) * 100).toFixed(1),
    sharpe: +sharpeRaw.toFixed(2),
    maxDDPct: +(dd * 100).toFixed(1),
    sharpeRaw, maxDDRaw: dd * 100,      // unrounded, for gate comparisons
  };
}
function metrics(returnsByBar) {           // returnsByBar[gi] = return from gi-1 to gi
  const slice = (a, b) => returnsByBar.slice(a + 1, b + 1);
  const full = slice(W0, W1);
  const out = { full: stats(full), h1: stats(slice(W0, SPLIT - 1)), h2: stats(slice(SPLIT - 1, W1)) };
  const dsrAt = (nTrials) => +deflatedSharpeRatio({ observedSharpe: out.full.sharpeRaw, returns: full, nTrials, periodsPerYear: BARS_PER_YEAR }).dsr.toFixed(2);
  out.dsr = dsrAt(N_TRIALS);
  out.dsrSens = dsrAt(N_TRIALS_SENS);
  const bearWin = (from, to) => { const a = grid.findIndex((t) => t >= from); const b = grid.findIndex((t) => t >= to); return a > W0 && b > a ? stats(slice(a, b)) : null; };
  out.bear2018 = bearWin(Date.UTC(2018, 0, 7), Date.UTC(2018, 11, 16));
  out.bear2022 = bearWin(Date.UTC(2021, 10, 8), Date.UTC(2022, 11, 31));
  out.drop2026 = bearWin(Date.UTC(2026, 3, 1), Date.UTC(2026, 6, 31));
  return out;
}
const barReturns = (eq) => grid.map((_, gi) => (gi > 0 && eq[gi - 1] > 0 ? eq[gi] / eq[gi - 1] - 1 : 0));

// ── Sleeves ──────────────────────────────────────────────────────────────────
const shortBTC = voteSeries('BTC', -1), shortETH = voteSeries('ETH', -1);
const s1 = (gated, lev) => {
  const legs = [['BTC', shortBTC], ['ETH', shortETH]].map(([coin, series]) =>
    simSleeve(coin, (gi) => series[gi] && (!gated || bear(gi)), { side: -1, volTarget: VOL_T, lev, apr: MAJOR_APR, flatAcrossGaps: true }));
  return {
    eq: blend(legs.map((l) => l.eq)),
    liquidations: legs.reduce((s, l) => s + l.liquidations, 0),
    minMarginLevel: +Math.min(...legs.map((l) => l.minMarginLevel)).toFixed(2),
    roundTrips: legs.reduce((s, l) => s + l.roundTrips, 0),
    activePct: +((legs.reduce((s, l) => s + l.activeBars, 0) / (2 * (W1 - W0 + 1))) * 100).toFixed(0),
  };
};
const sleeves = {
  S1g: s1(true, 1), S1u: s1(false, 1), S1g2: s1(true, 2), S1u2: s1(false, 2),
};
{
  const paxg = simSleeve('PAXG', (gi) => bear(gi) && coins.get('PAXG').bars[gi] !== null, { side: 1, flatAcrossGaps: true });
  sleeves.S3 = { eq: paxg.eq, roundTrips: paxg.roundTrips, liquidations: 0, minMarginLevel: null,
    activePct: +((paxg.activeBars / (W1 - W0 + 1)) * 100).toFixed(0) };
}
const yieldCurve = (apr) => { const eq = [1]; for (let gi = 1; gi < grid.length; gi++) eq.push(eq[gi - 1] * (1 + (bear(gi - 1) ? apr / BARS_PER_YEAR : 0))); return eq; };
sleeves.S4 = { eq: yieldCurve(YIELD_APR), roundTrips: 0, liquidations: 0, minMarginLevel: null };

// ── Book B0 (USDC only): scalper + TSM long sleeve ───────────────────────────
let book = null;
if (!proxy) {
  // TSM long sleeve, re-simulated here and checked against runTrendCore's own curve.
  const longLegs = ['BTC', 'ETH'].map((coin) => { const s = voteSeries(coin, 1); return simSleeve(coin, (gi) => s[gi], { side: 1, volTarget: VOL_T }); });
  const tsmEq = blend(longLegs.map((l) => l.eq));
  if (!curvesFile) { console.error('--curves <runTrendCore --dump-curves file> is required for the USDC run (TSM parity check)'); process.exit(1); }
  const dump = JSON.parse(fs.readFileSync(curvesFile, 'utf8'));
  const refKey = 'vote30/45/60d slow-in volT0.6 BTC+ETH';
  const ref = dump.curves?.[refKey];
  if (!ref) { console.error(`curve "${refKey}" missing from ${curvesFile}`); process.exit(1); }
  const refBy = new Map(dump.grid.map((t, i) => [Number(t), ref[i] / 10_000]));
  let worst = 0, checked = 0;
  for (let gi = 0; gi < grid.length; gi++) {
    const r = refBy.get(grid[gi]); if (r == null) continue;
    worst = Math.max(worst, Math.abs(tsmEq[gi] / r - 1)); checked++;
  }
  if (checked < 1000 || worst > 1e-9) { console.error(`TSM parity FAILED vs runTrendCore: ${checked} bars, worst rel. diff ${worst}`); process.exit(1); }
  console.log(`TSM parity vs runTrendCore: ${checked} bars, worst relative difference ${worst.toExponential(1)} ✓`);

  // Scalper: the live filter stack through the shared baseline framework.
  const { loadAllSymbols, loadMtfCandles, runWindow, FULL_LIVE_FILTERS } = await import('../backtester/baselineFramework.js');
  const { loadFearGreedHistory } = await import('../data/fearGreed.js');
  const symbols = config.symbols;
  const symbolCandles = await loadAllSymbols(symbols, '12h');
  const run = runWindow({
    window: { id: 'bear_side', label: 'bear-side study', startTs: Date.UTC(2020, 8, 1), endTs: END_TS },
    symbolCandles,
    mtf15mCandles: loadMtfCandles(symbols, '15m'),
    mtf4hCandles: loadMtfCandles(symbols, '4h'),
    fearGreedData: await loadFearGreedHistory().catch(() => null),
    budget: 1000,
    includeRaw: true,
    includeDecisions: true,
    filterOverrides: FULL_LIVE_FILTERS,
    basePctOverride: config.risk.maxPositionPct,
  });
  const perBar = new Map();
  for (const p of run.equity_curve ?? []) perBar.set(Number(p.timestamp), Number(p.balance));
  const scalperEq = new Array(grid.length).fill(null);
  let last = null;
  for (let gi = 0; gi < grid.length; gi++) { if (perBar.has(grid[gi])) last = perBar.get(grid[gi]); scalperEq[gi] = last; }
  const firstScalper = scalperEq.findIndex((v) => v !== null);
  if (firstScalper < 0 || firstScalper > W0) { console.error('scalper curve does not cover the window start'); process.exit(1); }

  // S2: the scalper's own SELL decisions, shorted on margin-enabled alts while BEAR_TREND.
  const marginFile = path.resolve(__dirname, '../../data/margin_pairs_public.json');
  if (!fs.existsSync(marginFile)) {
    console.error(`${marginFile} missing — create it from Binance's public exchangeInfo (see docs/BEAR_SIDE_STUDY.md → Reproduce)`);
    process.exit(1);
  }
  const margin = JSON.parse(fs.readFileSync(marginFile, 'utf8')).symbols;
  const decisions = run.decisions ?? {};
  const universe = Object.keys(decisions).filter((s) => margin[s.replace('/', '')]?.margin && !/^(BTC|ETH|PAXG)\//.test(s));
  const dAt = new Map();
  for (const sym of universe) { addCoin(sym.split('/')[0]); dAt.set(sym, new Map(decisions[sym].map((d) => [d.timestamp, d]))); }
  const s2 = (() => {
    let cash = 1; const open = new Map(); const pend = []; const eq = new Array(grid.length).fill(1);
    let trades = 0, wins = 0, forced = 0;
    const slots = config.risk.maxOpenPositions;
    const maxAge = config.risk.positionAgingExit?.maxAgeBars ?? 14;
    const risk = (sym) => ({ sl: config.perSymbol?.[sym]?.stopLossPct ?? config.risk.stopLossPct, tp: config.perSymbol?.[sym]?.takeProfitPct ?? config.risk.takeProfitPct });
    const lastClose = (sym, gi) => (gi >= 0 ? coins.get(sym.split('/')[0]).closes[gi] : null);
    const liabilities = (gi) => { let l = 0; for (const [s, p] of open) l += p.units * (lastClose(s, gi) ?? p.entry); return l; };
    const cover = (sym, px, gi) => {
      const p = open.get(sym); const slip = SLIPPAGE_TIERS[sym] ?? 0.0035;
      const cost = (p.units * px * (1 + slip)) / (1 - FEE);
      cash -= cost;
      if (inWin(gi)) { trades++; if (cost + p.interest < p.proceeds) wins++; }   // net of fees, slippage, interest
      open.delete(sym);
    };
    for (let gi = 0; gi < grid.length; gi++) {
      const t = grid[gi];
      for (const a of pend.splice(0)) {                 // decided at gi-1 close, filled at this open
        const bar = coins.get(a.sym.split('/')[0]).bars[gi]; if (!bar) continue;
        if (a.type === 'cover' && open.has(a.sym)) cover(a.sym, bar.open, gi);
        if (a.type === 'short' && !open.has(a.sym) && open.size < slots) {
          const equity = cash - liabilities(gi - 1);    // marked at the last CLOSED bar
          const slip = SLIPPAGE_TIERS[a.sym] ?? 0.0035;
          const units = equity / slots / bar.open;
          const proceeds = units * bar.open * (1 - slip) * (1 - FEE);
          cash += proceeds;
          open.set(a.sym, { units, entry: bar.open, age: 0, proceeds, interest: 0, missing: 0, ...risk(a.sym) });
        }
      }
      for (const [sym, p] of [...open]) {
        const bar = coins.get(sym.split('/')[0]).bars[gi];
        if (!bar) {                                      // no market for this alt: out after two missing bars
          if (++p.missing >= 2) { cover(sym, lastClose(sym, gi), gi); forced++; }
          continue;
        }
        p.missing = 0;
        const interest = p.units * bar.close * (ALT_APR / BARS_PER_YEAR);
        cash -= interest; p.interest += interest;
        p.age++;
        const stop = p.entry * (1 + p.sl), target = p.entry * (1 - p.tp);
        if (bar.open >= stop) cover(sym, bar.open, gi);         // gapped through the stop
        else if (bar.high >= stop) cover(sym, stop, gi);        // stop before target
        else if (bar.low <= target) cover(sym, target, gi);
      }
      if (gapAfter[gi]) for (const sym of [...open.keys()]) cover(sym, lastClose(sym, gi), gi);
      eq[gi] = cash - liabilities(gi);
      if (gapAfter[gi]) continue;
      for (const [sym, p] of open) if (!bear(gi) || p.age >= maxAge) pend.push({ type: 'cover', sym });
      const cands = [];
      for (const sym of universe) {
        const d = dAt.get(sym).get(t); if (!d) continue;
        if (open.has(sym)) {
          if (d.decision === 'BUY' && !pend.some((a) => a.sym === sym)) pend.push({ type: 'cover', sym });
        } else if (bear(gi) && d.decision === 'SELL') cands.push({ sym, conf: d.confidence });
      }
      cands.sort((a, b) => b.conf - a.conf);
      for (const c of cands.slice(0, Math.max(0, slots - open.size))) pend.push({ type: 'short', sym: c.sym });
    }
    return { eq, trades, winRatePct: trades ? +((wins / trades) * 100).toFixed(0) : null, universe: universe.length, forcedCovers: forced };
  })();
  sleeves.S2 = { eq: s2.eq, roundTrips: s2.trades, winRatePct: s2.winRatePct, liquidations: 0, minMarginLevel: null, universe: s2.universe, forcedCovers: s2.forcedCovers };

  const rS = barReturns(scalperEq.map((v) => v ?? 1000));
  const rT = barReturns(tsmEq);
  book = grid.map((_, gi) => (1 - D_TSM) * rS[gi] + D_TSM * rT[gi]);
}

// ── Cells ────────────────────────────────────────────────────────────────────
// S4 (fixed yield on idle cash) is not a trial: a risk-free carry raises any rf = 0 Sharpe and
// cannot worsen drawdown, so it passes any Sharpe/DD gate by construction. It is reported as a
// cash-management note, and the gate judges only the TRADING members of each cell.
const CELLS = {
  S1g: ['S1g'], S1u: ['S1u'], S1g2: ['S1g2'], S1u2: ['S1u2'], S2: ['S2'], S3: ['S3'], S4: ['S4'],
  C1: ['S1g', 'S3'], C2: ['S1g', 'S4'], C3: ['S3', 'S4'], C4: ['S1g', 'S2'],
  C5: ['S1g', 'S3', 'S4'], C6: ['S1g', 'S2', 'S3', 'S4'],
};
const overlayReturns = (members, w, only = members) => {
  const rs = only.map((m) => barReturns(sleeves[m].eq));
  return grid.map((_, gi) => (w / members.length) * rs.reduce((s, r) => s + r[gi], 0));
};

const flagged = [];
for (const coin of ['BTC', 'ETH', 'PAXG']) {
  const c = coins.get(coin); if (!c) continue;
  for (let gi = 0; gi < grid.length; gi++) {
    const b = c.bars[gi]; if (!b) continue;
    if (b.high > 1.5 * Math.max(b.open, b.close) || b.low < Math.min(b.open, b.close) / 1.5) {
      flagged.push({ coin, at: new Date(grid[gi]).toISOString(), open: b.open, high: b.high, low: b.low, close: b.close });
    }
  }
}
const results = {
  meta: {
    quote, proxy, nTrials: N_TRIALS, nTrialsWithSensitivity: N_TRIALS_SENS, dTsm: D_TSM, wOverlay: W_OVERLAY,
    from: new Date(grid[W0]).toISOString().slice(0, 10), to: new Date(grid[W1]).toISOString().slice(0, 10),
    bars: W1 - W0 + 1,
    bearTrendPct: +((grid.slice(W0, W1 + 1).filter((_, i) => bear(W0 + i)).length / (W1 - W0 + 1)) * 100).toFixed(1),
    dataHoles: grid.flatMap((t, gi) => (gapAfter[gi] ? [{ from: new Date(t).toISOString(), to: new Date(grid[gi + 1]).toISOString() }] : [])),
    flaggedBars: flagged,
    b0Caveat: 'scalper leg from PortfolioBacktester, which steps symbols by array index (time-misaligned for late or gapped histories) and marks other open positions at entry; TSM leg without the live NASDAQ macro overlay — engine output, not live-expected',
  },
  sleeves: {}, cells: {}, sensitivity: {},
};
for (const [k, s] of Object.entries(sleeves)) {
  results.sleeves[k] = { standalone: metrics(barReturns(s.eq)), roundTrips: s.roundTrips, liquidations: s.liquidations,
    minMarginLevel: Number.isFinite(s.minMarginLevel) ? +s.minMarginLevel.toFixed(2) : null, activePct: s.activePct ?? null,
    winRatePct: s.winRatePct ?? null, universe: s.universe ?? null, forcedCovers: s.forcedCovers ?? null };
}
const baseline = book ? metrics(book) : null;
results.book = baseline;
for (const [cell, members] of Object.entries(CELLS)) {
  if (members.some((m) => !sleeves[m])) continue;
  const trading = members.filter((m) => m !== 'S4');
  const ov = overlayReturns(members, W_OVERLAY);                // what the account would earn
  const inc = overlayReturns(members, W_OVERLAY, trading);      // the part the gate judges
  const total = book ? grid.map((_, gi) => book[gi] + ov[gi]) : ov.map((r) => r / W_OVERLAY);
  const m = metrics(total);
  const incM = trading.length ? metrics(inc) : null;
  const liq1x = trading.filter((x) => !x.endsWith('2')).reduce((a, x) => a + (sleeves[x].liquidations ?? 0), 0);
  const tradingBook = book && trading.length ? metrics(grid.map((_, gi) => book[gi] + inc[gi])) : null;
  const gate = trading.length ? {
    incrementalDsr: incM.dsr >= 0.5,
    incrementalSharpeH1: incM.h1.sharpeRaw > 0,
    incrementalSharpeH2: incM.h2.sharpeRaw > 0,
    ...(tradingBook && { bookDDNotWorse: tradingBook.full.maxDDRaw >= baseline.full.maxDDRaw }),
    noLiq1x: liq1x === 0,
    venue: 'pending margin probe',
  } : null;
  results.cells[cell] = {
    members, trading, ...m, incremental: incM, gate,
    passesMeasuredGate: gate ? Object.entries(gate).filter(([k]) => k !== 'venue').every(([, v]) => v) : null,
    note: trading.length ? null : 'cash-management note, not a trial (fixed yield; rf = 0 artefact)',
  };
}
// Sensitivity (reported, never used to pick a cell): borrow APR on S1g, overlay weight on C1.
for (const apr of [0.02, 0.05, 0.20]) {
  const legs = [['BTC', shortBTC], ['ETH', shortETH]].map(([coin, s]) => simSleeve(coin, (gi) => s[gi] && bear(gi), { side: -1, volTarget: VOL_T, lev: 1, apr, flatAcrossGaps: true }));
  results.sensitivity[`S1g borrow ${apr * 100}%`] = metrics(barReturns(blend(legs.map((l) => l.eq)))).full;
}
for (const apr of [0.02, 0.06]) results.sensitivity[`S4 yield ${apr * 100}%`] = metrics(barReturns(yieldCurve(apr))).full;
if (book) {
  for (const w of [0.15, 0.50]) {
    const ov = overlayReturns(CELLS.C1, w);
    results.sensitivity[`C1 overlay w=${w}`] = metrics(grid.map((_, gi) => book[gi] + ov[gi])).full;
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const f = (s) => (s ? `ret ${String(s.returnPct).padStart(7)}%  cagr ${String(s.cagrPct).padStart(6)}%  Sh ${String(s.sharpe).padStart(5)}  DD ${String(s.maxDDPct).padStart(6)}%` : 'n/a');
console.log(`\nBear-side study ${proxy ? '(USDT PRICE PROXY — standalone sleeves, nothing traded in USDT)' : '(USDC)'}  ${results.meta.from} → ${results.meta.to}`);
console.log(`  ${results.meta.bars} bars · BEAR_TREND ${results.meta.bearTrendPct}% of the time · DSR deflated for ${N_TRIALS} trials (${N_TRIALS_SENS} with sensitivity rows)`);
for (const h of results.meta.dataHoles) console.log(`  data hole ${h.from.slice(0, 10)} → ${h.to.slice(0, 10)} (overlay sleeves flat across it)`);
for (const b of results.meta.flaggedBars) console.log(`  flagged bar ${b.coin} ${b.at.slice(0, 16)}  o ${b.open} h ${b.high} l ${b.low} c ${b.close}`);
if (baseline) console.log(`\n  B0 book        ${f(baseline.full)}  DSR ${baseline.dsr}   H1 Sh ${baseline.h1.sharpe}  H2 Sh ${baseline.h2.sharpe}\n  (${results.meta.b0Caveat})\n`);
console.log('── Sleeves standalone (on their own capital) ──');
for (const [k, s] of Object.entries(results.sleeves)) {
  console.log(`  ${k.padEnd(5)} ${f(s.standalone.full)}  DSR ${s.standalone.dsr}  trips ${s.roundTrips ?? '-'}  liq ${s.liquidations}  minMarginLvl ${s.minMarginLevel ?? '-'}${s.activePct != null ? `  active ${s.activePct}%` : ''}${s.winRatePct != null ? `  WR ${s.winRatePct}% net` : ''}${s.forcedCovers ? `  forced ${s.forcedCovers}` : ''}`);
}
console.log(`\n── Cells ${book ? `(book + ${W_OVERLAY} overlay in BEAR_TREND)` : '(overlay sleeves standalone)'} ──`);
for (const [k, c] of Object.entries(results.cells)) {
  const inc = c.incremental;
  console.log(`  ${k.padEnd(5)} ${c.members.join('+').padEnd(14)} ${f(c.full)}` +
    (inc ? `  | overlay Sh ${String(inc.full.sharpe).padStart(5)} DSR ${inc.dsr} (${inc.dsrSens}) H1 ${inc.h1.sharpe} H2 ${inc.h2.sharpe}` : '  | cash note, not a trial') +
    (c.passesMeasuredGate === null ? '' : c.passesMeasuredGate ? '  ✅ measured gate' : '  ✗'));
}
console.log('\n── Bear windows (cell totals) ──');
for (const [k, c] of Object.entries(results.cells)) {
  console.log(`  ${k.padEnd(5)} 2018 ${f(c.bear2018)}\n        2022 ${f(c.bear2022)}\n        2026 ${f(c.drop2026)}`);
}
console.log('\n── Sensitivity (reported, not selected on) ──');
for (const [k, s] of Object.entries(results.sensitivity)) console.log(`  ${k.padEnd(22)} ${f(s)}`);
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nSaved → ${outFile}`);

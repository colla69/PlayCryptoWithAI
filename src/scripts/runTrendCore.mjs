/**
 * runTrendCore.mjs — the "deeper fix" study from docs/HONEST_REVIEW_FINDINGS.md:
 * majors-beta trend core (time-series momentum) + cross-sectional momentum rotation.
 *
 * Sim-only. Does NOT touch live code, config, or the PortfolioBacktester — this tests a
 * different architecture (regime-gated beta / leader rotation), not the ensemble-TA bot,
 * so the live filter stack does not apply. Fills are honest: decide on CLOSED bar i,
 * execute at bar i+1 OPEN, 0.1% fee per leg + tiered slippage (large 0.10% / mid 0.20% /
 * micro 0.35%). No lookahead anywhere.
 *
 * PRE-REGISTERED GRID (all cells reported; DSR charged for ALL 13 trials):
 *   A. TSM sleeves: rule ∈ {ema100d, ema200d, mom30d, mom90d} × universe ∈ {BTC+ETH, +BNB+SOL}
 *      (8 cells; canonical prior = ema200d on BTC+ETH — declared before running)
 *   B. Rotation: lookback ∈ {30d, 90d} × topK ∈ {3, 4}, rebalance 10d, gate = BTC>EMA200d
 *      (4 cells; canonical prior = 90d, K=4)
 *   C. Blend: 50% A(ema200d, BTC+ETH) + 50% B(90d, K=4), static split (1 cell)
 *
 * Known caveats (stated, not hidden):
 *   - Cross-sectional universe = today's 37-coin config → survivorship bias in B/C.
 *   - Benchmarks (B&H) start at data start; strategies idle through their warmup.
 *   - Deep candle history predates real USDC-pair liquidity for some coins.
 *
 * Usage: PAPER_MODE=true node src/scripts/runTrendCore.mjs [--out data/trend_core.json]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflatedSharpeRatio } from '../backtester/deflatedSharpe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CANDLE_DIR = path.resolve(__dirname, '../../data/candles');

const BARS_PER_YEAR = 730; // 12h bars
const FEE = 0.001;         // Binance spot, per leg
const START_CAPITAL = 10_000;

const argv = process.argv.slice(2);
let outFile = 'data/trend_core.json';
let extraMomDays = []; // neighbor-lookback robustness cells (plateau test); count toward DSR trials
let voteDays = null;   // majority-vote ensemble of momentum lookbacks (candidate shipping rule)
let fromDate = null;   // start-date sensitivity: measure metrics from this date onward
let toDate = null;     //   (curves still simulate over full history — this is a walk-in window)
let quote = 'USDC';    // candle file quote currency (USDT unlocks 2017+ history incl. 2018 bear)
let universeArg = null;    // custom TSM universe, e.g. --universe BTC,ETH,BNB,XRP,ADA,LTC,LINK,DOGE
let volTargetAnnual = null; // vol-targeted sizing variant of the vote rule (annualised target, e.g. 0.6)
let hysteresis = false;    // slow-in (enter 3/3, stay ≥2) and slow-out (enter ≥2, exit at 0) vote variants
let overlays = [];         // context overlays on the combo rule (see OVERLAY_DEFS): --overlays F1,M1,...
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out' && argv[i + 1]) outFile = argv[++i];
  if (argv[i] === '--extra-mom' && argv[i + 1]) extraMomDays = argv[++i].split(',').map(Number);
  if (argv[i] === '--vote' && argv[i + 1]) voteDays = argv[++i].split(',').map(Number);
  if (argv[i] === '--from' && argv[i + 1]) fromDate = Date.parse(argv[++i]);
  if (argv[i] === '--to' && argv[i + 1]) toDate = Date.parse(argv[++i]);
  if (argv[i] === '--quote' && argv[i + 1]) quote = argv[++i].toUpperCase();
  if (argv[i] === '--universe' && argv[i + 1]) universeArg = argv[++i].split(',').map((s) => s.trim().toUpperCase());
  if (argv[i] === '--vol-target' && argv[i + 1]) volTargetAnnual = Number(argv[++i]);
  if (argv[i] === '--hysteresis') hysteresis = true;
  if (argv[i] === '--overlays' && argv[i + 1]) overlays = argv[++i].split(',').map((s) => s.trim().toUpperCase());
}

// Every DSR is deflated by the CUMULATIVE search burden across study sessions:
// 21 cells from the original grid + neighbors + vote, plus each cell family a
// new flag adds in this run. Never fewer trials than were actually tried.
const N_TRIALS = 21
  + extraMomDays.length * 2
  + (universeArg ? 3 : 0)
  + (volTargetAnnual ? 3 : 0)
  + (hysteresis ? 6 : 0)
  + (volTargetAnnual && hysteresis ? 3 : 0)
  + overlays.length * 2;

// Slippage tiers per docs (Large 0.10%, Mid 0.20%, Micro 0.35%)
const LARGE = new Set(['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'BCH', 'LINK', 'TRX', 'TON']);
const MID = new Set(['AVAX', 'NEAR', 'ICP', 'APT', 'ARB', 'INJ', 'SUI', 'TIA', 'LDO', 'ENS', 'CRV', 'THETA', 'PAXG', 'RENDER', 'WLD', 'PEPE', 'ENA', 'JUP', 'JTO']);
const slipFor = (coin) => (LARGE.has(coin) ? 0.001 : MID.has(coin) ? 0.002 : 0.0035);

const configModule = await import('../../config/default.js');
const config = configModule.default ?? configModule.config;
const UNIVERSE = config.symbols.map((s) => s.split('/')[0]);

// ── Data loading, aligned to the BTC 12h grid ────────────────────────────────
function loadCandles(coin) {
  const file = path.join(CANDLE_DIR, `${coin}_${quote}_12h.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : raw.candles ?? null;
}

const btcCandles = loadCandles('BTC');
if (!btcCandles?.length) { console.error('BTC 12h candles missing'); process.exit(1); }
const grid = btcCandles.map((c) => c.timestamp);
const gridIdx = new Map(grid.map((ts, i) => [ts, i]));

// Rotation universe: config coins on USDC; the custom universe otherwise.
const ROT_UNIVERSE = universeArg ?? (quote === 'USDC' ? UNIVERSE : []);

// per coin: bars[gi] = actual candle or null; closes[gi] = carry-forward close; firstIdx
const coins = new Map();
for (const coin of new Set([...ROT_UNIVERSE, ...(universeArg ?? []), 'BTC', 'ETH', 'BNB', 'SOL'])) {
  const candles = loadCandles(coin);
  if (!candles?.length) { console.warn(`  (no 12h data for ${coin} — excluded)`); continue; }
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
  for (let gi = 0; gi < grid.length; gi++) {
    if (bars[gi]) last = bars[gi].close;
    closes[gi] = last;
  }
  coins.set(coin, { bars, closes, firstIdx });
}

function emaSeries(coin, nBars) {
  const { closes, firstIdx } = coins.get(coin);
  const ema = new Array(grid.length).fill(null);
  if (firstIdx === null || firstIdx + nBars >= grid.length) return ema;
  let seed = 0;
  for (let gi = firstIdx; gi < firstIdx + nBars; gi++) seed += closes[gi];
  let value = seed / nBars;
  const alpha = 2 / (nBars + 1);
  for (let gi = firstIdx + nBars; gi < grid.length; gi++) {
    value = closes[gi] * alpha + value * (1 - alpha);
    ema[gi] = value;
  }
  return ema;
}

// Rules: day-based lookbacks → 12h bars (×2)
const RULES = {
  ema100d: { warmup: 200, make: (coin) => { const e = emaSeries(coin, 200); return (gi) => e[gi] !== null && coins.get(coin).closes[gi] > e[gi]; } },
  ema200d: { warmup: 400, make: (coin) => { const e = emaSeries(coin, 400); return (gi) => e[gi] !== null && coins.get(coin).closes[gi] > e[gi]; } },
  mom30d:  { warmup: 60,  make: (coin) => { const { closes, firstIdx } = coins.get(coin); return (gi) => firstIdx !== null && gi - 60 >= firstIdx && closes[gi] > closes[gi - 60]; } },
  mom90d:  { warmup: 180, make: (coin) => { const { closes, firstIdx } = coins.get(coin); return (gi) => firstIdx !== null && gi - 180 >= firstIdx && closes[gi] > closes[gi - 180]; } },
};
for (const days of extraMomDays) {
  const bars = days * 2;
  RULES[`mom${days}d`] = { warmup: bars, make: (coin) => { const { closes, firstIdx } = coins.get(coin); return (gi) => firstIdx !== null && gi - bars >= firstIdx && closes[gi] > closes[gi - bars]; } };
}
function votesPositive(coin, gi, barsList) {
  const { closes, firstIdx } = coins.get(coin);
  if (firstIdx === null) return { pos: 0, valid: 0, total: barsList.length };
  let pos = 0, valid = 0;
  for (const b of barsList) {
    if (gi - b >= firstIdx) { valid++; if (closes[gi] > closes[gi - b]) pos++; }
  }
  return { pos, valid, total: barsList.length };
}

// Path-dependent vote with separate enter/exit thresholds (whipsaw damping).
function hysteresisSeries(coin, barsList, enterNeed, exitBelow) {
  const arr = new Array(grid.length).fill(false);
  let on = false;
  for (let gi = 0; gi < grid.length; gi++) {
    const { pos, valid, total } = votesPositive(coin, gi, barsList);
    if (valid < total) on = false;              // insufficient history → cash
    else if (!on && pos >= enterNeed) on = true;
    else if (on && pos < exitBelow) on = false;
    arr[gi] = on;
  }
  return arr;
}

if (voteDays) {
  const barsList = voteDays.map((d) => d * 2);
  const need = Math.floor(voteDays.length / 2) + 1;
  const tag = voteDays.join('/');
  RULES[`vote${tag}d`] = {
    warmup: Math.max(...barsList),
    make: (coin) => (gi) => {
      const { pos, valid, total } = votesPositive(coin, gi, barsList);
      return valid === total && pos >= need;
    },
  };
  if (hysteresis) {
    RULES[`vote${tag}d slow-in`] = {  // enter only on 3/3, stay while ≥2
      warmup: Math.max(...barsList),
      make: (coin) => { const a = hysteresisSeries(coin, barsList, barsList.length, need); return (gi) => a[gi]; },
    };
    RULES[`vote${tag}d slow-out`] = { // enter on majority, exit only at 0 positive
      warmup: Math.max(...barsList),
      make: (coin) => { const a = hysteresisSeries(coin, barsList, need, 1); return (gi) => a[gi]; },
    };
  }
}

// ── Context overlays (funding / macro / on-chain / sentiment) ────────────────
// Each overlay maps (coin, gi) → an exposure factor in [0, 1] applied to the
// combo rule's target fraction (0 = block AND exit). Missing data → neutral 1,
// so partial coverage (e.g. funding starts 2019-09) cannot fabricate history.
// Data from src/scripts/downloadContextData.mjs → data/context/.
const CTX_DIR = path.resolve(__dirname, '../../data/context');
const loadCtx = (name) => {
  const f = path.join(CTX_DIR, name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
};
// Align [{t, ...}] rows to the grid: at each bar, the last row whose t + lagMs
// ≤ bar close is visible (conservative publication/close lag → no lookahead).
function alignToGrid(rows, pick, lagMs) {
  const out = new Array(grid.length).fill(null);
  if (!rows?.length) return out;
  let j = 0, last = null;
  for (let gi = 0; gi < grid.length; gi++) {
    while (j < rows.length && rows[j].t + lagMs <= grid[gi]) { last = pick(rows[j]); j++; }
    out[gi] = last;
  }
  return out;
}

const DAY = 86_400_000;
const OVERLAY_DEFS = {};
if (overlays.length) {
  // Per-coin 7d mean funding, annualised (8h prints ×3×365). <10 prints → null.
  const fundAnn = new Map();
  for (const coin of ['BTC', 'ETH', 'BNB', 'SOL']) {
    const rows = loadCtx(`funding_${coin}.json`) ?? [];
    const out = new Array(grid.length).fill(null);
    let j = 0; const win = [];
    for (let gi = 0; gi < grid.length; gi++) {
      while (j < rows.length && rows[j].t <= grid[gi]) { win.push(rows[j].r); if (win.length > 21) win.shift(); j++; }
      if (win.length >= 10) out[gi] = (win.reduce((s, r) => s + r, 0) / win.length) * 3 * 365;
    }
    fundAnn.set(coin, out);
  }
  OVERLAY_DEFS.F1 = {
    desc: 'block+exit while 7d mean funding > 50%/yr (overheated longs)',
    factor: (coin, gi) => { const f = fundAnn.get(coin)?.[gi]; return f == null ? 1 : f > 0.50 ? 0 : 1; },
  };
  OVERLAY_DEFS.F2 = {
    desc: 'scale down as 7d funding rises 10→60%/yr (floor 0.25)',
    factor: (coin, gi) => {
      const f = fundAnn.get(coin)?.[gi];
      return f == null ? 1 : Math.min(1, Math.max(0.25, 1 - Math.max(0, f - 0.10) / 0.50));
    },
  };

  const ndxRows = loadCtx('fred_NASDAQCOM.json') ?? [];
  { const alpha = 2 / 101; let e = null;
    for (const r of ndxRows) { e = e === null ? r.v : r.v * alpha + e * (1 - alpha); r.e = e; } }
  const ndxAbove = alignToGrid(ndxRows, (r) => (r.v > r.e ? 1 : 0), DAY);
  OVERLAY_DEFS.M1 = {
    desc: 'half size while NASDAQ < its 100d EMA (equity risk-off)',
    factor: (_c, gi) => (ndxAbove[gi] == null ? 1 : ndxAbove[gi] ? 1 : 0.5),
  };

  const dxyRows = loadCtx('fred_DTWEXBGS.json') ?? [];
  { let k = 0;
    for (let i = 0; i < dxyRows.length; i++) {
      while (k < dxyRows.length && dxyRows[k].t <= dxyRows[i].t - 30 * DAY) k++;
      const ref = dxyRows[k - 1];
      dxyRows[i].m = ref && ref.t >= dxyRows[i].t - 40 * DAY ? dxyRows[i].v / ref.v - 1 : null;
    } }
  const dxySurge = alignToGrid(dxyRows, (r) => r.m, DAY);
  OVERLAY_DEFS.M2 = {
    desc: 'half size while broad dollar index up >2% over 30d',
    factor: (_c, gi) => (dxySurge[gi] == null ? 1 : dxySurge[gi] > 0.02 ? 0.5 : 1),
  };

  const mvrvByCoin = new Map();
  for (const asset of ['BTC', 'ETH']) {
    mvrvByCoin.set(asset, alignToGrid(loadCtx(`cm_${asset.toLowerCase()}.json`) ?? [], (r) => r.mvrv, DAY));
  }
  OVERLAY_DEFS.O1 = {
    desc: 'half size while MVRV > 3 (on-chain froth; BTC/ETH only)',
    factor: (coin, gi) => { const m = mvrvByCoin.get(coin)?.[gi]; return m == null ? 1 : m > 3 ? 0.5 : 1; },
  };

  const fngAligned = alignToGrid(loadCtx('fng.json') ?? [], (r) => r.v, DAY / 2);
  OVERLAY_DEFS.G1 = {
    desc: 'half size while Fear & Greed ≥ 80 (extreme greed)',
    factor: (_c, gi) => { const v = fngAligned[gi]; return v == null ? 1 : v >= 80 ? 0.5 : 1; },
  };
}

// ── A. TSM sleeve: one coin, long (optionally vol-scaled) when rule true ────
// Realized-vol series for vol targeting: annualised std of the last 60 bar
// returns (30 days). Uses closed data only (window ends at the decision bar).
const volCache = new Map();
function realizedVolAnnual(coin) {
  if (volCache.has(coin)) return volCache.get(coin);
  const { closes, firstIdx } = coins.get(coin);
  const W = 60;
  const v = new Array(grid.length).fill(null);
  if (firstIdx !== null) {
    for (let gi = firstIdx + W + 1; gi < grid.length; gi++) {
      let mean = 0; const rets = [];
      for (let k = gi - W + 1; k <= gi; k++) { const r = closes[k] / closes[k - 1] - 1; rets.push(r); mean += r; }
      mean /= W;
      const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (W - 1));
      v[gi] = sd * Math.sqrt(BARS_PER_YEAR);
    }
  }
  volCache.set(coin, v);
  return v;
}

function simSleeve(coin, ruleKey, { volTarget = null, tfScale = null } = {}) {
  const { bars, closes } = coins.get(coin);
  const on = RULES[ruleKey].make(coin);
  const vol = volTarget ? realizedVolAnnual(coin) : null;
  let cash = 1, qty = 0, roundTrips = 0, investedBars = 0;
  let pendingTf = null; // target fraction decided at close, executed next open
  const eq = new Array(grid.length).fill(1);
  const slip = slipFor(coin);
  for (let gi = 0; gi < grid.length; gi++) {
    const bar = bars[gi];
    if (pendingTf !== null && bar) {
      const open = bar.open;
      const e = cash + qty * open;
      const deltaUsd = pendingTf * e - qty * open;
      if (deltaUsd > 0) {
        const spend = Math.min(deltaUsd, cash);
        if (spend > 0) { qty += (spend * (1 - FEE)) / (open * (1 + slip)); cash -= spend; }
      } else if (deltaUsd < 0) {
        const sellQty = Math.min(-deltaUsd / open, qty);
        cash += sellQty * open * (1 - slip) * (1 - FEE);
        qty -= sellQty;
        if (pendingTf === 0) { qty = 0; roundTrips++; }
      }
      pendingTf = null;
    }
    eq[gi] = cash + qty * (closes[gi] ?? 0);
    if (qty > 0) investedBars++;
    const sig = on(gi);
    let tf = sig ? 1 : 0;
    if (sig && vol) {
      const rv = vol[gi];
      if (rv && rv > 0) tf = Math.min(1, Math.max(0.2, volTarget / rv));
    }
    if (sig && tfScale) tf *= tfScale(coin, gi);
    // Full entries/exits always trade; vol-rebalances only when drift > 15%
    // of sleeve equity (keeps churn and fee drag bounded).
    const cur = eq[gi] > 0 ? (qty * (closes[gi] ?? 0)) / eq[gi] : 0;
    const full = (tf === 0 && qty > 0) || (tf > 0 && qty === 0);
    pendingTf = full || Math.abs(tf - cur) > 0.15 ? tf : null;
  }
  return { eq, roundTrips, investedBars };
}

function simTsm(universe, ruleKey, opts = {}) {
  const sleeves = universe.filter((c) => coins.has(c)).map((c) => simSleeve(c, ruleKey, opts));
  const share = START_CAPITAL / universe.length;
  const eq = grid.map((_, gi) => sleeves.reduce((s, sl) => s + sl.eq[gi] * share, 0)
    + (universe.length - sleeves.length) * share);
  return {
    eq,
    roundTrips: sleeves.reduce((s, sl) => s + sl.roundTrips, 0),
    exposure: sleeves.reduce((s, sl) => s + sl.investedBars, 0) / (grid.length * universe.length),
  };
}

// ── B. Cross-sectional momentum rotation, BTC-regime gated ──────────────────
const btcEma200d = emaSeries('BTC', 400);
function simRotation({ lookbackBars, topK, rebalanceEvery = 20 }) {
  let cash = START_CAPITAL;
  const pos = new Map();
  let pendingTarget = null, trades = 0, investedSum = 0, investedN = 0;
  const eq = new Array(grid.length).fill(START_CAPITAL);
  for (let gi = 0; gi < grid.length; gi++) {
    if (pendingTarget) {
      // pass 1: sell drops + trim keeps; pass 2: buy — so buys are funded
      for (const [coin, qty] of [...pos]) {
        const bar = coins.get(coin).bars[gi];
        if (!bar) continue; // no bar this slot — hold until next rebalance
        if (!pendingTarget.has(coin)) {
          cash += qty * bar.open * (1 - slipFor(coin)) * (1 - FEE);
          pos.delete(coin); trades++;
        }
      }
      let equityOpen = cash;
      for (const [coin, qty] of pos) equityOpen += qty * (coins.get(coin).bars[gi]?.open ?? coins.get(coin).closes[gi] ?? 0);
      const per = equityOpen / topK; // fixed 1/K slots — cash sits idle when few qualify
      for (const [coin, qty] of [...pos]) {
        const bar = coins.get(coin).bars[gi];
        if (!bar || !pendingTarget.has(coin)) continue;
        const excess = qty * bar.open - per;
        if (excess > per * 0.05) {
          const sellQty = excess / bar.open;
          cash += sellQty * bar.open * (1 - slipFor(coin)) * (1 - FEE);
          pos.set(coin, qty - sellQty); trades++;
        }
      }
      for (const coin of pendingTarget) {
        const bar = coins.get(coin)?.bars[gi];
        if (!bar) continue;
        const cur = (pos.get(coin) ?? 0) * bar.open;
        const spend = Math.min(per - cur, cash);
        if (spend > per * 0.05) {
          const px = bar.open * (1 + slipFor(coin));
          pos.set(coin, (pos.get(coin) ?? 0) + (spend * (1 - FEE)) / px);
          cash -= spend; trades++;
        }
      }
      pendingTarget = null;
    }
    let equity = cash;
    for (const [coin, qty] of pos) equity += qty * (coins.get(coin).closes[gi] ?? 0);
    eq[gi] = equity;
    investedSum += (equity - cash) / equity; investedN++;
    if (gi % rebalanceEvery === 0 && btcEma200d[gi] !== null) {
      const gateOn = coins.get('BTC').closes[gi] > btcEma200d[gi];
      if (!gateOn) pendingTarget = new Set();
      else {
        const scored = [];
        for (const coin of ROT_UNIVERSE) {
          const d = coins.get(coin);
          if (!d || d.firstIdx === null || gi - lookbackBars < d.firstIdx) continue;
          const r = d.closes[gi] / d.closes[gi - lookbackBars] - 1;
          if (r > 0) scored.push([coin, r]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        pendingTarget = new Set(scored.slice(0, topK).map((x) => x[0]));
      }
    }
  }
  return { eq, roundTrips: Math.round(trades / 2), exposure: investedSum / investedN };
}

// ── Metrics ──────────────────────────────────────────────────────────────────
// Start-date sensitivity window: strategies simulate over the FULL history
// (signal state carries in), but metrics are computed on the [--from, --to]
// slice — i.e. an investor walking in on that date. Renormalisation is
// implicit: returns/DD are relative to the slice's first value.
const WIN0 = fromDate ? Math.max(grid.findIndex((ts) => ts >= fromDate), 0) : 0;
const WIN1 = toDate ? (grid.findIndex((ts) => ts > toDate) === -1 ? grid.length - 1 : grid.findIndex((ts) => ts > toDate) - 1) : grid.length - 1;

const BEAR_START = Date.UTC(2021, 10, 8);
const BEAR_END = Date.UTC(2022, 11, 31);
function metrics(fullEq, { withDsr = false } = {}) {
  const eq = fullEq.slice(WIN0, WIN1 + 1);
  const win = grid.slice(WIN0, WIN1 + 1);
  const returns = [];
  for (let gi = 1; gi < eq.length; gi++) {
    if (eq[gi - 1] > 0) returns.push(eq[gi] / eq[gi - 1] - 1);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(BARS_PER_YEAR) : 0;
  let peak = eq[0], maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; maxDD = Math.min(maxDD, v / peak - 1); }
  const years = eq.length / BARS_PER_YEAR;
  const total = eq[eq.length - 1] / eq[0] - 1;
  const yearly = {};
  let yStartVal = eq[0], yStartYear = new Date(win[0]).getUTCFullYear();
  for (let gi = 1; gi < eq.length; gi++) {
    const y = new Date(win[gi]).getUTCFullYear();
    if (y !== yStartYear) {
      yearly[yStartYear] = Number((eq[gi - 1] / yStartVal - 1).toFixed(4));
      yStartVal = eq[gi - 1]; yStartYear = y;
    }
  }
  yearly[yStartYear] = Number((eq[eq.length - 1] / yStartVal - 1).toFixed(4));
  const bi0 = win.findIndex((ts) => ts >= BEAR_START);
  const bi1 = win.findIndex((ts) => ts >= BEAR_END);
  let bear = null;
  if (bi0 > 0 && bi1 > bi0) {
    let bPeak = eq[bi0], bDD = 0;
    for (let gi = bi0; gi <= bi1; gi++) { if (eq[gi] > bPeak) bPeak = eq[gi]; bDD = Math.min(bDD, eq[gi] / bPeak - 1); }
    bear = { returnPct: Number(((eq[bi1] / eq[bi0] - 1) * 100).toFixed(1)), maxDDPct: Number((bDD * 100).toFixed(1)) };
  }
  const out = {
    totalReturnPct: Number((total * 100).toFixed(1)),
    cagrPct: Number(((Math.pow(1 + total, 1 / years) - 1) * 100).toFixed(1)),
    sharpe: Number(sharpe.toFixed(2)),
    maxDDPct: Number((maxDD * 100).toFixed(1)),
    yearly, bear2122: bear,
  };
  if (withDsr) {
    const d = deflatedSharpeRatio({ observedSharpe: sharpe, returns, nTrials: N_TRIALS, periodsPerYear: BARS_PER_YEAR });
    out.dsr = d.dsr; out.psr = d.psr;
  }
  return out;
}

// ── Run the grid ─────────────────────────────────────────────────────────────
const results = { meta: { nTrials: N_TRIALS, quote, bars: WIN1 - WIN0 + 1, from: new Date(grid[WIN0]).toISOString().slice(0, 10), to: new Date(grid[WIN1]).toISOString().slice(0, 10) } };

const benchmarks = {};
const benchmarkDefs = [['BTC buy&hold', ['BTC']], ['ETH buy&hold', ['ETH']], ['EW BTC+ETH B&H', ['BTC', 'ETH']]];
if (universeArg) benchmarkDefs.push([`EW ${universeArg.length}-majors B&H`, universeArg]);
for (const [name, universe] of benchmarkDefs) {
  // B&H = a "rule" that is always on after bar 0
  const sleeves = universe.map((c) => {
    const { bars, closes } = coins.get(c);
    let cash = 1, qty = 0;
    const eq = grid.map((_, gi) => {
      if (qty === 0 && bars[gi]) { qty = (cash * (1 - FEE)) / (bars[gi].open * (1 + slipFor(c))); cash = 0; }
      return cash + qty * (closes[gi] ?? 0);
    });
    return eq;
  });
  const eq = grid.map((_, gi) => sleeves.reduce((s, sl) => s + (sl[gi] * START_CAPITAL) / universe.length, 0));
  benchmarks[name] = metrics(eq);
}
results.benchmarks = benchmarks;

const tsmCells = {};
const universes = { 'BTC+ETH': ['BTC', 'ETH'], 'BTC+ETH+BNB+SOL': ['BTC', 'ETH', 'BNB', 'SOL'] };
if (universeArg) universes[`EW${universeArg.length}-majors`] = universeArg;
const eqCache = {};
const addTsmCell = (key, universe, ruleKey, opts = {}) => {
  const { eq, roundTrips, exposure } = simTsm(universe, ruleKey, opts);
  tsmCells[key] = { ...metrics(eq, { withDsr: true }), roundTrips, exposurePct: Number((exposure * 100).toFixed(0)) };
  eqCache[key] = eq;
};
for (const [uName, universe] of Object.entries(universes)) {
  for (const ruleKey of Object.keys(RULES)) {
    addTsmCell(`${ruleKey} ${uName}`, universe, ruleKey);
  }
}
if (volTargetAnnual && voteDays) {
  const voteKey = `vote${voteDays.join('/')}d`;
  for (const [uName, universe] of Object.entries(universes)) {
    addTsmCell(`${voteKey} volT${volTargetAnnual} ${uName}`, universe, voteKey, { volTarget: volTargetAnnual });
  }
  if (hysteresis) { // do the two independent improvers stack?
    for (const [uName, universe] of Object.entries(universes)) {
      addTsmCell(`${voteKey} slow-in volT${volTargetAnnual} ${uName}`, universe, `${voteKey} slow-in`, { volTarget: volTargetAnnual });
    }
  }
  // Context overlays ride on the full combo (slow-in + vol target) — the
  // shipping-trajectory rule — on the two primary universes only.
  if (overlays.length && hysteresis) {
    const comboRule = `${voteKey} slow-in`;
    for (const ov of overlays) {
      const def = OVERLAY_DEFS[ov];
      if (!def) { console.warn(`unknown overlay: ${ov}`); continue; }
      for (const [uName, universe] of [['BTC+ETH', ['BTC', 'ETH']], ['BTC+ETH+BNB+SOL', ['BTC', 'ETH', 'BNB', 'SOL']]]) {
        addTsmCell(`combo +${ov} ${uName}`, universe, comboRule, { volTarget: volTargetAnnual, tfScale: def.factor });
      }
    }
  }
}
results.tsmCore = tsmCells;

const rotCells = {};
const rotKs = universeArg ? [2, 3] : [3, 4]; // concentrate more on a small majors universe
if (ROT_UNIVERSE.length) {
  for (const lookbackDays of [30, 90]) {
    for (const topK of rotKs) {
      const { eq, roundTrips, exposure } = simRotation({ lookbackBars: lookbackDays * 2, topK });
      const key = `rot ${lookbackDays}d top${topK}`;
      rotCells[key] = { ...metrics(eq, { withDsr: true }), roundTrips, exposurePct: Number((exposure * 100).toFixed(0)) };
      eqCache[key] = eq;
    }
  }
}
results.rotation = rotCells;

// Blend uses the DECLARED priors (ema200d BTC+ETH / rot 90d top4), not the best cells
results.blend = {};
const eqA = eqCache['ema200d BTC+ETH'];
const eqB = eqCache['rot 90d top4'];
if (eqA && eqB) {
  const eqC = grid.map((_, gi) => 0.5 * eqA[gi] + 0.5 * eqB[gi]);
  results.blend = { 'blend 50/50 (prior cells)': metrics(eqC, { withDsr: true }) };
}

// ── Report ───────────────────────────────────────────────────────────────────
const fmt = (m) => `ret ${String(m.totalReturnPct).padStart(7)}%  cagr ${String(m.cagrPct).padStart(5)}%  Sh ${String(m.sharpe).padStart(5)}  DD ${String(m.maxDDPct).padStart(6)}%` +
  (m.dsr != null ? `  DSR ${m.dsr.toFixed(2)}  PSR ${m.psr.toFixed(2)}` : '') +
  (m.exposurePct != null ? `  exp ${String(m.exposurePct).padStart(3)}%` : '') +
  (m.roundTrips != null ? `  rt ${m.roundTrips}` : '') +
  (m.bear2122 ? `  bear21-22 ${m.bear2122.returnPct}% (DD ${m.bear2122.maxDDPct}%)` : '');

console.log(`\nTrend-core study  ${results.meta.from} → ${results.meta.to}  (${results.meta.bars} bars, DSR deflated for ${N_TRIALS} trials)\n`);
console.log('── Benchmarks ──');
for (const [k, m] of Object.entries(benchmarks)) console.log(`  ${k.padEnd(24)} ${fmt(m)}`);
console.log('\n── A. TSM majors core ──');
for (const [k, m] of Object.entries(tsmCells)) console.log(`  ${k.padEnd(24)} ${fmt(m)}`);
console.log('\n── B. Momentum rotation (survivorship-biased universe — treat as upper bound) ──');
for (const [k, m] of Object.entries(rotCells)) console.log(`  ${k.padEnd(24)} ${fmt(m)}`);
console.log('\n── C. Blend ──');
for (const [k, m] of Object.entries(results.blend)) console.log(`  ${k.padEnd(24)} ${fmt(m)}`);
console.log('\nYearly returns:');
for (const [key, m] of [...Object.entries(tsmCells), ...Object.entries(rotCells)]) {
  console.log(`  ${key.padEnd(24)} ${Object.entries(m.yearly).map(([y, r]) => `${y}: ${(r * 100).toFixed(0)}%`).join('  ')}`);
}

// Optional curve export. Summary metrics cannot answer "do two sleeves draw down
// together?" — that needs the series. Keeps the default output lean.
if (argv.includes('--dump-curves')) {
  const curveFile = argv[argv.indexOf('--dump-curves') + 1];
  const wanted = argv.includes('--curve-keys')
    ? argv[argv.indexOf('--curve-keys') + 1].split('|')
    : Object.keys(eqCache);
  const dump = { grid, curves: {} };
  for (const k of wanted) if (eqCache[k]) dump.curves[k] = eqCache[k];
  fs.writeFileSync(curveFile, JSON.stringify(dump));
  console.log(`Curves → ${curveFile} (${Object.keys(dump.curves).length} of ${Object.keys(eqCache).length})`);
}

fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
console.log(`\nSaved → ${outFile}`);

/**
 * runSleeveCorrelation.mjs
 *
 * Are the scalper and the TSM core sleeve actually diversifying, or the same
 * long-crypto bet wearing two hats?
 *
 * This drives sizing, not curiosity. `tsmCore.deploymentPct` was set to 0.20 on
 * the conservative assumption that the two drawdowns roughly ADD (sleeve ~-33% ×
 * 0.20 ≈ -7%, plus the scalper's ~-4%). If the curves are weakly correlated the
 * combined drawdown is smaller than that sum, and the same -10% budget buys MORE
 * deployment — more return at unchanged risk. If they move together, 0.20 is
 * already too generous.
 *
 * The sleeve curve is NOT re-simulated here. It is read from runTrendCore's own
 * equity cache, which is the validated simulator behind the shipping rule. An
 * earlier draft of this script re-implemented the sleeve and produced a -96.7%
 * drawdown against the study's -33.0% — a parallel implementation is exactly the
 * drift this codebase keeps paying for.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runTrendCore.mjs --quote USDC \
 *     --vote 30,45,60 --hysteresis --vol-target 0.6 \
 *     --dump-curves /tmp/curves.json --out /tmp/tc.json
 *   PAPER_MODE=true node src/scripts/runSleeveCorrelation.mjs --curves /tmp/curves.json
 */
import fs from 'fs';
import config from '../../config/default.js';
import {
  loadAllSymbols, loadMtfCandles, runWindow, defineWindows, FULL_LIVE_FILTERS,
} from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const argv = process.argv.slice(2);
const budget = argv.includes('--budget') ? Number(argv[argv.indexOf('--budget') + 1]) : 1000;
const curvesFile = argv.includes('--curves') ? argv[argv.indexOf('--curves') + 1] : null;
const curveKey = argv.includes('--curve-key')
  ? argv[argv.indexOf('--curve-key') + 1]
  : 'vote30/45/60d slow-in volT0.6 BTC+ETH+BNB+SOL';

if (!curvesFile) {
  console.error('--curves <file> required (produce it with runTrendCore --dump-curves)');
  process.exit(1);
}

const pctReturns = (v) => v.slice(1).map((x, i) => (v[i] > 0 ? x / v[i] - 1 : 0));

function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  const x = a.slice(-n); const y = b.slice(-n);
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0; let dx = 0; let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

function maxDrawdownPct(v) {
  let peak = -Infinity; let worst = 0;
  for (const x of v) { if (x > peak) peak = x; if (peak > 0) worst = Math.min(worst, x / peak - 1); }
  return worst * 100;
}

// ── sleeve curve (validated simulator) ────────────────────────────────────────
const dump = JSON.parse(fs.readFileSync(curvesFile, 'utf8'));
const sleeveEq = dump.curves?.[curveKey];
if (!sleeveEq) {
  console.error(`curve "${curveKey}" not in ${curvesFile}.\nAvailable:\n  ` +
    Object.keys(dump.curves ?? {}).join('\n  '));
  process.exit(1);
}
const sleeveBy = new Map(dump.grid.map((t, i) => [Number(t), Number(sleeveEq[i])]));

// ── scalper curve ─────────────────────────────────────────────────────────────
const symbols = config.symbols;
const candles = await loadAllSymbols(symbols, '12h');
const windows = defineWindows(candles);
const target = windows.find((w) => /Full history/.test(w.label)) ?? windows.at(-1);

const run = runWindow({
  window: target,
  symbolCandles: candles,
  mtf15mCandles: loadMtfCandles(symbols, '15m'),
  mtf4hCandles: loadMtfCandles(symbols, '4h'),
  fearGreedData: await loadFearGreedHistory().catch(() => null),
  budget,
  includeRaw: true,
  filterOverrides: FULL_LIVE_FILTERS,
  basePctOverride: config.risk.maxPositionPct,
});

// The simulator records an equity snapshot per SYMBOL per bar, so collapse to one
// point per timestamp (the last write wins) before aligning.
const perBar = new Map();
for (const p of run.equity_curve ?? []) {
  const t = Number(p.timestamp);
  const e = Number(p.balance ?? p.equity);
  if (Number.isFinite(t) && Number.isFinite(e)) perBar.set(t, e);
}

const aligned = [...perBar.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([t, s]) => ({ t, s, c: sleeveBy.get(t) }))
  .filter((p) => Number.isFinite(p.c) && p.c > 0);

if (aligned.length < 50) {
  console.error(`\n⚠️  only ${aligned.length} aligned points (scalper ${perBar.size}, sleeve ${sleeveBy.size}) — aborting.\n`);
  process.exit(1);
}

const S = aligned.map((p) => p.s);
const C = aligned.map((p) => p.c);
const rho = correlation(pctReturns(S), pctReturns(C));

console.log(`\n${'='.repeat(80)}`);
console.log('  SCALPER vs TSM SLEEVE — do they diversify?');
console.log(`  ${target.label} · ${aligned.length} aligned 12h bars · budget $${budget}`);
console.log(`  sleeve curve: ${curveKey}`);
console.log(`${'='.repeat(80)}\n`);
console.log(`  scalper standalone maxDD : ${maxDrawdownPct(S).toFixed(2)}%`);
console.log(`  sleeve  standalone maxDD : ${maxDrawdownPct(C).toFixed(2)}%   (fully deployed)`);
console.log(`  12h return correlation ρ : ${rho == null ? 'n/a' : rho.toFixed(3)}\n`);

// CONSTANT-WEIGHT combination, because that is what the bot does: the sleeve is
// sized to `deploymentPct × current equity` every cycle, with drift rebalancing
// (resizeCorePosition, 15% band). Combining the two curves buy-and-hold instead
// would let the faster-growing sleeve silently inflate its own share — over this
// window it grows +543% against the scalper's +205%, so a nominal 20% allocation
// ends up dominating the portfolio and the drawdown looks far worse than the bot
// would actually experience.
const rS = pctReturns(S);
const rC = pctReturns(C);
function combinedCurve(d) {
  const out = [1];
  for (let i = 0; i < rS.length; i++) out.push(out[i] * (1 + (1 - d) * rS[i] + d * rC[i]));
  return out;
}

console.log('  deploy   combined maxDD   weighted-avg DD   vs additive   combined return');
for (const d of [0.10, 0.20, 0.30, 0.40, 0.50, 0.75, 1.00]) {
  const comb = combinedCurve(d);
  const actual = maxDrawdownPct(comb);
  // Weighted average of the standalone drawdowns — what you would expect if the
  // two sleeves bottomed at the same instant. Shallower actual ⇒ diversification.
  const additive = (1 - d) * maxDrawdownPct(S) + d * maxDrawdownPct(C);
  const benefit = actual - additive; // positive ⇒ combined is SHALLOWER than additive
  console.log(
    `   ${d.toFixed(2)}      ${actual.toFixed(2).padStart(7)}%       ${additive.toFixed(2).padStart(7)}%      ` +
    `${(benefit >= 0 ? '+' : '') + benefit.toFixed(2).padStart(6)}pp    ${((comb.at(-1) - 1) * 100).toFixed(1).padStart(9)}%`,
  );
}

const BUDGET_DD = -10;
let best = 0;
for (let d = 0; d <= 1.001; d += 0.01) {
  if (maxDrawdownPct(combinedCurve(d)) >= BUDGET_DD) best = d;
}
const bestComb = combinedCurve(best);
console.log(`\n  Largest deployment holding combined maxDD ≥ ${BUDGET_DD}%: ${best.toFixed(2)}`);
console.log(`  → combined return ${((bestComb.at(-1) - 1) * 100).toFixed(1)}%, maxDD ${maxDrawdownPct(bestComb).toFixed(2)}%`);
console.log(`  currently configured: ${config.tsmCore.deploymentPct}\n`);

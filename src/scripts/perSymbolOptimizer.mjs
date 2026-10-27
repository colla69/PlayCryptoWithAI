/**
 * Per-symbol strategy optimizer with holdout validation.
 *
 * Methodology matches how the current config was built:
 *   - Training window  = the later half of the last `--candles` 12h bars (Y2, more recent)
 *   - Holdout window   = the earlier half (Y1, unseen/older)
 *   - Optimise on Y2, validate on Y1 — same as all config comments "Y2 +X% Y1 +Y%"
 *
 * Tests all C(20,3) = 1140 three-strategy combinations from the full pool:
 *   RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR,
 *   StochRSI, HeikinAshi, SR, Donchian, VWAPσ, VolSurge, Ichimoku, PinBar
 *
 * Every combo is scored through the live filter stack (src/backtester/symbolTrial.js):
 * a PortfolioBacktester run with FULL_LIVE_FILTERS, live sizing and multi-bar
 * confirmation, in which only the coin under test trades and every other coin feeds
 * the regime, macro and median-ATR context. It used to score raw votes in a bare
 * simulator and picked combos the live bot never trades (plan 2026-10, C8). Each
 * window trades on the full history before it (warm indicators), and the holdout sees
 * no bar after its end. Not modelled per coin: the 4-slot competition and the
 * correlation cap — re-run the portfolio replay before applying a change.
 *
 * Speed: the 20 strategies are computed once per coin; a combo is one vote pass and
 * one portfolio run (~70 ms). Coins run in parallel child processes (--workers).
 *
 * Usage:
 *   PAPER_MODE=true FILE_LOG_LEVEL=warn node src/scripts/perSymbolOptimizer.mjs
 *   ... --symbols BNB/USDC,ICX/USDC   --candles 1460   --workers 10
 *   ... --apply   (writes config.js changes)   --minImprovement 0.15
 * FILE_LOG_LEVEL=warn keeps the aggregator's per-bar debug lines out of logs/.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import os from 'os';

import config from '../../config/default.js';
import { dailyReturnsFromEquity } from '../backtester/metrics.js';
import {
  loadAllSymbols, loadMtfCandles, FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides,
} from '../backtester/baselineFramework.js';
import {
  precomputeStrategyResults, cachedStrategy, trialContext, runSymbolTrial,
} from '../backtester/symbolTrial.js';
import { buildStrategy, STRATEGY_NAMES } from '../utils/strategyBuilder.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let symbolFilter    = null;
let applyChanges    = false;
let minImprovement  = 0.10; // 10% composite score lift on holdout required
let candleCount     = 1460;  // 2 years of 12h = matching original optimization methodology
let workers         = Math.max(1, os.cpus().length - 2);
let jsonOut         = false; // child mode: print one JSON result line per symbol

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--symbols'        && argv[i + 1]) { symbolFilter   = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (argv[i] === '--apply')                          { applyChanges   = true; continue; }
  if (argv[i] === '--minImprovement' && argv[i + 1]) { minImprovement = Number(argv[++i]); continue; }
  if (argv[i] === '--candles'        && argv[i + 1]) { candleCount    = Number(argv[++i]); continue; }
  if (argv[i] === '--workers'        && argv[i + 1]) { workers        = Number(argv[++i]); continue; }
  if (argv[i] === '--json')                           { jsonOut        = true; continue; }
}

// ── Combination generator ─────────────────────────────────────────────────────
function combinations(arr, k) {
  const result = [];
  function pick(start, current) {
    if (current.length === k) { result.push([...current]); return; }
    for (let i = start; i < arr.length; i++) {
      current.push(arr[i]);
      pick(i + 1, current);
      current.pop();
    }
  }
  pick(0, []);
  return result;
}

const ALL_COMBOS = combinations(STRATEGY_NAMES, 3); // C(20,3) = 1140
const CONF_VARIANTS = [0.55, 0.70];

// ── Composite score (Phase 1 — robustness-first) ─────────────────────────────
// Increased MIN_TRADES from 3 to 8: the previous threshold accepted essentially
// single-event validations as legitimate, which is why many config entries
// tagged [3t] or [4t] survived but show 0.00 deflated Sharpe in the Phase 0
// baseline. With 8+ trades we get a defensible win-rate / Sharpe estimate.
//
// Sample-size shrinkage: combos with 8 ≤ n < 15 trades get an explicit
// penalty (multiplies the raw composite by n/15) to discourage upgrading to a
// borderline-significant combo when a more-traded one is available.
//
// Deflated Sharpe cut-off: combos with DSR < 0.50 are penalised — that's the
// Bailey-Prado threshold below which the observed Sharpe is indistinguishable
// from data dredging given the search burden (~2280 combos × conf thresholds
// per symbol after Phase 2 expanded the pool from 15 to 20 strategies).
const MIN_TRADES                 = 8;     // strict holdout sample minimum
const SAMPLE_SIZE_SHRINKAGE_CEIL = 15;    // below this we shrink toward zero
const DEFLATED_SHARPE_FLOOR      = 0.50;  // below this we penalise
const SEARCH_BURDEN_N_TRIALS     = 2280;  // per-symbol: ~1140 combos × 2 conf

import { deflatedSharpeRatio } from '../backtester/deflatedSharpe.js';

function compositeScore(m) {
  if (!m || m.totalTrades < MIN_TRADES) return -1000;
  if (m.maxDrawdown > 0.5) return -500;
  const sharpe  = Number.isFinite(m.sharpeRatio)  ? m.sharpeRatio  : 0;
  const calmar  = m.maxDrawdown > 0 ? m.totalReturn / m.maxDrawdown : 0;
  const pf      = Math.min(Number.isFinite(m.profitFactor) ? m.profitFactor : 0, 5);
  const raw = (
    sharpe                          * 0.30 +
    calmar                          * 0.25 +
    m.winRate                       * 0.20 +
    pf                              * 0.10 +
    Math.min(m.totalReturn, 2)      * 0.15
  );

  // Shrink small-sample scores toward zero (linear factor in [n/15, 1])
  const sampleShrinkage = m.totalTrades >= SAMPLE_SIZE_SHRINKAGE_CEIL
    ? 1
    : m.totalTrades / SAMPLE_SIZE_SHRINKAGE_CEIL;

  // Deflated Sharpe penalty — multiplies composite by min(1, DSR/0.5)
  // when DSR is below threshold. We use a per-symbol N=440 trials (the
  // search space the optimizer itself ran), not the cross-symbol 16280
  // burden — each symbol's selection is an independent search.
  const equity = m._equityCurve ?? [];
  const initBal = m._initialBalance ?? 1000;
  const rets = [...dailyReturnsFromEquity(equity, initBal).values()];
  let dsrFactor = 1;
  if (rets.length >= 4 && Number.isFinite(sharpe)) {
    const dsr = deflatedSharpeRatio({
      observedSharpe: sharpe,
      returns: rets,
      nTrials: SEARCH_BURDEN_N_TRIALS,
    }).dsr;
    if (dsr < DEFLATED_SHARPE_FLOOR) {
      dsrFactor = Math.max(0, dsr / DEFLATED_SHARPE_FLOOR);
    }
  }

  return raw * sampleShrinkage * dsrFactor;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fp(v) { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }
function fs(v) { return (Number.isFinite(v) ? v : 0).toFixed(2); }

const watchList = symbolFilter ?? config.symbols;

// ── Parent: fan the coins out to child processes, then report ─────────────────
if (!jsonOut) {
  console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║        PER-SYMBOL STRATEGY OPTIMIZER — live filter stack, 20 pool    ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');
  console.log(`  Pool       : ${STRATEGY_NAMES.join(', ')} (${STRATEGY_NAMES.length} strategies)`);
  console.log(`  Combos     : ${ALL_COMBOS.length} × ${CONF_VARIANTS.length} confidence variants = ${ALL_COMBOS.length * CONF_VARIANTS.length} per window`);
  console.log(`  Candles    : last ${candleCount} 12h bars of BTC/USDC — earlier half = holdout (Y1), later half = training (Y2)`);
  console.log(`  Min trades : ${MIN_TRADES} on holdout  |  Min improvement: ${(minImprovement * 100).toFixed(0)}%  |  workers: ${workers}`);
  console.log(applyChanges ? '  Mode       : APPLY (will write config changes)' : '  Mode       : DRY-RUN (use --apply to write changes)');
  console.log('');

  const results = new Array(watchList.length);
  let next = 0;
  const runOne = (sym) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url), '--json', '--symbols', sym, '--candles', String(candleCount),
    ], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('{"symbol"'));
      if (code !== 0 || !line) reject(new Error(`${sym}: child exited ${code}`));
      else resolve(JSON.parse(line));
    });
  });
  await Promise.all(Array.from({ length: Math.min(workers, watchList.length) }, async () => {
    while (next < watchList.length) {
      const k = next++;
      results[k] = await runOne(watchList[k]);
      process.stderr.write(`  done ${results.filter(Boolean).length}/${watchList.length} (${watchList[k]})\n`);
    }
  }));

  const upgrades = [];
  for (const r of results) {
    if (r.skipped) { console.log(`  ⚠️  ${r.symbol}: ${r.skipped} — skipped\n`); continue; }
    report(r);
    if (r.upgrade) upgrades.push(r.upgrade);
  }
  summarize(upgrades);
  process.exit(0);
}

// ── Child: one coin ───────────────────────────────────────────────────────────
const [symbol] = watchList;
const symbolCandles = await loadAllSymbols(config.symbols, config.timeframe);
const symbols = Object.keys(symbolCandles);
const btc = symbolCandles['BTC/USDC'];
if (!btc) throw new Error('BTC/USDC 12h candles are required for the regime and macro context');
const startTs = Number(btc.at(-Math.min(candleCount, btc.length)).timestamp);
const midTs = Number(btc.at(-Math.floor(candleCount / 2)).timestamp);
const own = symbolCandles[symbol];
const inSpan = own ? own.filter((c) => c.timestamp >= startTs).length : 0;
if (inSpan < candleCount * 0.8) {
  console.log(JSON.stringify({ symbol, skipped: own ? `only ${inSpan} candles in the span` : 'no data' }));
  process.exit(0);
}

const { symbolRisk } = buildPerSymbolOverrides(symbols);
const fearGreedData = await loadFearGreedHistory();
const mtf15m = loadMtfCandles(symbols, '15m');
const mtf4h = loadMtfCandles(symbols, '4h');
const btConfig = (tradeFromTs) => ({
  risk: {
    ...(config.risk ?? {}), initialBalance: 1000, basePctOverride: config.risk?.maxPositionPct,
    feePct: 0.001, slippagePct: 0.001, breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
  },
  signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
  maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
  symbolSlippage: SLIPPAGE_TIERS, symbolRisk,
  mtfSymbolCandles: mtf15m, mtf4hSymbolCandles: mtf4h, fearGreedData,
  confidenceThresholdScale: config.risk?.confidenceThresholdScale,
  ...FULL_LIVE_FILTERS,
  tradeFromTs,
});
// Holdout: trades [start, mid) and sees no bar from mid on. Training: trades [mid, end].
const cutBefore = (ts) => Object.fromEntries(Object.entries(symbolCandles)
  .map(([s, c]) => [s, c.filter((x) => Number(x.timestamp) < ts)]).filter(([, c]) => c.length > 0));
const holdoutCtx = trialContext({ symbolCandles: cutBefore(midTs), btConfig: btConfig(startTs) });
const trainingCtx = trialContext({ symbolCandles, btConfig: btConfig(midTs) });

// Every strategy once, on the coin's full history (a result reads only its own past)
const cache = precomputeStrategyResults(own, Object.fromEntries(STRATEGY_NAMES.map((n) => [n, buildStrategy(n, symbol)])));

// ── Run one combo on a window, through the live filter stack ──────────────────
function runWindow(ctx, comboNames, minConf) {
  const strategies = comboNames.map((n) => {
    if (!cache[n]) throw new Error(`${symbol}: unknown strategy ${n}`);
    return cachedStrategy(n, cache[n]);
  });
  const { metrics, equityCurve, initialBalance } = runSymbolTrial(ctx, { symbol, strategies, minConfidence: minConf });
  // Return both metrics and equity curve so compositeScore can compute DSR.
  return { ...metrics, _equityCurve: equityCurve, _initialBalance: initialBalance };
}

const currentCombo = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI', 'BB', 'Stoch'];
const currentConf  = config.perSymbol?.[symbol]?.minConfidence ?? config.risk?.minConfidence ?? 0.70;

// ── 1. Evaluate current combo on holdout (baseline) ───────────────────────
const currentHoldoutM = runWindow(holdoutCtx, currentCombo, currentConf);
const currentScore    = compositeScore(currentHoldoutM);

// ── 2. Run all 1140 combos × 2 conf on TRAINING window ──────────────────
const trainingResults = [];
for (const combo of ALL_COMBOS) {
  for (const conf of CONF_VARIANTS) {
    const m = runWindow(trainingCtx, combo, conf);
    trainingResults.push({ combo, conf, score: compositeScore(m), trades: m.totalTrades });
  }
}

// ── 3. Top 10 by training score → validate on holdout ────────────────────
const top10 = trainingResults
  .filter((r) => r.score > -500)
  .sort((a, b) => b.score - a.score)
  .slice(0, 10);

let bestHoldout    = null;
let bestHoldoutScore = -Infinity;

for (const candidate of top10) {
  const hm    = runWindow(holdoutCtx, candidate.combo, candidate.conf);
  const hScore = compositeScore(hm);
  if (hScore > bestHoldoutScore) {
    bestHoldoutScore = hScore;
    bestHoldout = { ...candidate, holdoutM: hm, holdoutScore: hScore };
  }
}

// For improvement: compare holdout returns directly (composite % is misleading when current=0 trades)
const currentHoldoutReturn = currentHoldoutM?.totalReturn ?? 0;
const bestHoldoutReturn    = bestHoldout?.holdoutM?.totalReturn ?? 0;
const returnDelta          = bestHoldoutReturn - currentHoldoutReturn;
const improve              = currentScore > -500 && Math.abs(currentScore) > 0.01
  ? (bestHoldoutScore - currentScore) / Math.abs(currentScore)
  : returnDelta > 0 ? returnDelta * 10 : 0; // fallback: scale by return delta

// Upgrade criteria (conservative — must beat current on holdout return too):
const shouldUpgrade = (
  bestHoldout !== null &&
  bestHoldout.holdoutM.totalTrades >= MIN_TRADES &&
  bestHoldoutReturn > 0 &&                          // must be profitable
  bestHoldoutReturn > currentHoldoutReturn &&       // must beat current return
  bestHoldoutScore  > currentScore &&               // must beat composite score
  (currentScore < -500 ? returnDelta >= 0.05 : improve >= minImprovement) &&
  // Don't recommend same combo
  !(bestHoldout.combo.join('+') === currentCombo.join('+') && bestHoldout.conf === currentConf)
);

const brief = (m) => ({ ret: m.totalReturn, sharpe: m.sharpeRatio, trades: m.totalTrades });
console.log(JSON.stringify({
  symbol,
  current: { combo: currentCombo, conf: currentConf, ...brief(currentHoldoutM), score: currentScore },
  best: bestHoldout && {
    combo: bestHoldout.combo, conf: bestHoldout.conf, ...brief(bestHoldout.holdoutM), score: bestHoldoutScore,
  },
  // How many training combos trade at all, and reach MIN_TRADES — the C8 symptom
  trainingTrading: trainingResults.filter((r) => r.trades > 0).length,
  trainingEligible: trainingResults.filter((r) => r.trades >= MIN_TRADES).length,
  upgrade: shouldUpgrade ? {
    symbol, newCombo: bestHoldout.combo, newConf: bestHoldout.conf, oldCombo: currentCombo, oldConf: currentConf, returnDelta,
  } : null,
}));
process.exit(0);

// ── Report (parent) ───────────────────────────────────────────────────────────
function report(r) {
  const c = r.current;
  console.log(`${r.symbol.padEnd(14)} current: ${c.combo.join('+').padEnd(26)} conf=${c.conf.toFixed(2)}  holdout: ${fp(c.ret)} Sharpe ${fs(c.sharpe)} [${c.trades}t] score=${c.score.toFixed(2)}`);
  console.log(`${''.padEnd(14)}   training combos that trade: ${r.trainingTrading}/${ALL_COMBOS.length * CONF_VARIANTS.length}, with ≥${MIN_TRADES} trades: ${r.trainingEligible}`);
  const b = r.best;
  if (!b) { console.log(`${''.padEnd(14)}   no suitable alternative found\n`); return; }
  const line = `${b.combo.join('+').padEnd(26)} conf=${b.conf.toFixed(2)}  holdout: ${fp(b.ret)} Sharpe ${fs(b.sharpe)} [${b.trades}t]`;
  if (r.upgrade) {
    const d = r.upgrade.returnDelta;
    console.log(`${''.padEnd(14)} → UPGRADE: ${line} score=${b.score.toFixed(2)}  (Δret ${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)}%)\n`);
  } else {
    console.log(`${''.padEnd(14)}   best alt: ${line}  (no upgrade)\n`);
  }
}

// ── Summary (parent) ──────────────────────────────────────────────────────────
function summarize(upgrades) {
  console.log('═'.repeat(90));
  if (upgrades.length === 0) {
    console.log('\n  No upgrades recommended — current per-symbol config is already optimal for all tested symbols.\n');
    return;
  }
  console.log(`\n  ${upgrades.length} upgrade(s) recommended:\n`);
  for (const u of upgrades) {
    const deltaStr = `Δret ${u.returnDelta >= 0 ? '+' : ''}${(u.returnDelta * 100).toFixed(1)}%`;
    console.log(`  ${u.symbol}: [${u.oldCombo.join(', ')}] conf=${u.oldConf.toFixed(2)} → [${u.newCombo.join(', ')}] conf=${u.newConf.toFixed(2)}  (${deltaStr})`);
  }
  console.log('');

  if (applyChanges) {
    console.log('  Applying changes to config/default.js…');
    applyConfigChanges(upgrades);
    console.log('  ✓ Config updated. Review and commit the changes.\n');
  } else {
    console.log('  Re-run with --apply to write these changes to config/default.js.\n');
  }
}

// ── Config writer ─────────────────────────────────────────────────────────────
function applyConfigChanges(upgradeList) {
  const configPath   = join(__dirname, '../../config/default.js');
  let   src          = readFileSync(configPath, 'utf8');

  for (const u of upgradeList) {
    const strategiesLine = `strategies: ${JSON.stringify(u.newCombo)}`;
    const confLine       = `minConfidence: ${u.newConf.toFixed(2)}`;

    // Find the perSymbol block for this symbol and update strategies + minConfidence
    // Must match "'SYMBOL/USDC': {" not the symbols array entry
    const symbolKey = `'${u.symbol}': {`;
    const blockStart = src.indexOf(symbolKey);
    if (blockStart === -1) {
      // Symbol has no perSymbol entry — create one using the default block as template
      console.warn(`  ⚠️  ${u.symbol} has no perSymbol entry — cannot apply without manual addition`);
      continue;
    }

    // Find the closing brace of this symbol's block
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) { blockEnd = i; break; }
      }
    }

    const block    = src.slice(blockStart, blockEnd + 1);
    let newBlock   = block
      .replace(/strategies:\s*\[.*?\]/, strategiesLine)
      .replace(/minConfidence:\s*[\d.]+/, confLine);

    src = src.slice(0, blockStart) + newBlock + src.slice(blockEnd + 1);
  }

  writeFileSync(configPath, src, 'utf8');
}

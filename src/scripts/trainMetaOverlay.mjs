#!/usr/bin/env node
/**
 * Train the Phase 5 logistic-regression meta-overlay.
 *
 * For each symbol, replay closed 12h candles with its LIVE per-symbol strategy
 * set + aggregator. At every candle where the aggregate decision is BUY (above
 * the symbol's minConfidence), capture the entry-time feature vector and the
 * eventual outcome (TP-before-SL within the position-aging horizon → win).
 *
 * Strict point-in-time discipline:
 *   - Features use ONLY closed candles up to the signal bar (no lookahead).
 *   - The label uses future prices (that is the supervised target, not a feature).
 *   - Train/test split is time-ordered: the model is trained on older samples and
 *     evaluated on newer ones, never the reverse.
 *
 * Output: data/meta_overlay.json (coefficients + standardisation + metrics).
 * The gate (src/meta/metaOverlay.js) reads this at runtime. Default OFF until it
 * demonstrably beats the baseline.
 *
 * Usage: PAPER_MODE=true node src/scripts/trainMetaOverlay.mjs
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import config from '../../config/default.js';
import { loadCachedCandles } from '../exchange/candleCache.js';
import { buildStrategiesForSymbol, getRiskForSymbol, getSignalConfigForSymbol } from '../utils/strategyBuilder.js';
import { aggregateVotes } from '../engine/aggregatorVoting.js';
import { calculateADX, computeATRPct } from '../utils/indicators.js';
import { classifySeries } from '../engine/regimeClassifier.js';
import { loadFearGreedHistory, getFearGreedValue } from '../data/fearGreed.js';
import { getContextAsOf, refreshMarketContext } from '../data/marketContext.js';
import { trainLogistic, logLoss, accuracy, predictProba } from '../meta/logisticRegression.js';
import { FEATURE_ORDER, buildFeatureVector } from '../meta/metaOverlay.js';

const WARMUP = 50;
const MAX_HOLD_BARS = config.risk?.positionAgingExit?.maxAgeBars ?? 14;
const THRESHOLD = config.metaOverlay?.threshold ?? 0.55;

console.log('\n╔══════════════════════════════════════════════════════════════╗');
console.log('║   META-OVERLAY TRAINER (Phase 5) — logistic P(win)           ║');
console.log('╚══════════════════════════════════════════════════════════════╝\n');

await refreshMarketContext().catch(() => {});
const fgData = await loadFearGreedHistory().catch(() => null);
const btc = await loadCachedCandles('BTC/USDC', '12h');
const regimeByTs = new Map(classifySeries(btc).map((r) => [r.ts, r.regime]));
console.log(`BTC regime map: ${regimeByTs.size} bars   F&G: ${fgData?.length ?? 0} samples\n`);

const samples = []; // { ts, x:number[], y:0|1, symbol }
let symbolsUsed = 0;

for (const symbol of config.symbols) {
  const candles = await loadCachedCandles(symbol, '12h');
  if (!candles || candles.length < WARMUP + MAX_HOLD_BARS + 30) continue;
  const strategies = buildStrategiesForSymbol(symbol);
  const risk = getRiskForSymbol(symbol);
  const minConf = getSignalConfigForSymbol(symbol, config.signals)?.minConfidence ?? 0.5;
  const sl = risk.stopLossPct ?? 0.05;
  const tp = risk.takeProfitPct ?? 0.12;

  // Precompute per-strategy signals (same pattern as the optimizer).
  const sigCache = strategies.map((strat) => {
    const arr = new Array(candles.length);
    for (let i = 0; i < candles.length; i++) {
      if (i < WARMUP) { arr[i] = { signal: 'HOLD', confidence: 0 }; continue; }
      try {
        const r = strat.analyze(candles.slice(0, i + 1));
        arr[i] = { signal: r?.signal ?? 'HOLD', confidence: Number(r?.confidence ?? 0) };
      } catch { arr[i] = { signal: 'HOLD', confidence: 0 }; }
    }
    return arr;
  });

  let symEntries = 0;
  for (let i = WARMUP; i < candles.length - 1; i++) {
    const strategySignals = sigCache.map((c) => c[i]);
    const { winner, confidence } = aggregateVotes({ strategySignals });
    if (winner !== 'BUY' || confidence < minConf) continue;

    const entryPrice = Number(candles[i + 1].open ?? candles[i].close);
    if (!(entryPrice > 0)) continue;

    // Entry-time features (closed bars only).
    const win = candles.slice(Math.max(0, i - 60), i + 1);
    const adxArr = calculateADX(win.map((c) => c.high), win.map((c) => c.low), win.map((c) => c.close), 14);
    const adx = Number(adxArr.at(-1)?.adx ?? 0);
    const atrPct = Number(computeATRPct(win, 14) ?? 0);
    const ctxAsOf = getContextAsOf(candles[i].timestamp);
    const btcd = ctxAsOf?.btcDominance;
    const btcdDelta = (btcd && btcd.value != null && btcd.sma7d != null) ? (btcd.value - btcd.sma7d) : 0;
    const ctx = {
      aggConfidence: confidence,
      buyVoteFrac: strategySignals.filter((s) => s.signal === 'BUY').length / strategySignals.length,
      adx,
      atrPct,
      fearGreed: getFearGreedValue(fgData, candles[i].timestamp) / 100,
      btcdDelta,
      regime: regimeByTs.get(candles[i].timestamp) ?? null,
    };

    // Outcome: TP before SL within the holding horizon (SL checked first = conservative).
    let label = null;
    const end = Math.min(candles.length - 1, i + MAX_HOLD_BARS);
    for (let j = i + 1; j <= end; j++) {
      if (Number(candles[j].low) <= entryPrice * (1 - sl)) { label = 0; break; }
      if (Number(candles[j].high) >= entryPrice * (1 + tp)) { label = 1; break; }
    }
    if (label === null) label = Number(candles[end].close) > entryPrice ? 1 : 0;

    samples.push({ ts: candles[i].timestamp, x: buildFeatureVector(ctx), y: label, symbol });
    symEntries++;
  }
  if (symEntries > 0) { symbolsUsed++; process.stdout.write(`  ${symbol.padEnd(14)} ${symEntries} entries\n`); }
}

console.log(`\nCollected ${samples.length} samples from ${symbolsUsed} symbols.`);
if (samples.length < 50) {
  console.log('⚠️  Too few samples (<50) to train a defensible model. Aborting without writing.');
  process.exit(1);
}

// Time-ordered split (older → train, newer → test). No shuffling = point-in-time honest.
samples.sort((a, b) => a.ts - b.ts);
const cut = Math.floor(samples.length * 0.8);
const train = samples.slice(0, cut);
const test = samples.slice(cut);
const Xtr = train.map((s) => s.x), ytr = train.map((s) => s.y);
const Xte = test.map((s) => s.x),  yte = test.map((s) => s.y);

const model = trainLogistic(Xtr, ytr, { lr: 0.1, epochs: 800, l2: 0.01 });

const baseRate = yte.reduce((a, b) => a + b, 0) / (yte.length || 1);
const testLL = logLoss(model, Xte, yte);
const testAcc = accuracy(model, Xte, yte, 0.5);

// Does the gate add value? Win rate among test samples the gate would ADMIT vs base rate.
let admitted = 0, admittedWins = 0;
for (let i = 0; i < Xte.length; i++) {
  if (predictProba(model, Xte[i]) >= THRESHOLD) { admitted++; admittedWins += yte[i]; }
}
const gatedWinRate = admitted ? admittedWins / admitted : 0;
const gatedFrac = Xte.length ? admitted / Xte.length : 0;

const out = {
  featureOrder: FEATURE_ORDER,
  weights: model.weights,
  bias: model.bias,
  mean: model.mean,
  std: model.std,
  threshold: THRESHOLD,
  trainedAt: new Date().toISOString(),
  nSamples: samples.length,
  metrics: {
    trainN: train.length,
    testN: test.length,
    testBaseWinRate: Number(baseRate.toFixed(4)),
    testLogLoss: Number(testLL.toFixed(4)),
    testAccuracy: Number(testAcc.toFixed(4)),
    gatedWinRate: Number(gatedWinRate.toFixed(4)),
    gatedFraction: Number(gatedFrac.toFixed(4)),
  },
};
if (!existsSync('data')) mkdirSync('data');
writeFileSync('data/meta_overlay.json', JSON.stringify(out, null, 2));

console.log('\n── Results (held-out, newer 20%) ─────────────────────────────');
console.log(`  base win rate     : ${(baseRate * 100).toFixed(1)}%`);
console.log(`  gate-admitted WR  : ${(gatedWinRate * 100).toFixed(1)}%  (admits ${(gatedFrac * 100).toFixed(0)}% of entries)`);
console.log(`  test log loss     : ${testLL.toFixed(4)}   accuracy: ${(testAcc * 100).toFixed(1)}%`);
console.log(`  Δ win rate (gate − base): ${((gatedWinRate - baseRate) * 100).toFixed(1)}pp`);
console.log('\n  Wrote data/meta_overlay.json');
console.log(gatedWinRate > baseRate + 0.02
  ? '  ✅ Gate improves admitted win rate vs base — candidate for enabling (validate on backtest first).'
  : '  ⚠️  Gate does NOT clearly beat base win rate — keep metaOverlay.enabled = false.');
console.log('');

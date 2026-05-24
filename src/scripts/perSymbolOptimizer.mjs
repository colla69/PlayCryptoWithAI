/**
 * Per-symbol strategy optimizer with holdout validation.
 *
 * Methodology matches how the current config was built:
 *   - Training window  = last 365 candles (Y2, more recent)
 *   - Holdout window   = first 365 candles (Y1, unseen/older)
 *   - Optimise on Y2, validate on Y1 — same as all config comments "Y2 +X% Y1 +Y%"
 *
 * Tests all C(14,3) = 364 three-strategy combinations from the full pool:
 *   RSI, BB, CCI, Stoch, EMA, MACD, ADX, Supertrend, MFI, OBV, PSAR, WilliamsR,
 *   StochRSI, HeikinAshi
 *
 * Speed: signals are pre-computed once per strategy (O(N) per strategy),
 * then each combo simulation is just index lookups — ~364 combos × 2 conf
 * × 365 candles ≈ 266k iterations per symbol. Runs in seconds.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs
 *   PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs --symbols BNB/USDT,ICX/USDT
 *   PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs --apply   (writes config.js changes)
 *   PAPER_MODE=true node src/scripts/perSymbolOptimizer.mjs --minImprovement 0.15
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import config from '../../config/default.js';
import { BacktestSimulator } from '../backtester/backtestSimulator.js';
import { calculateMetrics } from '../backtester/metrics.js';
import { loadCachedCandles, saveCachedCandles } from '../exchange/candleCache.js';
import { fetchHistoricalOHLCV } from '../exchange/binanceClient.js';

import {
  RSIStrategy, BollingerBandsStrategy, CCIStrategy, StochasticStrategy,
  EMAStrategy, MACDStrategy, ADXStrategy, SupertrendStrategy,
  MFIStrategy, OBVStrategy, PSARStrategy, WilliamsRStrategy,
  StochRSIStrategy, HeikinAshiStrategy, SupportResistanceStrategy,
} from '../strategies/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let symbolFilter    = null;
let applyChanges    = false;
let minImprovement  = 0.10; // 10% composite score lift on holdout required
let candleCount     = 1460;  // 2 years of 12h = matching original optimization methodology
let timeframe       = config.timeframe ?? '12h';

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--symbols'        && argv[i + 1]) { symbolFilter   = argv[++i].split(',').map((s) => s.trim()); continue; }
  if (argv[i] === '--apply')                          { applyChanges   = true; continue; }
  if (argv[i] === '--minImprovement' && argv[i + 1]) { minImprovement = Number(argv[++i]); continue; }
  if (argv[i] === '--candles'        && argv[i + 1]) { candleCount    = Number(argv[++i]); continue; }
  if (argv[i] === '--timeframe'      && argv[i + 1]) { timeframe      = argv[++i]; continue; }
}

// ── Strategy pool ─────────────────────────────────────────────────────────────
function symCfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}

const POOL_NAMES = ['RSI', 'BB', 'CCI', 'Stoch', 'EMA', 'MACD', 'ADX', 'ST', 'MFI', 'OBV', 'PSAR', 'WR', 'StochRSI', 'HA', 'SR'];

function buildStrategy(name, symbol) {
  switch (name) {
    case 'RSI':   return new RSIStrategy(symCfg(symbol, 'rsi', config.rsi));
    case 'BB':    return new BollingerBandsStrategy(symCfg(symbol, 'bollinger', config.bollinger));
    case 'CCI':   return new CCIStrategy(symCfg(symbol, 'cci', config.cci));
    case 'Stoch': return new StochasticStrategy(symCfg(symbol, 'stochastic', config.stochastic));
    case 'EMA':   return new EMAStrategy(symCfg(symbol, 'ema', config.ema));
    case 'MACD':  return new MACDStrategy(symCfg(symbol, 'macd', config.macd));
    case 'ADX':   return new ADXStrategy(symCfg(symbol, 'adx', config.adx));
    case 'ST':    return new SupertrendStrategy(symCfg(symbol, 'supertrend', config.supertrend));
    case 'MFI':   return new MFIStrategy(symCfg(symbol, 'mfi', config.mfi));
    case 'OBV':   return new OBVStrategy(symCfg(symbol, 'obv', config.obv));
    case 'PSAR':     return new PSARStrategy(symCfg(symbol, 'psar', config.psar));
    case 'WR':       return new WilliamsRStrategy(symCfg(symbol, 'williamsR', config.williamsR));
    case 'StochRSI': return new StochRSIStrategy(symCfg(symbol, 'stochRsi', config.stochRsi ?? {}));
    case 'HA':       return new HeikinAshiStrategy(symCfg(symbol, 'heikinAshi', config.heikinAshi ?? {}));
    case 'SR':       return new SupportResistanceStrategy(symCfg(symbol, 'supportResistance', config.supportResistance ?? {}));
    default: throw new Error(`Unknown strategy: ${name}`);
  }
}

// Map config strategy names to pool names
const CONFIG_TO_POOL = {
  RSI: 'RSI', BB: 'BB', CCI: 'CCI', Stoch: 'Stoch',
  EMA: 'EMA', MACD: 'MACD', ADX: 'ADX', Supertrend: 'ST',
  MFI: 'MFI', OBV: 'OBV', PSAR: 'PSAR', WilliamsR: 'WR',
  StochRSI: 'StochRSI', HeikinAshi: 'HA', SR: 'SR',
};

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

const ALL_COMBOS = combinations(POOL_NAMES, 3); // C(12,3) = 220

// ── Signal pre-computation ────────────────────────────────────────────────────
const WARMUP = 50;

function precomputeSignals(candles, symbol) {
  const cache = {};
  for (const name of POOL_NAMES) {
    const strategy = buildStrategy(name, symbol);
    const signals  = new Array(candles.length).fill('HOLD');
    for (let i = WARMUP; i < candles.length; i++) {
      try {
        signals[i] = strategy.analyze(candles.slice(0, i + 1)).signal;
      } catch {
        signals[i] = 'HOLD';
      }
    }
    cache[name] = signals;
  }
  return cache;
}

// ── Aggregator (vote counting, same logic as SignalAggregator) ────────────────
function aggregate(comboNames, signalCache, idx, minConf) {
  const votes = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const name of comboNames) {
    const sig = signalCache[name]?.[idx] ?? 'HOLD';
    votes[sig] = (votes[sig] ?? 0) + 1;
  }
  const ranked = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  const [winner = 'HOLD', wVotes = 0] = ranked[0] ?? [];
  const tie = ranked.filter(([, c]) => Math.abs(c - wVotes) < 1e-9).length > 1;
  const conf = wVotes / (comboNames.length || 1);
  if (tie || winner === 'HOLD' || conf < minConf) return 'HOLD';
  return winner;
}

// ── Run one simulation on a candle window ─────────────────────────────────────
function runWindow(candles, signalCache, comboNames, minConf, riskConfig) {
  const sim = new BacktestSimulator(riskConfig);
  // globalOffset: the candle array passed here may be a slice; signalCache indices align with globalOffset
  const globalOffset = riskConfig._offset ?? 0;

  for (let i = WARMUP; i < candles.length; i++) {
    const candle   = candles[i];
    const globalI  = i + globalOffset;
    const decision = aggregate(comboNames, signalCache, globalI, minConf);
    sim.setTimestamp(candle.timestamp);
    sim.execute('SYM', decision, Number(candle.close));
  }

  const trades     = sim.getTrades();
  const equity     = sim.getEquityCurve();
  return calculateMetrics(trades, equity, riskConfig.initialBalance);
}

// ── Composite score (same formula as optimizeStrategies.js) ──────────────────
const MIN_TRADES = 1; // 12h strategies fire infrequently — even 1 trade is valid data

function compositeScore(m) {
  if (!m || m.totalTrades < MIN_TRADES) return -1000;
  if (m.maxDrawdown > 0.5) return -500;
  const sharpe  = Number.isFinite(m.sharpeRatio)  ? m.sharpeRatio  : 0;
  const calmar  = m.maxDrawdown > 0 ? m.totalReturn / m.maxDrawdown : 0;
  const pf      = Math.min(Number.isFinite(m.profitFactor) ? m.profitFactor : 0, 5);
  return (
    sharpe                          * 0.30 +
    calmar                          * 0.25 +
    m.winRate                       * 0.20 +
    pf                              * 0.10 +
    Math.min(m.totalReturn, 2)      * 0.15
  );
}

// ── Candle loader ──────────────────────────────────────────────────────────────
async function loadCandles(symbol) {
  const cached = await loadCachedCandles(symbol, timeframe);
  if (cached.length >= candleCount) return cached.slice(-candleCount);
  process.stdout.write(`  Fetching ${symbol}… `);
  const fresh = await fetchHistoricalOHLCV(symbol, timeframe, candleCount);
  if (fresh.length > cached.length) {
    await saveCachedCandles(symbol, timeframe, fresh);
    process.stdout.write('done\n');
    return fresh.slice(-candleCount);
  }
  process.stdout.write(`only ${cached.length} candles\n`);
  return cached.length ? cached : null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fp(v) { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }
function fs(v) { return (Number.isFinite(v) ? v : 0).toFixed(2); }

function getRiskConfig(symbol) {
  const sc = config.perSymbol?.[symbol] ?? {};
  return {
    initialBalance:  1000,
    maxPositionPct:  0.99,  // single-symbol: use full balance
    stopLossPct:     sc.stopLossPct    ?? config.risk?.stopLossPct    ?? 0.05,
    takeProfitPct:   sc.takeProfitPct  ?? config.risk?.takeProfitPct  ?? 0.12,
    trailingStopPct: sc.trailingStopPct ?? 0,
    feePct:          0.001,
    slippagePct:     0.001,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
const watchList = symbolFilter ?? config.symbols;

console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║            PER-SYMBOL STRATEGY OPTIMIZER — 12-indicator pool         ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝');
console.log(`  Pool       : ${POOL_NAMES.join(', ')} (${POOL_NAMES.length} strategies)`);
console.log(`  Combos     : ${ALL_COMBOS.length} × 2 confidence variants = ${ALL_COMBOS.length * 2} per window`);
console.log(`  Timeframe  : ${timeframe}  |  Candles: ${candleCount}`);
console.log(`  Split      : first ${Math.floor(candleCount / 2)} = holdout (Y1), last ${Math.ceil(candleCount / 2)} = training (Y2)`);
console.log(`  Min trades : ${MIN_TRADES} on holdout  |  Min improvement: ${(minImprovement * 100).toFixed(0)}%`);
console.log(applyChanges ? '  Mode       : APPLY (will write config changes)' : '  Mode       : DRY-RUN (use --apply to write changes)');
console.log('');

// Load candles
const symbolCandles = {};
for (const symbol of watchList) {
  const candles = await loadCandles(symbol);
  if (candles && candles.length >= candleCount * 0.8) {
    symbolCandles[symbol] = candles;
  } else if (candles) {
    console.log(`  ⚠️  ${symbol}: only ${candles.length} candles — skipped`);
  } else {
    console.log(`  ⚠️  ${symbol}: no data — skipped`);
  }
}
const loadedSymbols = Object.keys(symbolCandles);
console.log(`\n  ${loadedSymbols.length}/${watchList.length} symbols loaded\n`);

// Collect upgrade recommendations
const upgrades = []; // { symbol, newCombo, newConf }

for (const symbol of loadedSymbols) {
  const candles    = symbolCandles[symbol];
  const half       = Math.floor(candles.length / 2);
  const holdout    = candles.slice(0, half);       // Y1 — unseen
  const training   = candles.slice(half);           // Y2 — training

  const riskCfg  = getRiskConfig(symbol);
  const currentComboConfig = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI', 'BB', 'Stoch'];
  const currentPoolNames   = currentComboConfig.map((n) => CONFIG_TO_POOL[n] ?? n);
  const currentConf        = config.perSymbol?.[symbol]?.minConfidence ?? config.risk?.minConfidence ?? 0.70;

  // Pre-compute signals on FULL candle array (indices align across train/holdout slices via offset)
  const fullCache     = precomputeSignals(candles, symbol);

  // Holdout uses indices 0..(half-1), training uses indices half..(n-1)
  // Wrap caches for each window with the right offset
  const holdoutCache  = fullCache; // indices 0..half-1, no offset needed
  const trainingCache = {};        // indices 0..(training.length-1), offset = half
  for (const name of POOL_NAMES) {
    trainingCache[name] = fullCache[name].slice(half);
  }

  const trainRisk  = { ...riskCfg };
  const holdoutRisk = { ...riskCfg };

  // ── 1. Evaluate current combo on holdout (baseline) ───────────────────────
  const currentHoldoutM = runWindow(holdout, holdoutCache, currentPoolNames, currentConf, holdoutRisk);
  const currentScore    = compositeScore(currentHoldoutM);

  // ── 2. Run all 220 combos × 2 conf on TRAINING window ────────────────────
  const trainingResults = [];
  for (const combo of ALL_COMBOS) {
    for (const conf of [0.55, 0.70]) {
      const m = runWindow(training, trainingCache, combo, conf, trainRisk);
      trainingResults.push({ combo, conf, score: compositeScore(m), m });
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
    const hm    = runWindow(holdout, holdoutCache, candidate.combo, candidate.conf, holdoutRisk);
    const hScore = compositeScore(hm);
    if (hScore > bestHoldoutScore) {
      bestHoldoutScore = hScore;
      bestHoldout = { ...candidate, holdoutM: hm, holdoutScore: hScore };
    }
  }

  // ── 4. Print result ───────────────────────────────────────────────────────
  const currentLabel = currentPoolNames.join('+');
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
    !(bestHoldout.combo.join('+') === currentPoolNames.join('+') && bestHoldout.conf === currentConf)
  );

  // Format current holdout line
  const currTrades = currentHoldoutM?.totalTrades ?? 0;
  const currRet    = currentHoldoutM?.totalReturn ?? 0;
  const currSharpe = currentHoldoutM?.sharpeRatio ?? 0;
  console.log(`${symbol.padEnd(14)} current: ${currentLabel.padEnd(18)} conf=${currentConf.toFixed(2)}  holdout: ${fp(currRet)} Sharpe ${fs(currSharpe)} [${currTrades}t] score=${currentScore.toFixed(2)}`);

  if (shouldUpgrade) {
    const bCombo  = bestHoldout.combo.join('+');
    const bConf   = bestHoldout.conf.toFixed(2);
    const bRet    = bestHoldout.holdoutM.totalReturn;
    const bSharpe = bestHoldout.holdoutM.sharpeRatio;
    const bTrades = bestHoldout.holdoutM.totalTrades;
    const deltaStr = `Δret ${returnDelta >= 0 ? '+' : ''}${(returnDelta * 100).toFixed(1)}%`;
    console.log(`${''.padEnd(14)} → UPGRADE: ${bCombo.padEnd(18)} conf=${bConf}  holdout: ${fp(bRet)} Sharpe ${fs(bSharpe)} [${bTrades}t] score=${bestHoldoutScore.toFixed(2)}  (${deltaStr})\n`);
    upgrades.push({ symbol, newCombo: bestHoldout.combo, newConf: bestHoldout.conf, oldCombo: currentPoolNames, oldConf: currentConf, returnDelta });
  } else if (bestHoldout) {
    const bCombo  = bestHoldout.combo.join('+');
    const bConf   = bestHoldout.conf.toFixed(2);
    const bRet    = bestHoldout.holdoutM.totalReturn;
    const bSharpe = bestHoldout.holdoutM.sharpeRatio;
    const bTrades = bestHoldout.holdoutM.totalTrades;
    console.log(`${''.padEnd(14)}   best alt: ${bCombo.padEnd(18)} conf=${bConf}  holdout: ${fp(bRet)} Sharpe ${fs(bSharpe)} [${bTrades}t]  (no upgrade)\n`);
  } else {
    console.log(`${''.padEnd(14)}   no suitable alternative found\n`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('═'.repeat(90));
if (upgrades.length === 0) {
  console.log('\n  No upgrades recommended — current per-symbol config is already optimal for all tested symbols.\n');
} else {
  console.log(`\n  ${upgrades.length} upgrade(s) recommended:\n`);
  for (const u of upgrades) {
    const poolToConfig = Object.fromEntries(Object.entries(CONFIG_TO_POOL).map(([k, v]) => [v, k]));
    const newConfigNames = u.newCombo.map((n) => poolToConfig[n] ?? n);
    const deltaStr = `Δret ${u.returnDelta >= 0 ? '+' : ''}${(u.returnDelta * 100).toFixed(1)}%`;
    console.log(`  ${u.symbol}: [${u.oldCombo.join(', ')}] conf=${u.oldConf.toFixed(2)} → [${newConfigNames.join(', ')}] conf=${u.newConf.toFixed(2)}  (${deltaStr})`);
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
  const poolToConfig = Object.fromEntries(Object.entries(CONFIG_TO_POOL).map(([k, v]) => [v, k]));
  const configPath   = join(__dirname, '../../config/default.js');
  let   src          = readFileSync(configPath, 'utf8');

  for (const u of upgradeList) {
    const newConfigNames = u.newCombo.map((n) => poolToConfig[n] ?? n);
    const strategiesLine = `strategies: ${JSON.stringify(newConfigNames)}`;
    const confLine       = `minConfidence: ${u.newConf.toFixed(2)}`;

    // Find the perSymbol block for this symbol and update strategies + minConfidence
    // Must match "'SYMBOL/USDT': {" not the symbols array entry
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

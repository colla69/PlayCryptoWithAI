/**
 * Live reconciliation, layer 1 — does the backtester decide what live decided?
 *
 * Replays the candles the live bot ran on through PortfolioBacktester's decision
 * rows and compares them, cycle by cycle, with the live signal log
 * (`signal_history.json`). Same strategies, same thresholds, same aggregator class:
 * every difference this prints is a place where backtest ≠ live, so each one gets a
 * cause or becomes a parity gap (docs/plans/2026-10-single-engine-rebuild.md, step 1).
 *
 * Nothing here writes to bot state. The snapshot is a copy of the live PC's data/ and
 * logs/ (see the plan); `data/candles` must hold the frozen candles extended to the
 * snapshot's cut, because the signals depend on indicator history.
 *
 * Usage:
 *   PAPER_MODE=true node src/scripts/runReconciliation.mjs --snapshot <dir> [--out <file>] [--show <n>]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import config from '../../config/default.js';
import { PortfolioBacktester } from '../backtester/index.js';
import {
  loadAllSymbols, loadMtfCandles, FULL_LIVE_FILTERS, SLIPPAGE_TIERS, buildPerSymbolOverrides,
} from '../backtester/baselineFramework.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';
import { buildStrategiesForSymbol, getSignalConfigForSymbol } from '../utils/strategyBuilder.js';
import { buildMtfIndex, mtfAlignScore, buildMtf4hIndex, mtf4hMomentumScore } from '../utils/mtfAlignment.js';
import { trailingReturn } from '../utils/momentum.js';
import { withFormingBar } from '../utils/formingBar.js';
import { readdirSync } from 'fs';

const CYCLE_MS = 12 * 60 * 60 * 1000;
// Live rounds the logged confidence to 4 decimals.
const CONF_TOLERANCE = 0.00051;

function parseArgs(argv) {
  const args = { snapshot: null, out: 'data/reconciliation_signals.json', show: 12 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--snapshot' && argv[i + 1]) args.snapshot = argv[++i];
    else if (argv[i] === '--out' && argv[i + 1]) args.out = argv[++i];
    else if (argv[i] === '--show' && argv[i + 1]) args.show = Number(argv[++i]);
  }
  if (!args.snapshot) {
    console.error('usage: runReconciliation.mjs --snapshot <dir> [--out <file>] [--show <n>]');
    process.exit(1);
  }
  return args;
}

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const iso = (ts) => new Date(ts).toISOString().slice(0, 16) + 'Z';

/** Intervals each scalper symbol was held, from the live trade log + open positions. */
function buildHeldIntervals(snapshot) {
  const held = {};
  const add = (symbol, from, to) => {
    if (!symbol || symbol.endsWith('#core')) return; // the TSM sleeve is a separate ledger
    (held[symbol] ??= []).push([from, to]);
  };
  const persist = readJson(path.join(snapshot, 'data/dashboard_persist.json'));
  for (const t of persist.trades ?? []) {
    if (t.side === 'SELL' && t.openedAt) add(t.symbol, Date.parse(t.openedAt), Date.parse(t.timestamp));
  }
  const open = readJson(path.join(snapshot, 'data/position_state.json'));
  for (const [symbol, p] of Object.entries(open)) {
    if (p.openedAt) add(symbol, Date.parse(p.openedAt), Infinity);
  }
  return held;
}

const wasHeld = (held, symbol, ts) => (held[symbol] ?? []).some(([from, to]) => from <= ts && ts < to);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const live = readJson(path.join(args.snapshot, 'data/signal_history.json'));
  const held = buildHeldIntervals(args.snapshot);

  const symbolCandles = await loadAllSymbols(config.symbols, config.timeframe);
  const symbols = Object.keys(symbolCandles);
  const lastBarTs = Math.max(...symbols.map((s) => Number(symbolCandles[s].at(-1).timestamp)));

  // Thresholds exactly as live resolves them — then proven equal on the backtester side.
  const liveMinConf = Object.fromEntries(
    symbols.map((s) => [s, getSignalConfigForSymbol(s, config.signals).minConfidence]),
  );
  const symbolMinConfidence = {};
  for (const s of symbols) {
    const raw = config.perSymbol?.[s]?.minConfidence;
    if (raw != null) symbolMinConfidence[s] = raw;
  }
  const backtester = new PortfolioBacktester(
    Object.fromEntries(symbols.map((s) => [s, buildStrategiesForSymbol(s)])),
    {
      risk: { ...(config.risk ?? {}) },
      signals: {
        ...(config.signals ?? {}),
        minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence,
      },
      symbolMinConfidence,
      confidenceThresholdScale: config.risk?.confidenceThresholdScale,
    },
  );
  const rowsBySymbol = backtester.computeSignalRows(symbolCandles);
  // Read after the replay: aggregate() re-applies its per-call config, so this is the
  // threshold the votes were actually gated on.
  const thresholdDrift = symbols.filter((s) => {
    const bt = backtester.aggregators[s].minimumConfidence;
    return Math.abs(bt - liveMinConf[s]) > 1e-12;
  });
  const rowAt = Object.fromEntries(symbols.map((s) => [s, new Map(rowsBySymbol[s].map((r) => [r.timestamp, r]))]));

  // One live record per (cycle, symbol): the earliest in the 12h bucket is the cycle
  // on the candle close; later ones are start-up or retry passes on the same bars.
  const sorted = [...live].sort((a, b) => a.timestamp - b.timestamp);
  const cycles = new Map(); // bucketTs -> Map(symbol -> record)
  let duplicates = 0;
  let maxLateMs = 0;
  for (const rec of sorted) {
    const bucket = Math.floor(rec.timestamp / CYCLE_MS) * CYCLE_MS;
    const bySym = cycles.get(bucket) ?? new Map();
    if (bySym.has(rec.symbol)) { duplicates++; continue; }
    bySym.set(rec.symbol, rec);
    cycles.set(bucket, bySym);
    maxLateMs = Math.max(maxLateMs, rec.timestamp - bucket);
  }
  const cycleTimes = [...cycles.keys()].sort((a, b) => a - b);

  const tally = {
    compared: 0, match: 0, staleBar: 0, asymmetricExit: 0, confidenceOnly: 0, decisionDiffers: 0,
    noRow: 0, beyondData: 0, backtestOnly: 0,
  };
  const mismatches = [];
  for (const bucket of cycleTimes) {
    const bySym = cycles.get(bucket);
    for (const [symbol, rec] of bySym) {
      if (!rowAt[symbol]) { tally.noRow++; continue; }
      if (bucket > lastBarTs) { tally.beyondData++; continue; }
      const row = rowAt[symbol].get(bucket);
      if (!row) { tally.noRow++; mismatches.push({ kind: 'no_row', symbol, cycle: iso(bucket) }); continue; }
      tally.compared++;
      const dConf = row.confidence - rec.confidence;
      const sameDecision = row.decision === rec.decision;
      if (sameDecision && Math.abs(dConf) <= CONF_TOLERANCE) { tally.match++; continue; }

      // Row k decides on bars through k-1 (the strategies drop the last bar). When the
      // exchange has not yet printed the new bar at cycle time — a thin pair, 3-5s after
      // the close — live's series ends one bar early, the strategies drop the bar that
      // just closed, and live decides on what the backtester's PREVIOUS row saw.
      const prev = rowAt[symbol].get(bucket - CYCLE_MS);
      const matchesPrev = prev && prev.decision === rec.decision
        && Math.abs(prev.confidence - rec.confidence) <= CONF_TOLERANCE;
      // Live lowers the exit bar to 0.7× when a position is open and SELL votes are a
      // majority (main.js, "Easier SELL for open positions"); the backtester has no
      // position-aware vote. A live SELL over a backtest HOLD, while held, at a
      // confidence that clears that lowered bar, is that rule and nothing else.
      const exitBar = liveMinConf[symbol] * 0.7;
      const kind = matchesPrev ? 'stale_bar'
        : (rec.decision === 'SELL' && row.decision === 'HOLD'
          && wasHeld(held, symbol, bucket) && row.confidence >= exitBar - CONF_TOLERANCE)
          ? 'asymmetric_exit'
          : sameDecision ? 'confidence_only' : 'decision_differs';
      if (kind === 'stale_bar') tally.staleBar++;
      else if (kind === 'asymmetric_exit') tally.asymmetricExit++;
      else if (kind === 'confidence_only') tally.confidenceOnly++;
      else tally.decisionDiffers++;
      mismatches.push({
        kind, symbol, cycle: iso(bucket), live: rec.decision, backtest: row.decision,
        liveConf: rec.confidence, backtestConf: Number(row.confidence.toFixed(4)),
        delta: Number(dConf.toFixed(4)), held: wasHeld(held, symbol, bucket),
        liveBlock: rec.blockReason ?? null,
      });
    }
    // Backtest rows for symbols live logged nothing for this cycle (stale-guard skip).
    for (const s of symbols) {
      if (!bySym.has(s) && rowAt[s].has(bucket)) tally.backtestOnly++;
    }
  }

  const skippedBySymbol = {};
  const skippedByCycle = {};
  for (const bucket of cycleTimes) {
    for (const s of symbols) {
      if (!cycles.get(bucket).has(s) && rowAt[s].has(bucket)) {
        skippedBySymbol[s] = (skippedBySymbol[s] ?? 0) + 1;
        (skippedByCycle[iso(bucket)] ??= []).push(s);
      }
    }
  }

  console.log('\nLive reconciliation — layer 1 (per-cycle decision + confidence)');
  console.log(`  live log      : ${live.length} records, ${cycleTimes.length} cycles `
    + `${iso(cycleTimes[0])} → ${iso(cycleTimes.at(-1))}  (${duplicates} extra start-up/retry records ignored)`);
  console.log(`  cycle timing  : latest record ${(maxLateMs / 1000).toFixed(0)}s after its candle close`);
  console.log(`  backtest data : ${symbols.length} symbols, last 12h bar ${iso(lastBarTs)}`);
  console.log(`  thresholds    : ${thresholdDrift.length === 0 ? 'backtest ≡ live for every symbol' : `DRIFT on ${thresholdDrift.join(', ')}`}`);
  console.log(`\n  compared      : ${tally.compared}`);
  console.log(`  match         : ${tally.match}  (${(100 * tally.match / Math.max(1, tally.compared)).toFixed(2)}%)`);
  console.log(`  live series ended a bar early (= previous backtest row): ${tally.staleBar}`);
  console.log(`  asymmetric exit (live-only 0.7× SELL rule): ${tally.asymmetricExit}`);
  console.log(`  confidence only differs: ${tally.confidenceOnly}`);
  console.log(`  decision differs       : ${tally.decisionDiffers}`);
  console.log(`  live record, no backtest row: ${tally.noRow}   (beyond the frozen data: ${tally.beyondData})`);
  console.log(`  backtest row, no live record: ${tally.backtestOnly}  by cycle (symbols in the JSON)`);

  const worst = mismatches.filter((m) => m.kind === 'confidence_only' || m.kind === 'decision_differs')
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, args.show);
  if (worst.length) {
    console.log(`\n  largest unexplained differences:`);
    for (const m of worst) {
      console.log(`    ${m.cycle} ${m.symbol.padEnd(10)} live ${m.live}@${m.liveConf}  backtest ${m.backtest}@${m.backtestConf}  Δ${m.delta}${m.held ? '  [held]' : ''}`);
    }
  }

  const filters = reconcileEntryFilters({ snapshot: args.snapshot, live, symbolCandles, rowAt, show: args.show });
  const trades = await reconcileTrades({
    snapshot: args.snapshot, symbolCandles, firstCycle: cycleTimes[0], symbolMinConfidence,
  });

  writeFileSync(args.out, JSON.stringify({
    tally, thresholdDrift, skippedBySymbol, skippedByCycle, mismatches, filters, trades,
  }, null, 1));
  console.log(`\n  written: ${args.out}`);
}

/** Live scalper round trips from logs/trades.csv (the TSM sleeve is a separate ledger). */
function readLiveRoundTrips(snapshot, fromTs) {
  const lines = readFileSync(path.join(snapshot, 'logs/trades.csv'), 'utf8').trim().split('\n').slice(1);
  const open = new Map();
  const trips = [];
  for (const line of lines) {
    const [ts, symbol, side, price, qty, pnl, balance] = line.split(',');
    const t = Date.parse(ts);
    if (symbol.endsWith('#core') || t < fromTs) continue;
    if (side === 'BUY') {
      open.set(symbol, { symbol, entryTs: t, entryPrice: Number(price), cost: Number(price) * Number(qty), balanceAfter: Number(balance) });
    } else if (open.has(symbol)) {
      trips.push({ ...open.get(symbol), exitTs: t, exitPrice: Number(price), pnl: Number(pnl) });
      open.delete(symbol);
    }
  }
  for (const o of open.values()) trips.push({ ...o, exitTs: null });
  return trips;
}

/** Exit reasons live logged with each `[LIVE] SELL` (the persisted trades mostly lack them). */
function readLiveExitReasons(snapshot) {
  const reasons = [];
  const dir = path.join(snapshot, 'logs');
  for (const f of readdirSync(dir).filter((x) => /^app-.*\.log$/.test(x))) {
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('[LIVE] SELL')) continue;
      try {
        const j = JSON.parse(line);
        const m = j.message.match(/\[LIVE\] SELL (\S+) .*reason=(\S+)/);
        if (m) reasons.push({ symbol: m[1], ts: Date.parse(j.timestamp), reason: m[2] });
      } catch { /* skip a torn line */ }
    }
  }
  return reasons;
}

/**
 * Layer 3 — the trades. Runs the real PortfolioBacktester with live's filter stack
 * and sizing over the live period: the full history warms the indicators, trading
 * starts at the first logged cycle, from live's free balance then, with the later
 * deposits added on their dates. Each live round trip is matched to the backtest
 * trade on the same symbol whose entry is nearest.
 */
async function reconcileTrades({ snapshot, symbolCandles, firstCycle, symbolMinConfidence }) {
  const symbols = Object.keys(symbolCandles);
  const liveTrips = readLiveRoundTrips(snapshot, firstCycle);
  const reasons = readLiveExitReasons(snapshot);
  for (const t of liveTrips) {
    if (t.exitTs != null) t.reason = reasons.find((r) => r.symbol === t.symbol && Math.abs(r.ts - t.exitTs) < 5000)?.reason ?? null;
  }
  // Live's free balance just before its first entry in the window.
  const first = liveTrips[0];
  const startBalance = first ? Number((first.balanceAfter + first.cost).toFixed(2)) : Number(config.risk?.initialBalance ?? 0);
  const deposits = readJson(path.join(snapshot, 'data/deposits.json'))
    .map((d) => ({ ts: Date.parse(d.timestamp), amount: Number(d.amount) }));

  const { symbolRisk } = buildPerSymbolOverrides(symbols);
  const backtester = new PortfolioBacktester(
    Object.fromEntries(symbols.map((s) => [s, buildStrategiesForSymbol(s)])),
    {
      risk: {
        ...(config.risk ?? {}),
        initialBalance: startBalance,
        basePctOverride: config.risk?.maxPositionPct,
        feePct: 0.001,
        slippagePct: 0.001,
        breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
      },
      signals: { ...(config.signals ?? {}), minConfidence: config.signals?.minConfidence ?? config.risk?.minConfidence },
      maxOpenPositions: config.risk?.maxOpenPositions ?? 4,
      symbolSlippage: SLIPPAGE_TIERS,
      symbolRisk,
      symbolMinConfidence,
      mtfSymbolCandles: loadMtfCandles(symbols, '15m'),
      mtf4hSymbolCandles: loadMtfCandles(symbols, '4h'),
      fearGreedData: await loadFearGreedHistory(),
      confidenceThresholdScale: config.risk?.confidenceThresholdScale,
      ...FULL_LIVE_FILTERS,
      tradeFromTs: firstCycle,
      deposits,
    },
  );
  const result = backtester.run(symbolCandles);
  const btTrades = result.trades;

  const used = new Set();
  const rows = liveTrips.map((lt) => {
    const candidates = btTrades.map((t, k) => ({ t, k }))
      .filter(({ t, k }) => t.symbol === lt.symbol && !used.has(k) && Math.abs(t.entryTime - lt.entryTs) <= 3 * CYCLE_MS);
    candidates.sort((a, b) => Math.abs(a.t.entryTime - lt.entryTs) - Math.abs(b.t.entryTime - lt.entryTs));
    const match = candidates[0];
    if (match) used.add(match.k);
    return { live: lt, backtest: match?.t ?? null };
  });
  const extra = btTrades.filter((_, k) => !used.has(k));

  const hrs = (ms) => (ms == null ? '—' : `${(ms / 3_600_000).toFixed(1)}h`);
  const pct = (a, b) => (a && b ? `${(((b - a) / a) * 100).toFixed(2)}%` : '—');
  console.log('\nLive reconciliation — layer 3 (scalper trades)');
  console.log(`  replay        : from ${iso(firstCycle)}, start balance $${startBalance}, `
    + `${deposits.filter((d) => d.ts >= firstCycle).length} later deposit(s), maxPositionPct ${config.risk?.maxPositionPct}`);
  console.log(`  live trips    : ${liveTrips.length}   backtest trades in the period: ${btTrades.length}   matched: ${rows.filter((r) => r.backtest).length}`);
  for (const { live: l, backtest: b } of rows) {
    const head = `    ${l.symbol.padEnd(10)} live in ${iso(l.entryTs)} @${l.entryPrice}  out ${l.exitTs ? iso(l.exitTs) : 'open'} @${l.exitPrice ?? '—'} ${l.reason ?? ''}`;
    if (!b) { console.log(`${head}\n      backtest: NO MATCHING TRADE`); continue; }
    console.log(`${head}\n      backtest in ${iso(b.entryTime)} fill @${b.entryFillPrice} (${pct(l.entryPrice, b.entryFillPrice)} vs live)`
      + `  out ${iso(b.exitTime)} @${b.exitPrice} ${b.reason}  entry ${hrs(b.entryTime - l.entryTs)} vs live, exit ${hrs(l.exitTs ? b.exitTime - l.exitTs : null)}`
      + `  size ${(b.positionPct ?? 0).toFixed(4)}`);
  }
  for (const b of extra) {
    console.log(`    backtest only: ${b.symbol} in ${iso(b.entryTime)} out ${iso(b.exitTime)} ${b.reason} pnl ${b.pnl}`);
  }
  console.log(`  filters applied in the replay: ${JSON.stringify(result.filtersApplied)}`);
  return { startBalance, rows, extra };
}

/** Times the live bot finished refreshing its 15m / 4h caches, from the app logs. */
function readCacheRefreshTimes(snapshot) {
  const times = { '15m': [], '4h': [] };
  const dir = path.join(snapshot, 'logs');
  for (const f of readdirSync(dir).filter((x) => /^app-.*\.log$/.test(x)).sort()) {
    for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('[MTF-CACHE]')) continue;
      const m = line.match(/\[MTF-CACHE\] (15m|4h) refresh complete/);
      if (!m) continue;
      try { times[m[1]].push(Date.parse(JSON.parse(line).timestamp)); } catch { /* skip a torn line */ }
    }
  }
  times['15m'].sort((a, b) => a - b);
  times['4h'].sort((a, b) => a - b);
  return times;
}

const lastAtOrBefore = (sorted, ts) => {
  let lo = 0; let hi = sorted.length - 1; let ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (sorted[mid] <= ts) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
};
const lastBarIndex = (bars, pred) => {
  let ans = -1;
  for (let k = 0; k < bars.length; k++) { if (pred(Number(bars[k].timestamp))) ans = k; else break; }
  return ans;
};

/**
 * Layer 2 — the entry filters on every live BUY. Live logs the value that blocked
 * a BUY in `blockReason`. For each BUY this computes the 15m MTF score, the 4h
 * momentum score and the 12h trailing return three ways: as the backtester codes
 * them, from the bars closed by the cycle time, and from live's own cache rebuilt
 * from the logged refresh times. BTC.D and correlation are reported, not modelled.
 */
function reconcileEntryFilters({ snapshot, live, symbolCandles, rowAt, show }) {
  const M15 = 15 * 60 * 1000;
  const M4H = 4 * 60 * 60 * 1000;
  const mtfCfg = config.mtfFilter ?? {};
  const cfg4h = config.mtf4hFilter ?? {};
  const momCfg = config.momentumFilter ?? {};
  const symbols = Object.keys(symbolCandles);
  const c15 = loadMtfCandles(symbols, '15m');
  const c4h = loadMtfCandles(symbols, '4h');
  const refresh = readCacheRefreshTimes(snapshot);
  const idx15 = {}; const idx4 = {};
  for (const s of symbols) {
    if (c15[s]?.length) idx15[s] = buildMtfIndex(symbolCandles[s], c15[s]);
    if (c4h[s]?.length) idx4[s] = buildMtf4hIndex(symbolCandles[s], c4h[s]);
  }

  const parseLive = (reason) => {
    if (!reason) return { outcome: 'pass' };
    let m = reason.match(/MTF misaligned \(15m: (\d+)% green/);
    if (m) return { outcome: 'mtf', value: Number(m[1]) };
    m = reason.match(/4h momentum bearish \(score=(\d+)%/);
    if (m) return { outcome: 'mtf4h', value: Number(m[1]) };
    m = reason.match(/Momentum laggard \(\d+-bar return (-?[\d.]+)%/);
    if (m) return { outcome: 'momentum', value: Number(m[1]) };
    if (/BTC\.D/.test(reason)) return { outcome: 'btcDominance' };
    return { outcome: 'other', reason };
  };
  // Live's order: (weekly DD, BTC.D, regime, correlation) → MTF 15m → 4h → momentum.
  const firstBlock = (v) => {
    if (mtfCfg.enabled && v.mtf != null && v.mtf < (mtfCfg.minAlignScore ?? 0.5)) return 'mtf';
    if (cfg4h.enabled && v.mtf4h != null && v.mtf4h < (cfg4h.minScore ?? 0.45)) return 'mtf4h';
    if (momCfg.enabled && v.mom != null && v.mom < Number(momCfg.minPct ?? 0)) return 'momentum';
    return 'pass';
  };
  const shown = (v, kind) => (v == null ? null
    : kind === 'momentum' ? Number((v * 100).toFixed(1)) : Number((v * 100).toFixed(0)));

  const sorted = [...live].sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set();
  const results = [];
  for (const rec of sorted) {
    if (rec.decision !== 'BUY') continue;
    const T = Math.floor(rec.timestamp / CYCLE_MS) * CYCLE_MS;
    const key = `${T}|${rec.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = rec.symbol;
    const c12 = symbolCandles[s];
    if (!c12 || !rowAt[s]?.get(T)) continue;
    const i12 = c12.findIndex((c) => Number(c.timestamp) === T);
    const lb = Number(cfg4h.lookback ?? 21);
    const bars15 = Number(mtfCfg.alignBars ?? 16);

    // 1. As the backtester codes it: the last 15m / 4h bar inside [T, T + 12h).
    const coded = {
      mtf: idx15[s] ? mtfAlignScore(c15[s], idx15[s][i12], bars15) : null,
      mtf4h: idx4[s] ? mtf4hMomentumScore(c4h[s], idx4[s][i12], lb) : null,
      mom: rowAt[s].get(T).mom,
    };
    // 2. From bars closed by the cycle time; momentum on live's decision series.
    const closedBy = (bars, ms) => lastBarIndex(bars, (ts) => ts + ms <= T);
    const asOfT = {
      mtf: c15[s] ? mtfAlignScore(c15[s], closedBy(c15[s], M15), bars15) : null,
      mtf4h: c4h[s] ? mtf4hMomentumScore(c4h[s], closedBy(c4h[s], M4H), lb) : null,
      mom: trailingReturn(withFormingBar(c12.slice(0, i12), config.timeframe, T + 4000), Number(momCfg.lookback ?? 20)),
    };
    // 3. Live's cache: the bars that existed at the last refresh before this record.
    //    The newest of them was still forming then; only its closed version is on disk.
    const r15 = lastAtOrBefore(refresh['15m'], rec.timestamp);
    const r4 = lastAtOrBefore(refresh['4h'], rec.timestamp);
    const cache = (r15 < 0 || r4 < 0) ? null : {
      at15: refresh['15m'][r15], at4h: refresh['4h'][r4],
      mtf: c15[s] ? mtfAlignScore(c15[s], lastBarIndex(c15[s], (ts) => ts <= refresh['15m'][r15]), bars15) : null,
      mtf4h: c4h[s] ? mtf4hMomentumScore(c4h[s], lastBarIndex(c4h[s], (ts) => ts <= refresh['4h'][r4]), lb) : null,
      mom: asOfT.mom,
    };
    // A refresh older than one interval means the logs do not cover this record.
    const cacheValid = cache && rec.timestamp - cache.at15 <= M15 + 60_000 && rec.timestamp - cache.at4h <= M4H + 60_000;

    const lv = parseLive(rec.blockReason);
    const entry = {
      symbol: s, cycle: iso(T), live: lv,
      coded: { outcome: firstBlock(coded), mtf: shown(coded.mtf), mtf4h: shown(coded.mtf4h), mom: shown(coded.mom, 'momentum') },
      asOfT: { outcome: firstBlock(asOfT), mtf: shown(asOfT.mtf), mtf4h: shown(asOfT.mtf4h), mom: shown(asOfT.mom, 'momentum') },
      cache: cacheValid
        ? { outcome: firstBlock(cache), mtf: shown(cache.mtf), mtf4h: shown(cache.mtf4h), mom: shown(cache.mom, 'momentum'),
          age15s: Math.round((rec.timestamp - cache.at15) / 1000), age4hMin: Math.round((rec.timestamp - cache.at4h) / 60000) }
        : null,
    };
    results.push(entry);
  }

  const modelled = results.filter((r) => ['pass', 'mtf', 'mtf4h', 'momentum'].includes(r.live.outcome));
  // Same reason, or at least the same pass/block (live's filter order reports the first block).
  const agree = (key) => {
    const same = modelled.filter((r) => r[key] && r[key].outcome === r.live.outcome).length;
    const passBlock = modelled.filter((r) => r[key] && (r[key].outcome === 'pass') === (r.live.outcome === 'pass')).length;
    return `${same}/${modelled.length} (pass/block ${passBlock}/${modelled.length})`;
  };
  const valueAgree = (key) => {
    const withValue = modelled.filter((r) => r.live.value != null && r[key]);
    const same = withValue.filter((r) => r[key][r.live.outcome] === r.live.value).length;
    return `${same}/${withValue.length}`;
  };
  const withCache = modelled.filter((r) => r.cache);
  console.log('\nLive reconciliation — layer 2 (entry filters on each live BUY)');
  console.log(`  live BUYs     : ${results.length} (${modelled.length} blocked by MTF/4h/momentum or passed; `
    + `${results.length - modelled.length} other, e.g. BTC.D — not modelled)`);
  console.log(`  same outcome as live — backtester as coded : ${agree('coded')}   same logged value: ${valueAgree('coded')}`);
  console.log(`  same outcome as live — bars closed by T    : ${agree('asOfT')}   same logged value: ${valueAgree('asOfT')}`);
  console.log(`  same outcome as live — live cache rebuilt  : ${withCache.filter((r) => r.cache.outcome === r.live.outcome).length}/${withCache.length} (pass/block ${withCache.filter((r) => (r.cache.outcome === 'pass') === (r.live.outcome === 'pass')).length}/${withCache.length}) `
    + `(records inside the logs)   same logged value: ${valueAgree('cache')}`);
  const rows = results.slice(-show);
  console.log(`\n  last ${rows.length} BUYs  (values in %: 15m MTF / 4h / 12h momentum)`);
  for (const r of rows) {
    const f = (o) => (o ? `${o.outcome.padEnd(8)} ${o.mtf}/${o.mtf4h}/${o.mom}` : '—');
    console.log(`    ${r.cycle} ${r.symbol.padEnd(10)} live ${(r.live.outcome + (r.live.value != null ? '=' + r.live.value : '')).padEnd(13)}`
      + ` coded ${f(r.coded).padEnd(26)} asOfT ${f(r.asOfT).padEnd(26)} cache ${f(r.cache)}`);
  }
  return results;
}

main().catch((err) => { console.error(err); process.exit(1); });

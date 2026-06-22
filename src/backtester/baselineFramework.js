/**
 * Baseline framework — reusable utilities for running the bot's current strategy
 * across multiple windows and producing honest, statistically-corrected metrics.
 *
 * Every overhaul phase (1..9) reports its delta vs the baseline this framework
 * produces. Outputs are JSON-serialisable so they can be diffed in CI.
 *
 * Window definitions are *data-aware* — we never pretend to evaluate a window
 * for a symbol that doesn't have candles covering it.
 */

import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import config from '../../config/default.js';
import { loadCachedCandles } from '../exchange/candleCache.js';
import { PortfolioBacktester } from './index.js';
import {
  RSIStrategy, BollingerBandsStrategy, CCIStrategy, StochasticStrategy,
  EMAStrategy, MACDStrategy, ADXStrategy, SupertrendStrategy,
  MFIStrategy, OBVStrategy, PSARStrategy, WilliamsRStrategy,
  StochRSIStrategy, HeikinAshiStrategy, SupportResistanceStrategy,
} from '../strategies/index.js';
import { deflatedSharpeRatio } from './deflatedSharpe.js';

const STRATEGY_BUILDERS = {
  RSI:        (s) => new RSIStrategy(symCfg(s, 'rsi', config.rsi)),
  EMA:        (s) => new EMAStrategy(symCfg(s, 'ema', config.ema)),
  MACD:       (s) => new MACDStrategy(symCfg(s, 'macd', config.macd)),
  BB:         (s) => new BollingerBandsStrategy(symCfg(s, 'bollinger', config.bollinger)),
  Stoch:      (s) => new StochasticStrategy(symCfg(s, 'stochastic', config.stochastic)),
  ADX:        (s) => new ADXStrategy(symCfg(s, 'adx', config.adx)),
  CCI:        (s) => new CCIStrategy(symCfg(s, 'cci', config.cci)),
  Supertrend: (s) => new SupertrendStrategy(symCfg(s, 'supertrend', config.supertrend)),
  MFI:        (s) => new MFIStrategy(symCfg(s, 'mfi', config.mfi)),
  OBV:        (s) => new OBVStrategy(symCfg(s, 'obv', config.obv)),
  PSAR:       (s) => new PSARStrategy(symCfg(s, 'psar', config.psar)),
  WilliamsR:  (s) => new WilliamsRStrategy(symCfg(s, 'williamsR', config.williamsR)),
  StochRSI:   (s) => new StochRSIStrategy(symCfg(s, 'stochRsi', config.stochRsi ?? {})),
  HeikinAshi: (s) => new HeikinAshiStrategy(symCfg(s, 'heikinAshi', config.heikinAshi ?? {})),
  SR:         (s) => new SupportResistanceStrategy(symCfg(s, 'supportResistance', config.supportResistance ?? {})),
};

function symCfg(symbol, key, defaults) {
  return { ...defaults, ...(config.perSymbol?.[symbol]?.[key] ?? {}) };
}

function buildStrategies(symbol) {
  const names = config.perSymbol?.[symbol]?.strategies ?? config.strategies ?? ['RSI'];
  return names
    .map((n) => {
      const b = STRATEGY_BUILDERS[n];
      if (!b) throw new Error(`Unknown strategy '${n}' for ${symbol}`);
      return b(symbol);
    });
}

// ── Slippage tiers (kept in sync with src/scripts/portfolioBacktest.mjs) ──────
const LARGE_CAP_SLIP = 0.0010;
const MID_CAP_SLIP   = 0.0020;
const MICRO_CAP_SLIP = 0.0035;

export const SLIPPAGE_TIERS = {
  'BTC/USDC': LARGE_CAP_SLIP, 'ETH/USDC': LARGE_CAP_SLIP, 'BNB/USDC': LARGE_CAP_SLIP,
  'SOL/USDC': LARGE_CAP_SLIP, 'XRP/USDC': LARGE_CAP_SLIP, 'DOGE/USDC': LARGE_CAP_SLIP,
  'ADA/USDC': LARGE_CAP_SLIP, 'AVAX/USDC': LARGE_CAP_SLIP,
  'LTC/USDC': MID_CAP_SLIP,   'LINK/USDC': MID_CAP_SLIP,  'BCH/USDC': MID_CAP_SLIP,
  'TRX/USDC': MID_CAP_SLIP,   'NEAR/USDC': MID_CAP_SLIP,  'INJ/USDC': MID_CAP_SLIP,
  'CRV/USDC': MID_CAP_SLIP,   'LDO/USDC': MID_CAP_SLIP,   'ENS/USDC': MID_CAP_SLIP,
  'TIA/USDC': MID_CAP_SLIP,   'SUI/USDC': MID_CAP_SLIP,   'MANTA/USDC': MID_CAP_SLIP,
  'JTO/USDC': MID_CAP_SLIP,   'PIXEL/USDC': MID_CAP_SLIP,
  'ACH/USDC': MICRO_CAP_SLIP, 'GMX/USDC': MICRO_CAP_SLIP, 'LSK/USDC': MICRO_CAP_SLIP,
  'PAXG/USDC': MICRO_CAP_SLIP,'THETA/USDC': MICRO_CAP_SLIP,'VANRY/USDC': MICRO_CAP_SLIP,
  'ZEC/USDC': LARGE_CAP_SLIP, 'FTM/USDC': LARGE_CAP_SLIP, 'XLM/USDC': LARGE_CAP_SLIP,
  'FET/USDC': MID_CAP_SLIP,   'WLD/USDC': MID_CAP_SLIP,   'PEPE/USDC': MID_CAP_SLIP,
  'TON/USDC': MID_CAP_SLIP,   'RENDER/USDC': MID_CAP_SLIP,'ENA/USDC': MID_CAP_SLIP,
  'ICP/USDC': MID_CAP_SLIP,   'DOT/USDC': MID_CAP_SLIP,   'AAVE/USDC': MID_CAP_SLIP,
  'MATIC/USDC': MID_CAP_SLIP, 'APT/USDC': MID_CAP_SLIP,   'ARB/USDC': MID_CAP_SLIP,
  'JUP/USDC': MID_CAP_SLIP,
};

/**
 * Full live filter stack — what main.js actually runs in production.
 * Every change to live filters MUST be mirrored here.
 */
export const FULL_LIVE_FILTERS = Object.freeze({
  mtfFilter:           true,
  mtfAlignBars:        config.mtfFilter?.alignBars ?? 16,
  mtfMinScore:         config.mtfFilter?.minAlignScore ?? 0.50,
  mtfReduceFactor:     config.mtfFilter?.reduceFactor ?? 0,
  mtf4hFilter:         true,
  mtf4hMinScore:       0.45,
  mtf4hLookback:       21,
  regimeSizing:        true,
  regimeBoostThresh:   25,
  regimePenaltyThresh: 15,
  regimeBoostFactor:   1.3,
  regimePenaltyFactor: 0.5,
  macroFilter:         config.macroFilter?.enabled ?? true,
  macroEMAPeriod:      config.macroFilter?.emaPeriod ?? 200,
  macroSizeReduceFactor: config.macroFilter?.sizeReduceFactor ?? 0.5,
  confSizing:          true,
  confSizingMid:       0.65,
  confSizingMax:       1.5,
  confSizingMin:       0.6,
  breakEvenTriggerPct: config.risk?.breakEvenTriggerPct ?? 0.05,
  // Phase 7 portfolio risk gates
  correlationFilter:    config.correlation?.enabled ?? false,
  correlationThreshold: config.correlation?.threshold ?? 0.85,
  correlationPeriod:    config.correlation?.period ?? 60,
});

/**
 * Build per-symbol risk + minConfidence maps from config.perSymbol{} so the
 * backtester honours the same overrides the live bot uses.
 */
export function buildPerSymbolOverrides(symbols) {
  const symbolRisk = {};
  const symbolMinConfidence = {};
  for (const sym of symbols) {
    const ps = config.perSymbol?.[sym];
    if (!ps) continue;
    if (ps.stopLossPct != null || ps.takeProfitPct != null) {
      symbolRisk[sym] = {
        ...(ps.stopLossPct   != null && { stopLossPct:   ps.stopLossPct }),
        ...(ps.takeProfitPct != null && { takeProfitPct: ps.takeProfitPct }),
      };
    }
    if (ps.minConfidence != null) symbolMinConfidence[sym] = ps.minConfidence;
  }
  return { symbolRisk, symbolMinConfidence };
}

// ── Candle loading ────────────────────────────────────────────────────────────

export async function loadAllSymbols(symbols, timeframe = '12h') {
  const out = {};
  for (const sym of symbols) {
    const c = await loadCachedCandles(sym, timeframe);
    if (c.length >= 60) out[sym] = c;
  }
  return out;
}

export function loadMtfCandles(symbols, suffix) {
  const out = {};
  for (const sym of symbols) {
    const base = sym.replace('/', '_');
    const path = `data/candles/${base}_${suffix}.json`;
    if (existsSync(path)) {
      try {
        out[sym] = JSON.parse(readFileSync(path, 'utf8'));
      } catch { /* skip malformed */ }
    }
  }
  return out;
}

/**
 * Slice each symbol's candles to a [startTs, endTs] window. Symbols whose data
 * doesn't overlap the window get an empty array (caller filters).
 */
export function sliceWindow(symbolCandles, startTs, endTs) {
  const out = {};
  for (const [sym, candles] of Object.entries(symbolCandles)) {
    const slice = candles.filter((c) => c.timestamp >= startTs && c.timestamp <= endTs);
    if (slice.length >= 60) out[sym] = slice;
  }
  return out;
}

// ── Window definitions (data-aware) ───────────────────────────────────────────

/**
 * Define evaluation windows based on the most-recent 12h candle timestamp
 * across the loaded symbols. We can't define stress windows that pre-date the
 * available data, so the framework only emits windows that have ≥ N candles.
 */
export function defineWindows(symbolCandles, anchorSymbol = 'BTC/USDC') {
  const anchor = symbolCandles[anchorSymbol]
    ?? symbolCandles[Object.keys(symbolCandles).find((s) => symbolCandles[s].length >= 730)]
    ?? Object.values(symbolCandles)[0];
  if (!anchor?.length) return [];
  const TF_MS = 12 * 60 * 60 * 1000;
  const lastTs = anchor.at(-1).timestamp;
  const firstTs = anchor[0].timestamp;
  const days = (ts) => Math.floor((lastTs - ts) / (1000 * 60 * 60 * 24));

  const windows = [];

  // W1: most recent 90 days = 180 × 12h candles
  windows.push({
    id: 'last_90d',
    label: 'Last 90 days',
    description: 'Most recent quarter — primary OOS read',
    startTs: lastTs - 90 * 24 * 60 * 60 * 1000,
    endTs: lastTs,
  });

  // W2: most recent 180 days
  windows.push({
    id: 'last_180d',
    label: 'Last 180 days',
    description: 'Most recent half-year',
    startTs: lastTs - 180 * 24 * 60 * 60 * 1000,
    endTs: lastTs,
  });

  // W3: most recent 365 days (≈ Y2, the optimizer's training window)
  windows.push({
    id: 'y2_365d',
    label: 'Y2 (last 365d, IN-SAMPLE)',
    description: 'Optimizer trained on this — expect inflation',
    startTs: lastTs - 365 * 24 * 60 * 60 * 1000,
    endTs: lastTs,
  });

  // W4: previous year (Y1, the optimizer's holdout) — IF data goes back that far
  if (firstTs <= lastTs - 730 * 24 * 60 * 60 * 1000) {
    windows.push({
      id: 'y1_holdout',
      label: 'Y1 (holdout)',
      description: 'Optimizer holdout window — the legitimate OOS read',
      startTs: lastTs - 730 * 24 * 60 * 60 * 1000,
      endTs:   lastTs - 365 * 24 * 60 * 60 * 1000,
    });
    // W5: full 2-year span
    windows.push({
      id: 'y1y2_full',
      label: 'Y1+Y2 (full 2yr)',
      description: 'Full 2-year mixed in-sample + holdout',
      startTs: lastTs - 730 * 24 * 60 * 60 * 1000,
      endTs:   lastTs,
    });
  }

  // W6: full available history (whatever the anchor symbol has)
  windows.push({
    id: 'full_history',
    label: `Full history (${days(firstTs)}d)`,
    description: 'Every candle we have',
    startTs: firstTs,
    endTs:   lastTs,
  });

  return windows;
}

/**
 * Find natural BTC drawdown stress windows in the available data.
 * Looks for any 60-day window where BTC peak→trough ≥ 15%.
 */
export function findStressWindows(symbolCandles) {
  const btc = symbolCandles['BTC/USDC'];
  if (!btc?.length) return [];
  const SCAN_BARS = 120; // 60 days × 2 (12h candles)
  const MIN_DD = 0.15;
  const stress = [];
  for (let i = 0; i + SCAN_BARS < btc.length; i += SCAN_BARS / 2) {
    const window = btc.slice(i, i + SCAN_BARS);
    let peak = window[0].close;
    let trough = window[0].close;
    for (const c of window) {
      if (c.close > peak) peak = c.close;
      if (c.close < trough) trough = c.close;
    }
    const dd = (peak - trough) / peak;
    if (dd >= MIN_DD) {
      stress.push({
        id: `btc_dd_${new Date(window[0].timestamp).toISOString().slice(0, 7)}`,
        label: `BTC drawdown ≥15% (${new Date(window[0].timestamp).toISOString().slice(0, 10)})`,
        description: `Auto-detected BTC ${(dd * 100).toFixed(1)}% peak-to-trough over 60d`,
        startTs: window[0].timestamp,
        endTs:   window.at(-1).timestamp,
        btcDrawdown: Number(dd.toFixed(4)),
      });
    }
  }
  // Dedupe overlapping windows by keeping only the deepest in each non-overlapping cluster
  stress.sort((a, b) => a.startTs - b.startTs);
  const merged = [];
  for (const w of stress) {
    const last = merged.at(-1);
    if (!last || w.startTs >= last.endTs) {
      merged.push(w);
    } else if (w.btcDrawdown > last.btcDrawdown) {
      merged[merged.length - 1] = w;
    }
  }
  return merged;
}

// ── Backtest runner ───────────────────────────────────────────────────────────

/**
 * Run a single window through the PortfolioBacktester with the full live
 * filter stack and return enriched metrics including deflated Sharpe.
 *
 * @param {object} args
 * @param {object} args.window           — one entry from defineWindows()
 * @param {object} args.symbolCandles    — full 12h candles per symbol (pre-loaded)
 * @param {object} args.mtf15mCandles    — 15m candles per symbol (pre-loaded)
 * @param {object} args.mtf4hCandles     — 4h candles per symbol (pre-loaded)
 * @param {number} args.nTrials          — for deflated Sharpe (default 16280)
 * @param {number} args.budget           — starting balance (default 1000)
 * @param {number} args.maxOpenPositions — slots (default from config)
 */
export function runWindow({
  window,
  symbolCandles,
  mtf15mCandles = {},
  mtf4hCandles = {},
  nTrials = 16280,
  budget = 1000,
  maxOpenPositions = config.risk?.maxOpenPositions ?? 4,
}) {
  const sliced = sliceWindow(symbolCandles, window.startTs, window.endTs);
  const symbols = Object.keys(sliced);
  if (symbols.length === 0) {
    return {
      window,
      symbols_used: 0,
      skipped: true,
      reason: 'no symbols have candles in this window',
    };
  }
  const strategies = Object.fromEntries(symbols.map((s) => [s, buildStrategies(s)]));
  const { symbolRisk, symbolMinConfidence } = buildPerSymbolOverrides(symbols);
  const minConfMedian = median(
    symbols.map((s) => config.perSymbol?.[s]?.minConfidence ?? config.risk?.minConfidence ?? 0.7),
  );
  const slMedian = median(symbols.map((s) => config.perSymbol?.[s]?.stopLossPct ?? config.risk?.stopLossPct ?? 0.05));
  const tpMedian = median(symbols.map((s) => config.perSymbol?.[s]?.takeProfitPct ?? config.risk?.takeProfitPct ?? 0.12));

  const backtester = new PortfolioBacktester(strategies, {
    risk: {
      // Spread config.risk first so atrStops, twoStageExit, breakEvenTriggerPct,
      // and other Phase 1+ additions flow through automatically.
      ...(config.risk ?? {}),
      initialBalance:      budget,
      stopLossPct:         slMedian,
      takeProfitPct:       tpMedian,
      trailingStopPct:     0,
      feePct:              0.001,
      slippagePct:         0.001,
      breakEvenTriggerPct: FULL_LIVE_FILTERS.breakEvenTriggerPct,
    },
    // Forward the global signals block (carries multiBarConfirmation, algoWeight, etc.)
    // and only override minConfidence with the per-window median.
    signals: { ...(config.signals ?? {}), minConfidence: minConfMedian },
    maxOpenPositions,
    symbolSlippage:    SLIPPAGE_TIERS,
    symbolRisk,
    symbolMinConfidence,
    mtfSymbolCandles:  mtf15mCandles,
    mtf4hSymbolCandles: mtf4hCandles,
    confidenceThresholdScale: Number.isFinite(config.risk?.confidenceThresholdScale)
      ? config.risk.confidenceThresholdScale
      : 1,
    ...FULL_LIVE_FILTERS,
  });

  const result = backtester.run(sliced);
  const dailyReturns = extractDailyReturns(result.equityCurve, budget);
  const dsr = deflatedSharpeRatio({
    observedSharpe: result.metrics.sharpeRatio,
    returns: dailyReturns,
    nTrials,
  });

  return {
    window: { ...window, candle_count: dailyReturns.length * 2, days: Math.round((window.endTs - window.startTs) / (1000 * 60 * 60 * 24)) },
    symbols_used: symbols.length,
    budget,
    max_open_positions: maxOpenPositions,
    n_trials_assumed: nTrials,
    metrics: {
      total_trades:    result.metrics.totalTrades,
      win_rate:        Number(result.metrics.winRate.toFixed(4)),
      total_return:    Number(result.metrics.totalReturn.toFixed(4)),
      total_return_pct: result.metrics.totalReturnPct,
      profit_factor:   result.metrics.profitFactor === Infinity ? null : result.metrics.profitFactor,
      sharpe:          result.metrics.sharpeRatio,
      sortino:         result.metrics.sortinoRatio === Infinity ? null : result.metrics.sortinoRatio,
      max_drawdown:    Number(result.metrics.maxDrawdown.toFixed(4)),
      max_drawdown_pct: result.metrics.maxDrawdownPct,
      final_balance:   result.finalBalance,
      avg_win:         result.metrics.avgWin,
      avg_loss:        result.metrics.avgLoss,
      by_reason:       result.metrics.byReason,
    },
    deflated_sharpe: dsr,
    filters_applied: result.filtersApplied ?? {},
  };
}

function extractDailyReturns(equityCurve, initialBalance) {
  if (!Array.isArray(equityCurve) || equityCurve.length < 2) return [];
  const byDay = new Map();
  for (const point of equityCurve) {
    const ts = Number(point?.timestamp ?? 0);
    const bal = Number(point?.balance);
    if (!Number.isFinite(bal) || !Number.isFinite(ts)) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    byDay.set(day, bal);
  }
  const sorted = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
  if (sorted.length < 2) return [];
  const rets = [];
  let prev = initialBalance;
  for (const bal of sorted) {
    if (prev > 0) rets.push((bal - prev) / prev);
    prev = bal;
  }
  return rets;
}

function median(arr) {
  const sorted = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Git metadata for provenance ───────────────────────────────────────────────

export function gitMeta() {
  try {
    return {
      branch: execSync('git rev-parse --abbrev-ref HEAD').toString().trim(),
      sha:    execSync('git rev-parse --short HEAD').toString().trim(),
      dirty:  execSync('git status --porcelain').toString().trim().length > 0,
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown', dirty: true };
  }
}

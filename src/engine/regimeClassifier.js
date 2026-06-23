/**
 * BTC Regime Classifier (Phase 4).
 *
 * Classifies the current market regime from BTC candles into one of:
 *   • BULL_TREND  — BTC > EMA200 AND ADX(14) ≥ 25
 *   • BULL_RANGE  — BTC > EMA200 AND ADX(14) <  25
 *   • BEAR_TREND  — BTC < EMA200 AND ADX(14) ≥ 25
 *   • BEAR_CHOP   — BTC < EMA200 AND ADX(14) <  25
 *
 * Why these axes:
 *   - Macro direction (above/below EMA200) — long-cycle bias
 *   - Trend strength (ADX threshold) — separates trending from chop
 * The 2x2 grid is the smallest regime taxonomy that captures the four
 * distinct strategy environments.
 *
 * Hysteresis:
 *   To avoid flip-flop on a single candle that touches the threshold,
 *   a regime change requires the new label to win `hysteresisBars` (default 3)
 *   consecutive classifications. Until then we report the LAST stable regime.
 *
 * Pure / deterministic:
 *   classifyAt(candles, idx) is a pure function — given the same BTC candle
 *   array, it always returns the same regime label at the same idx. No
 *   internal mutable state.
 *
 * Stateful adapter:
 *   The RegimeTracker class wraps classifyAt with the hysteresis bookkeeping
 *   so live + backtester each create one instance and call advance() per bar.
 *
 * Consumed by:
 *   - src/main.js                — live regime gate, sizing modulator
 *   - src/backtester/...         — backtester mirrors via the same module
 *   - src/dashboard/...          — surface current regime in UI
 */

import { calculateEMA, calculateADX } from '../utils/indicators.js';

export const REGIME_LABELS = Object.freeze({
  BULL_TREND: 'BULL_TREND',
  BULL_RANGE: 'BULL_RANGE',
  BEAR_TREND: 'BEAR_TREND',
  BEAR_CHOP:  'BEAR_CHOP',
});

export const DEFAULT_REGIME_CFG = Object.freeze({
  emaPeriod:        200,
  adxPeriod:        14,
  adxTrendThreshold: 25,
  hysteresisBars:    3,
});

/**
 * Classify the regime at the END of `candles.slice(0, idx + 1)`.
 * Excludes the forming candle by accepting only closed bars in the slice.
 *
 * @param {Array<{close: number, high: number, low: number}>} closedCandles
 * @param {object} cfg
 * @returns {{ label: string|null, btcAboveEma: boolean|null, adx: number|null, btcClose: number|null, ema200: number|null }}
 */
export function classifySnapshot(closedCandles, cfg = DEFAULT_REGIME_CFG) {
  if (!Array.isArray(closedCandles) || closedCandles.length < Math.max(cfg.emaPeriod, cfg.adxPeriod * 2 + 5)) {
    return { label: null, btcAboveEma: null, adx: null, btcClose: null, ema200: null };
  }
  const closes = closedCandles.map((c) => Number(c.close));
  const highs  = closedCandles.map((c) => Number(c.high));
  const lows   = closedCandles.map((c) => Number(c.low));

  const emaValues = calculateEMA(closes, cfg.emaPeriod);
  const ema200    = Number(emaValues.at(-1));

  // ADX only needs the tail — last 50-60 bars are enough for stable ADX(14)
  const adxWindow = Math.min(closes.length, 60);
  const adxValues = calculateADX(
    highs.slice(-adxWindow),
    lows.slice(-adxWindow),
    closes.slice(-adxWindow),
    cfg.adxPeriod,
  );
  const adx = Number(adxValues.at(-1)?.adx);

  const btcClose = closes.at(-1);
  if (!Number.isFinite(ema200) || !Number.isFinite(adx) || !Number.isFinite(btcClose)) {
    return { label: null, btcAboveEma: null, adx: null, btcClose, ema200 };
  }
  const btcAboveEma = btcClose > ema200;
  const trending = adx >= cfg.adxTrendThreshold;
  let label;
  if (btcAboveEma && trending)  label = REGIME_LABELS.BULL_TREND;
  else if (btcAboveEma)          label = REGIME_LABELS.BULL_RANGE;
  else if (trending)             label = REGIME_LABELS.BEAR_TREND;
  else                           label = REGIME_LABELS.BEAR_CHOP;

  return { label, btcAboveEma, adx: Number(adx.toFixed(2)), btcClose, ema200 };
}

/**
 * Stateful regime tracker with hysteresis. Maintains:
 *   - currentRegime: the latest STABLE regime label (what callers consume)
 *   - candidateRegime: the most recent raw label seen
 *   - candidateStreak: how many consecutive bars the candidate has held
 *
 * Construction: new RegimeTracker(cfg, initialRegime = 'BULL_RANGE')
 * Usage: tracker.update(closedBtcCandles) returns the current stable regime
 *        snapshot AFTER applying the new observation.
 */
export class RegimeTracker {
  constructor(cfg = {}, initialRegime = REGIME_LABELS.BULL_RANGE) {
    this.cfg = { ...DEFAULT_REGIME_CFG, ...cfg };
    this.currentRegime = initialRegime;
    this.previousRegime = initialRegime;
    this.candidateRegime = null;
    this.candidateStreak = 0;
    this.changedAt = null;     // ms timestamp of last stable-regime change
    this.history = [];          // last N stable transitions for the dashboard
  }

  /**
   * Feed the latest closed BTC candles (newest last). Returns the post-update
   * snapshot: { regime, regimeChanged, candidate, streak, raw }.
   */
  update(closedBtcCandles, tsMs = Date.now()) {
    const snap = classifySnapshot(closedBtcCandles, this.cfg);
    if (!snap.label) {
      return {
        regime: this.currentRegime,
        regimeChanged: false,
        candidate: null,
        streak: 0,
        raw: snap,
      };
    }

    if (snap.label === this.currentRegime) {
      // Already in this regime — reset candidate
      this.candidateRegime = snap.label;
      this.candidateStreak = 0;
    } else if (snap.label === this.candidateRegime) {
      this.candidateStreak += 1;
    } else {
      this.candidateRegime = snap.label;
      this.candidateStreak = 1;
    }

    let regimeChanged = false;
    if (
      this.candidateRegime !== this.currentRegime
      && this.candidateStreak >= this.cfg.hysteresisBars
    ) {
      this.previousRegime = this.currentRegime;
      this.currentRegime = this.candidateRegime;
      this.changedAt = tsMs;
      this.candidateStreak = 0;
      regimeChanged = true;
      this.history.push({ at: tsMs, from: this.previousRegime, to: this.currentRegime });
      if (this.history.length > 50) this.history.shift();
    }

    return {
      regime: this.currentRegime,
      regimeChanged,
      candidate: this.candidateRegime,
      streak: this.candidateStreak,
      raw: snap,
    };
  }

  /** Plain JS snapshot for serialisation (dashboard / persistence). */
  toJSON() {
    return {
      currentRegime: this.currentRegime,
      previousRegime: this.previousRegime,
      candidate: this.candidateRegime,
      candidateStreak: this.candidateStreak,
      changedAt: this.changedAt,
      history: this.history,
      cfg: this.cfg,
    };
  }
}

/**
 * Convenience: classify a regime at every bar in a BTC candle series.
 * Returns an array of stable regime labels (one per bar after warmup).
 * Used by the backtester to pre-compute regimes for each step.
 *
 * @param {Array} btcCandles  — closed BTC candles, newest last
 * @param {object} cfg
 * @returns {Array<{ ts: number, regime: string|null, raw: object }>}
 */
export function classifySeries(btcCandles, cfg = DEFAULT_REGIME_CFG) {
  const tracker = new RegimeTracker(cfg);
  const out = [];
  const minBars = Math.max(cfg.emaPeriod, cfg.adxPeriod * 2 + 5);
  for (let i = 0; i < btcCandles.length; i++) {
    if (i < minBars - 1) {
      out.push({ ts: btcCandles[i].timestamp, regime: null, raw: null });
      continue;
    }
    const slice = btcCandles.slice(0, i + 1);
    const snap = tracker.update(slice, btcCandles[i].timestamp);
    out.push({ ts: btcCandles[i].timestamp, regime: snap.regime, raw: snap.raw });
  }
  return out;
}

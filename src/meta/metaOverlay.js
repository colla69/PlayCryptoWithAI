/**
 * Meta-overlay gate (Phase 5).
 *
 * Loads the trained logistic-regression model (data/meta_overlay.json) and
 * exposes P(win) for a candidate trade plus a pass/fail gate. Used identically
 * by live (main.js / filters) and the backtester so behaviour can't diverge.
 *
 * The overlay is a *gate only* — it never scales position size (avoids double
 * counting confidence, which already drives sizing). Default OFF until a trained
 * model demonstrably beats the baseline.
 *
 * Feature vector (entry-time, no lookahead) — order is canonical and shared by
 * the trainer and the gate:
 */
import { existsSync, readFileSync } from 'fs';
import { predictProba } from './logisticRegression.js';
import { REGIME_LABELS } from '../engine/regimeClassifier.js';

export const FEATURE_ORDER = Object.freeze([
  'aggConfidence',   // aggregate decision confidence ∈ [0,1]
  'buyVoteFrac',     // fraction of the symbol's strategies voting BUY
  'adx',             // symbol ADX(14) at entry (trend strength)
  'atrPct',          // symbol ATR% at entry (volatility)
  'fearGreed',       // F&G index / 100 ∈ [0,1]
  'btcdDelta',       // BTC.D minus its 7d SMA (pp); 0 if unknown
  'reg_bull_trend',  // regime one-hot
  'reg_bull_range',
  'reg_bear_trend',
  'reg_bear_chop',
]);

/** Build the canonical feature vector from a context object. Missing → 0. */
export function buildFeatureVector(ctx = {}) {
  const regime = ctx.regime ?? null;
  return [
    num(ctx.aggConfidence),
    num(ctx.buyVoteFrac),
    num(ctx.adx),
    num(ctx.atrPct),
    num(ctx.fearGreed),
    num(ctx.btcdDelta),
    regime === REGIME_LABELS.BULL_TREND ? 1 : 0,
    regime === REGIME_LABELS.BULL_RANGE ? 1 : 0,
    regime === REGIME_LABELS.BEAR_TREND ? 1 : 0,
    regime === REGIME_LABELS.BEAR_CHOP  ? 1 : 0,
  ];
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Load the trained model JSON, or null if absent/invalid. */
export function loadMetaModel(path = 'data/meta_overlay.json') {
  try {
    if (!existsSync(path)) return null;
    const model = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(model?.weights) || !Array.isArray(model?.featureOrder)) return null;
    return model;
  } catch {
    return null;
  }
}

/** P(win) for a context object using the loaded model. 1.0 if no model (no-op gate). */
export function winProbability(model, ctx) {
  if (!model) return 1;
  // Reorder ctx features to the model's stored order (defensive against drift).
  const order = model.featureOrder ?? FEATURE_ORDER;
  const full = vectorByName(ctx);
  const x = order.map((name) => full[name] ?? 0);
  return predictProba(model, x);
}

/**
 * Gate decision. Returns { pass, pWin }.
 * - No model or disabled → always pass (pWin null).
 * - Otherwise pass = P(win) ≥ threshold.
 */
export function evaluateGate(model, ctx, threshold = 0.55) {
  if (!model) return { pass: true, pWin: null };
  const pWin = winProbability(model, ctx);
  return { pass: pWin >= threshold, pWin: Number(pWin.toFixed(4)) };
}

function vectorByName(ctx) {
  const arr = buildFeatureVector(ctx);
  const out = {};
  FEATURE_ORDER.forEach((name, i) => { out[name] = arr[i]; });
  return out;
}

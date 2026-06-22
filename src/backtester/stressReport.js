/**
 * Stress-window stoplight report (Phase 8).
 *
 * Pure verdict functions that turn baseline/stress-window metrics into a
 * green / yellow / red stoplight, so every change gets an at-a-glance honest
 * read on whether it holds up under drawdown stress.
 *
 * Thresholds (defaults, overridable):
 *   RED    — max drawdown deeper than -15%  OR  Sharpe < 0.8   (on a window
 *            that actually traded enough to judge)
 *   YELLOW — max drawdown deeper than -10%  OR  Sharpe < 1.2
 *   GREEN  — otherwise
 *   N/A    — fewer than `minTrades` trades (not enough to judge)
 *
 * Consumed by src/scripts/runBaseline.mjs (--stoplight) and any future CI gate.
 * Pure: no I/O, no logging, no config mutation.
 */

export const DEFAULT_STRESS_THRESHOLDS = Object.freeze({
  ddRed:        0.15,   // |max_drawdown| ≥ 15% → red
  ddYellow:     0.10,   // |max_drawdown| ≥ 10% → yellow
  sharpeRed:    0.8,    // sharpe < 0.8 → red
  sharpeYellow: 1.2,    // sharpe < 1.2 → yellow
  minTrades:    5,      // below this we can't judge → N/A
});

const LEVEL_RANK = { green: 0, na: 1, yellow: 2, red: 3 };

/**
 * Verdict for a single window's metrics.
 * @param {{ sharpe:number, max_drawdown:number, total_trades:number }} metrics
 * @param {object} [thresholds]
 * @returns {{ level:'green'|'yellow'|'red'|'na', reasons:string[] }}
 */
export function windowVerdict(metrics, thresholds = DEFAULT_STRESS_THRESHOLDS) {
  const t = { ...DEFAULT_STRESS_THRESHOLDS, ...thresholds };
  if (!metrics || !Number.isFinite(metrics.total_trades) || metrics.total_trades < t.minTrades) {
    return { level: 'na', reasons: [`only ${metrics?.total_trades ?? 0} trades (< ${t.minTrades})`] };
  }
  const dd = Math.abs(Number(metrics.max_drawdown ?? 0)); // stored as positive fraction
  const sharpe = Number(metrics.sharpe ?? 0);
  const reasons = [];
  let level = 'green';

  const bump = (lvl) => { if (LEVEL_RANK[lvl] > LEVEL_RANK[level]) level = lvl; };

  if (dd >= t.ddRed)            { bump('red');    reasons.push(`DD -${(dd*100).toFixed(1)}% ≥ -${(t.ddRed*100).toFixed(0)}%`); }
  else if (dd >= t.ddYellow)   { bump('yellow'); reasons.push(`DD -${(dd*100).toFixed(1)}% ≥ -${(t.ddYellow*100).toFixed(0)}%`); }

  if (sharpe < t.sharpeRed)        { bump('red');    reasons.push(`Sharpe ${sharpe.toFixed(2)} < ${t.sharpeRed}`); }
  else if (sharpe < t.sharpeYellow){ bump('yellow'); reasons.push(`Sharpe ${sharpe.toFixed(2)} < ${t.sharpeYellow}`); }

  if (level === 'green') reasons.push(`DD -${(dd*100).toFixed(1)}%, Sharpe ${sharpe.toFixed(2)} — within limits`);
  return { level, reasons };
}

/**
 * Roll up a list of baseline window-results into an overall stoplight.
 * @param {Array<{ skipped?:boolean, window:object, metrics?:object }>} windowResults
 * @param {object} [thresholds]
 * @returns {{ overall:'green'|'yellow'|'red', counts:object, rows:Array }}
 */
export function summarizeStress(windowResults, thresholds = DEFAULT_STRESS_THRESHOLDS) {
  const rows = [];
  const counts = { green: 0, yellow: 0, red: 0, na: 0, skipped: 0 };
  let overall = 'green';

  for (const r of windowResults ?? []) {
    if (r?.skipped) {
      counts.skipped += 1;
      rows.push({ id: r.window?.id ?? '?', level: 'skipped', reasons: [r.reason ?? 'skipped'] });
      continue;
    }
    const v = windowVerdict(r.metrics, thresholds);
    counts[v.level] += 1;
    rows.push({
      id: r.window?.id ?? '?',
      label: r.window?.label ?? '',
      level: v.level,
      reasons: v.reasons,
      sharpe: r.metrics?.sharpe,
      dd: r.metrics?.max_drawdown,
      trades: r.metrics?.total_trades,
    });
    // Only green/yellow/red affect the overall (N/A and skipped are neutral)
    if (LEVEL_RANK[v.level] != null && LEVEL_RANK[v.level] > LEVEL_RANK[overall] && v.level !== 'na') {
      overall = v.level;
    }
  }
  return { overall, counts, rows };
}

export const LEVEL_EMOJI = Object.freeze({ green: '🟢', yellow: '🟡', red: '🔴', na: '⚪', skipped: '⏭️' });

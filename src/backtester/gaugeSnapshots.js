/**
 * gaugeSnapshots.js — point-in-time context gauges from recorded snapshots.
 *
 * Coin Metrics recomputes its exchange-flow history whenever its address labels
 * change, so the downloaded history is not what anyone could see at the time
 * (plan doc § G2). `recordContextGauges.mjs` saves the recent rows as published,
 * once a day; these helpers rebuild each gauge from the snapshot that existed at a
 * given time, never from a later one.
 */

const DAY = 86_400_000;

/**
 * EX1 / EX7 inputs for the newest row of one snapshot — the same math as
 * runTrendCore's G2 overlays: supply vs 30 days earlier, and the 7-day net inflow.
 * @param {Array<{t:number,sply:number,fin:number,fout:number}>} rows sorted by t
 * @returns {{t:number, d30:number|null, net7:number|null}|null}
 */
export function exchangeGauges(rows) {
  if (!rows?.length) return null;
  const last = rows.at(-1);
  const ref = rows.find((r) => r.t === last.t - 30 * DAY);
  let net = 0;
  let k = 0;
  for (let j = rows.length - 1; j >= 0 && rows[j].t > last.t - 7 * DAY; j--) {
    net += rows[j].fin - rows[j].fout;
    k++;
  }
  return {
    t: last.t,
    d30: ref ? last.sply / ref.sply - 1 : null,
    net7: k === 7 ? net : null,
  };
}

/**
 * The gauges as known at time `t`: from the newest snapshot recorded at or before
 * `t`, or null when that snapshot is older than `maxAgeMs` (a missed recording is
 * a gap, not a reason to reach for a later snapshot).
 * @param {Array<{recordedAt:number, rows:Array}>} snapshots sorted by recordedAt
 */
export function gaugesAsOf(snapshots, t, maxAgeMs = 2 * DAY) {
  let snap = null;
  for (const s of snapshots) {
    if (s.recordedAt > t) break;
    snap = s;
  }
  if (!snap || t - snap.recordedAt > maxAgeMs) return null;
  return { recordedAt: snap.recordedAt, ...exchangeGauges(snap.rows) };
}

/**
 * How much the published history moved between snapshots: for every day seen in
 * more than one snapshot, the largest change of each field from its first value.
 */
export function revisionStats(snapshots, fields = ['sply', 'fin', 'fout']) {
  const first = new Map();
  const worst = Object.fromEntries(fields.map((f) => [f, 0]));
  let days = 0;
  for (const s of snapshots) {
    for (const r of s.rows) {
      const seen = first.get(r.t);
      if (!seen) { first.set(r.t, r); continue; }
      days++;
      for (const f of fields) {
        const base = Math.abs(seen[f]) || 1;
        worst[f] = Math.max(worst[f], Math.abs(r[f] - seen[f]) / base);
      }
    }
  }
  return { comparisons: days, maxRelChange: worst };
}

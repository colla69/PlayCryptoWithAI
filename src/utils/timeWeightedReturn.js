/**
 * Time-weighted return (TWR) — strategy performance, independent of deposits.
 *
 * WHY THIS EXISTS
 * ---------------
 * The obvious formula, `(equity - totalDeposits) / totalDeposits`, is a
 * money-weighted return. It answers "how is my wealth doing", which is a fine
 * question but a useless one for judging the bot: deposit into a flat strategy
 * and the number moves purely because of the deposit's timing and size. Once you
 * contribute regularly it becomes impossible to tell a working strategy from a
 * well-timed transfer.
 *
 * TWR removes that. It chains the growth of each interval BETWEEN cash flows, so
 * contributions and withdrawals cancel out and only the manager's decisions
 * remain. It is the standard basis for comparing strategies (GIPS).
 *
 * Report both: TWR answers "does the strategy work", simple P&L answers "is my
 * money growing". They are different questions and they diverge as soon as you
 * start dollar-cost-averaging.
 */

/**
 * Portfolio value at or immediately before `timestamp`, from a sparse series of
 * snapshots. Carries the last known value forward — a valuation is only as fresh
 * as the most recent snapshot, and inventing one by interpolation would fabricate
 * precision the data does not have.
 *
 * @param {Array<{timestamp:number, equity:number}>} points ascending
 * @param {number} timestamp
 * @returns {number|null} null when no snapshot exists at or before `timestamp`
 */
export function equityAt(points, timestamp) {
  let value = null;
  for (const p of points) {
    if (Number(p.timestamp) > timestamp) break;
    if (Number.isFinite(Number(p.equity))) value = Number(p.equity);
  }
  return value;
}

/**
 * Chain-linked time-weighted return.
 *
 * Each sub-period runs from one cash flow to the next. Its return is
 * `V_before_next_flow / V_after_previous_flow - 1`, so the flow itself never
 * counts as performance. TWR is the product of `(1 + r)` across sub-periods.
 *
 * The first flow funds the account rather than entering an existing portfolio,
 * so it starts the first sub-period instead of being a return event.
 *
 * @param {object} args
 * @param {Array<{timestamp:number, equity:number}>} args.equityPoints ascending snapshots
 * @param {Array<{timestamp:number, amount:number}>} args.flows deposits (+) and withdrawals (−)
 * @param {number} [args.finalEquity] current equity; defaults to the last snapshot
 * @returns {{twr:number|null, subPeriods:Array<{from:number,to:number,startValue:number,endValue:number,ret:number}>,
 *            netContributions:number, simplePnl:number|null, simpleReturn:number|null, insufficientData:boolean}}
 */
export function computeTimeWeightedReturn({ equityPoints = [], flows = [], finalEquity = null } = {}) {
  const points = [...equityPoints]
    .filter((p) => Number.isFinite(Number(p?.timestamp)) && Number.isFinite(Number(p?.equity)))
    .sort((a, b) => a.timestamp - b.timestamp);
  const sorted = [...flows]
    .filter((f) => Number.isFinite(Number(f?.timestamp)) && Number.isFinite(Number(f?.amount)) && Number(f.amount) !== 0)
    .sort((a, b) => a.timestamp - b.timestamp);

  const netContributions = sorted.reduce((s, f) => s + Number(f.amount), 0);
  // `Number(null)` is 0, so a null finalEquity would otherwise be read as a
  // wiped-out account and report −100%. Check for null/undefined explicitly.
  const endEquity = finalEquity != null && Number.isFinite(Number(finalEquity))
    ? Number(finalEquity)
    : (points.at(-1)?.equity ?? null);

  const simplePnl = endEquity == null ? null : endEquity - netContributions;
  const simpleReturn = simplePnl == null || netContributions === 0
    ? null
    : simplePnl / netContributions;

  const empty = {
    twr: null, subPeriods: [], netContributions, simplePnl, simpleReturn, insufficientData: true,
  };
  if (endEquity == null) return empty;

  // The account starts when it is first funded. Without a funding event we can
  // still measure growth across the snapshot series alone.
  const first = sorted[0];
  let cursorValue = first ? Number(first.amount) : points[0]?.equity;
  let cursorTime = first ? Number(first.timestamp) : points[0]?.timestamp;
  if (!Number.isFinite(cursorValue) || !Number.isFinite(cursorTime)) return empty;

  const subPeriods = [];
  let chain = 1;

  for (const flow of sorted.slice(first ? 1 : 0)) {
    const before = equityAt(points, Number(flow.timestamp));
    // No valuation before this flow — the interval is unmeasurable. Skip it
    // rather than silently attributing the flow to performance.
    if (before == null || !(cursorValue > 0)) {
      cursorValue = (before ?? cursorValue) + Number(flow.amount);
      cursorTime = Number(flow.timestamp);
      continue;
    }
    const ret = before / cursorValue - 1;
    subPeriods.push({ from: cursorTime, to: Number(flow.timestamp), startValue: cursorValue, endValue: before, ret });
    chain *= 1 + ret;
    cursorValue = before + Number(flow.amount); // the flow itself is not performance
    cursorTime = Number(flow.timestamp);
  }

  // Final open interval: last flow → now.
  if (cursorValue > 0) {
    const ret = endEquity / cursorValue - 1;
    subPeriods.push({ from: cursorTime, to: Date.now(), startValue: cursorValue, endValue: endEquity, ret });
    chain *= 1 + ret;
  }

  if (!subPeriods.length) return empty;
  return {
    twr: chain - 1,
    subPeriods,
    netContributions,
    simplePnl,
    simpleReturn,
    insufficientData: false,
  };
}

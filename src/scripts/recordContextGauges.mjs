/**
 * recordContextGauges.mjs — record Coin Metrics exchange flows as published, by hand.
 * The bot does the same once a day (`config.gaugeRecorder`, src/data/gaugeRecorder.js);
 * this script is for a machine that does not run the bot, and for the report.
 *
 * Why: the downloaded history (downloadContextData --only flows) is recomputed, so a
 * backtest on it sees exchange labels nobody had at the time (plan doc § G2, § H).
 * Snapshots land in data/context/snapshots/cm_exchange_<asset>.jsonl.
 *
 * Usage: node src/scripts/recordContextGauges.mjs [--report]
 */
import { SNAPSHOT_ASSETS, readSnapshots, recordSnapshots } from '../data/gaugeRecorder.js';
import { exchangeGauges, revisionStats } from '../backtester/gaugeSnapshots.js';

const day = (t) => new Date(t).toISOString().slice(0, 10);
const fmtGauges = (g) => (g
  ? `row ${day(g.t)}  supply vs 30d ${g.d30 == null ? 'n/a' : `${(100 * g.d30).toFixed(2)}%`}` +
    `  net 7d ${g.net7 == null ? 'n/a' : g.net7.toFixed(0)}` +
    `  EX1 ${g.d30 > 0 ? 'ON' : 'off'}  EX7 ${g.net7 > 0 ? 'ON' : 'off'}`
  : 'no rows');

if (process.argv.includes('--report')) {
  for (const asset of SNAPSHOT_ASSETS) {
    const snaps = readSnapshots(asset);
    console.log(`\n${asset.toUpperCase()}: ${snaps.length} snapshots` +
      (snaps.length ? `  ${new Date(snaps[0].recordedAt).toISOString()} → ${new Date(snaps.at(-1).recordedAt).toISOString()}` : ''));
    for (const s of snaps.slice(-10)) {
      console.log(`  recorded ${new Date(s.recordedAt).toISOString().slice(0, 16)}  ${fmtGauges(exchangeGauges(s.rows))}`);
    }
    const rev = revisionStats(snaps);
    console.log(`  revisions: ${rev.comparisons} day-pairs compared; largest change from first published value ` +
      Object.entries(rev.maxRelChange).map(([f, v]) => `${f} ${(100 * v).toFixed(2)}%`).join(', '));
  }
} else {
  const results = await recordSnapshots();
  for (const r of results) {
    console.log(r.status === 'recorded'
      ? `${r.asset.toUpperCase()} ${r.rows.length} rows  ${fmtGauges(exchangeGauges(r.rows))}`
      : `${r.asset.toUpperCase()} not recorded: ${r.error}`);
  }
  if (results.some((r) => r.status === 'failed')) process.exitCode = 1;
}

/**
 * The TSM sleeve, replayed through the engine live runs, vs live's real sleeve orders
 * (plan 2026-10 single-engine rebuild, step 4, slice 3c).
 *
 * Vote-flip opens and closes are decisions and must land on live's cycles; resizes
 * follow account equity, which a replay only approximates.
 *
 * Usage:
 *   TSM_CORE=true PAPER_MODE=true node src/scripts/runSleeveReplay.mjs --snapshot <dir> \
 *     [--from 2026-08-03] [--to 2026-10-24] [--balance 189.43]
 */
import fs from 'node:fs';
import config from '../../config/default.js';
import * as bf from '../backtester/baselineFramework.js';
import { replayEngine } from '../backtester/engineReplay.js';
import { readDvolCache } from '../data/dvolFeed.js';
import { loadFearGreedHistory } from '../data/fearGreed.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const S = arg('--snapshot');
if (!S || !config.tsmCore?.enabled) {
  console.error('usage: TSM_CORE=true node src/scripts/runSleeveReplay.mjs --snapshot <dir> [--from] [--to] [--balance]');
  process.exit(1);
}
const H = 43200000;
const iso = (t) => new Date(t).toISOString().slice(0, 16) + 'Z';
const fromTs = Date.parse(arg('--from', '2026-08-03'));
const toTs = Date.parse(arg('--to', '2026-10-24'));
const readJson = (f) => JSON.parse(fs.readFileSync(`${S}/${f}`, 'utf8'));

const c12 = await bf.loadAllSymbols(config.symbols, '12h');
const history = readJson('data/equity_history.json');
const r = await replayEngine({
  symbolCandles: c12,
  mtf15mCandles: bf.loadMtfCandles(config.symbols, '15m'),
  mtf4hCandles: bf.loadMtfCandles(config.symbols, '4h'),
  fearGreedData: await loadFearGreedHistory(),
  fromTs, toTs, initialBalance: Number(arg('--balance', 189.43)),
  deposits: readJson('data/deposits.json').map((d) => ({ ts: Date.parse(d.timestamp), amount: Number(d.amount) })),
  slippage: bf.SLIPPAGE_TIERS,
  nasdaqRows: readJson('data/nasdaqTrend.json').rows,
  impliedVolRows: readDvolCache(),
  equityHistory: (Array.isArray(history) ? history : []).filter((p) => Date.parse(p.date ?? p.timestamp ?? 0) < fromTs),
});

// The replay's sleeve events: opens, flip closes, resize trims, positions still open.
const events = [];
for (const t of r.trades) {
  if (!t.symbol.endsWith('#core')) continue;
  events.push({ ts: Date.parse(t.openedAt), key: t.symbol, side: 'BUY' });
  events.push({ ts: Date.parse(t.timestamp), key: t.symbol, side: 'SELL', reason: t.reason });
}
for (const [key, pos] of r.sim.positions) if (pos.isCore) events.push({ ts: pos.entryTime, key, side: 'BUY', open: true });
const rp = [...new Map(events.map((e) => [`${Math.floor(e.ts / H) * H}|${e.key}|${e.side}`, e])).values()].sort((a, b) => a.ts - b.ts);

const live = fs.readFileSync(`${S}/logs/trades.csv`, 'utf8').trim().split('\n').slice(1).map((l) => l.split(','))
  .filter(([, s]) => s.endsWith('#core')).map(([ts, s, side]) => ({ ts: Date.parse(ts), key: s, side }));
const bucket = (e) => `${iso(Math.floor(e.ts / H) * H)} ${e.key.padEnd(14)} ${e.side}`;
const L = new Set(live.map(bucket));
const P = new Set(rp.map(bucket));
const flips = rp.filter((e) => e.side === 'BUY' || e.reason === 'tsm_core_flip');
console.log(`\nSleeve replay vs live — ${iso(fromTs)} → ${iso(toTs)}`);
console.log(`  vote-flip events in the replay: ${flips.length}, on live's cycle: ${flips.filter((e) => L.has(bucket(e))).length}`);
console.log(`  live sleeve orders (incl. resizes): ${live.length}`);
for (const e of rp) console.log(`    replay ${bucket(e)}${e.reason ? ` ${e.reason}` : ''}${e.open ? ' (still open)' : ''}   ${L.has(bucket(e)) ? 'live: same cycle' : 'live: —'}`);
for (const e of live) if (!P.has(bucket(e))) console.log(`    live only ${bucket(e)}`);

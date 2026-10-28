/**
 * runSuperbot.mjs — the bot with and without the satellite strategies, through the
 * engine replay, cut into rolling out-of-sample folds.
 *
 * The satellites' settings were fixed before any money run (plan 2026-10, "Combining
 * the streams"), so nothing is fitted here: every fold is out of sample, and the test
 * is how often each setup beats the committed bot fold by fold. Live conditions: the
 * committed config with the TSM sleeve on, $190 to start and $10 a week (live's money),
 * fees, slippage tiers, the $11 floor, 15m stop replay, satellites on the free cash.
 *
 * Usage (the replay reads data/candles, so swap the deep set in first and back after):
 *   PAPER_MODE=true TSM_CORE=true node src/scripts/runSuperbot.mjs --cell bot+bo+rs --out /tmp/sb_all.json
 *     cells: bot | bot+bo | bot+rs | bot+bo+rs   [--from 2020-06-01] [--to 2026-08-10] [--start 190] [--weekly 10]
 *     [--bo '{"lookbackBars":24,"stopAtr":2}']   — breakout settings over config.satellites.breakout (research grids)
 *     [--label <name>]                           — the cell's name in the report (default: the cell)
 *     [--per-symbol '{"minConfidence":0.55}']    — one shared override for every coin ('{}' = the global defaults)
 *     [--dvol <file>]                            — DVOL bars { BTC: [...], ETH: [...] } in place of data/dvol.json
 *   node src/scripts/runSuperbot.mjs --report /tmp/sb_bot.json,/tmp/sb_all.json [--fold-months 6]
 */
import fs from 'fs';
import config from '../../config/default.js';
import { loadAllSymbols, loadMtfCandles, SLIPPAGE_TIERS } from '../backtester/baselineFramework.js';
import { replayEngine } from '../backtester/engineReplay.js';
import { readDvolCache } from '../data/dvolFeed.js';
import { readExchangeEventsCache } from '../data/exchangeEventsFeed.js';
import { annualizedSharpe, dailyReturnsFromEquity, DAYS_PER_YEAR } from '../backtester/metrics.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const WEEK = 7 * 86_400_000;
const DAY = 86_400_000;

function metrics(rets) {
  if (rets.length < 20) return null;
  let tw = 1; let pk = 1; let dd = 0;
  for (const v of rets) { tw *= 1 + v; pk = Math.max(pk, tw); dd = Math.max(dd, 1 - tw / pk); }
  return { ret: tw - 1, ann: tw ** (DAYS_PER_YEAR / rets.length) - 1, sharpe: annualizedSharpe(rets), dd };
}

if (arg('report')) {
  const runs = arg('report').split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const foldMonths = Number(arg('fold-months', 6));
  const series = runs.map((r) => ({ cell: r.cell, rets: dailyReturnsFromEquity(r.equity, r.start, r.deposits, Date.parse(r.from)), final: r.equity.at(-1).balance, deposited: r.deposited, sim: r.sim }));
  const days = [...series[0].rets.keys()].sort((a, b) => a - b);
  const pct = (x, d = 1) => (x == null ? '—' : `${(100 * x).toFixed(d)}%`);
  console.log('Whole period');
  for (const s of series) {
    const m = metrics(days.map((d) => s.rets.get(d) ?? 0));
    console.log(`  ${s.cell.padEnd(10)} $${s.deposited} in → $${s.final.toFixed(0)} | ${pct(m.ann)} a year | Sharpe ${m.sharpe.toFixed(2)} | worst drop ${pct(m.dd)} | ${JSON.stringify(s.sim)}`);
  }
  // folds: calendar blocks of foldMonths, from the first day
  const first = new Date(days[0] * DAY);
  const folds = [];
  for (let y = first.getUTCFullYear(), mo = first.getUTCMonth(); ; mo += foldMonths) {
    const a = Date.UTC(y, mo, 1) / DAY; const b = Date.UTC(y, mo + foldMonths, 1) / DAY;
    if (a > days.at(-1)) break;
    folds.push([a, b]);
  }
  const base = series.find((s) => s.cell === 'bot') ?? series[0];
  const wins = Object.fromEntries(series.map((s) => [s.cell, { ret: 0, sharpe: 0, n: 0 }]));
  console.log(`\n${foldMonths}-month folds (return / Sharpe / worst drop)`);
  console.log(`  ${'fold'.padEnd(10)} ${series.map((s) => s.cell.padEnd(28)).join('')}`);
  for (const [a, b] of folds) {
    const ds = days.filter((d) => d >= a && d < b);
    const ms = series.map((s) => metrics(ds.map((d) => s.rets.get(d) ?? 0)));
    if (ms.some((m) => !m)) continue;
    const bm = ms[series.indexOf(base)];
    series.forEach((s, k) => { if (s !== base) { wins[s.cell].n++; if (ms[k].ret > bm.ret) wins[s.cell].ret++; if (ms[k].sharpe > bm.sharpe) wins[s.cell].sharpe++; } });
    console.log(`  ${new Date(a * DAY).toISOString().slice(0, 7).padEnd(10)} ${ms.map((m) => `${pct(m.ret).padStart(7)} ${m.sharpe.toFixed(2).padStart(5)} ${pct(m.dd).padStart(6)}`.padEnd(28)).join('')}`);
  }
  console.log(`\nFolds beating '${base.cell}'`);
  for (const s of series) if (s !== base) console.log(`  ${s.cell.padEnd(10)} on return ${wins[s.cell].ret}/${wins[s.cell].n} · on Sharpe ${wins[s.cell].sharpe}/${wins[s.cell].n}`);
  process.exit(0);
}

const cell = arg('cell', 'bot');
const out = arg('out');
if (!out || !['bot', 'bot+bo', 'bot+rs', 'bot+bo+rs'].includes(cell)) {
  console.error('usage: --cell bot|bot+bo|bot+rs|bot+bo+rs --out <file>   or   --report <a.json,b.json,...>');
  process.exit(1);
}
const fromTs = Date.parse(arg('from', '2020-06-01'));
const toTs = Date.parse(arg('to', '2026-08-10'));
const start = Number(arg('start', 190));
const weekly = Number(arg('weekly', 10));
const parts = cell.split('+'); // 'bot' itself contains 'bo': match whole parts only
// --per-symbol: one shared override for every coin in place of the tuned per-coin ones. Set
// on the imported config itself: strategyBuilder reads strategies and thresholds from it.
if (arg('per-symbol') != null) {
  config.perSymbol = Object.fromEntries(config.symbols.map((s) => [s, JSON.parse(arg('per-symbol'))]));
}
const cfg = {
  ...config,
  tsmCore: { ...config.tsmCore, enabled: true },
  satellites: {
    ...config.satellites,
    enabled: cell !== 'bot',
    breakout: { ...config.satellites.breakout, ...JSON.parse(arg('bo', '{}')), enabled: parts.includes('bo') },
    strongest: { ...config.satellites.strongest, enabled: parts.includes('rs') },
  },
};
const deposits = [];
for (let t = fromTs + WEEK; t <= toTs; t += WEEK) deposits.push({ ts: t, amount: weekly });
const symbolCandles = await loadAllSymbols(cfg.symbols, '12h');
const r = await replayEngine({
  symbolCandles, mtf15mCandles: loadMtfCandles(cfg.symbols, '15m'), mtf4hCandles: loadMtfCandles(cfg.symbols, '4h'),
  fearGreedData: JSON.parse(fs.readFileSync('data/fearGreed_full.json', 'utf8')).data,
  fromTs, toTs, initialBalance: start, deposits, slippage: SLIPPAGE_TIERS,
  nasdaqRows: JSON.parse(fs.readFileSync('data/nasdaqTrend.json', 'utf8')).rows, cfg,
  impliedVolRows: arg('dvol') ? JSON.parse(fs.readFileSync(arg('dvol'), 'utf8')) : readDvolCache(),
  exchangeEvents: readExchangeEventsCache()?.events,
});
const byReason = {};
for (const t of r.trades) { const k = t.reason ?? '?'; byReason[k] = (byReason[k] ?? 0) + 1; }
fs.writeFileSync(out, JSON.stringify({
  cell: arg('label', cell), from: arg('from', '2020-06-01'), to: arg('to', '2026-08-10'), start, weekly, deposits,
  deposited: start + deposits.length * weekly,
  equity: r.equity.map((p) => ({ timestamp: p.timestamp, balance: Number(p.balance.toFixed(2)) })),
  trades: r.trades.map((t) => ({ s: t.symbol, o: t.openedAt, c: t.timestamp, why: t.reason, pnl: t.pnl })),
  sim: { satellites: r.sim.satelliteStats, minNotionalRejections: r.sim.minNotionalRejections, exits: byReason },
}));
console.log(`done ${cell}: final ${r.equity.at(-1)?.balance.toFixed(2)} · satellites ${JSON.stringify(r.sim.satelliteStats)}`);

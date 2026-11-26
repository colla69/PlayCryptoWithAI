/**
 * runBuybackShadow.mjs — the sleeve buy-back rule's shadow log (plan 2026-11, check 3).
 *
 * Replays the committed bot twice over live's period, the rule off (as shipped) and on
 * (stayVotes 3 + rebuyConfirmBars 40), and lists the sleeve round trips that differ.
 * Nothing in live changes: this is the record to read at the 2027-02-10 re-check.
 * Reads data/candles — refresh it first (npm run download-history) for a current run.
 *
 * Usage:
 *   node src/scripts/runBuybackShadow.mjs --dir <folder for the two replay files>
 *     [--from 2026-05-29] [--to <today>] [--since 2026-08-10]
 *     --since: the rule was chosen on data to 2026-08-10; only what follows is unseen.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { annualizedSharpe, dailyReturnsFromEquity } from '../backtester/metrics.js';

const argv = process.argv.slice(2);
const arg = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const dir = arg('dir');
if (!dir) { console.error('usage: --dir <folder> [--from 2026-05-29] [--to <today>] [--since 2026-08-10]'); process.exit(1); }
const from = arg('from', '2026-05-29');
// Never past the data: the replay would carry flat prices to --to and dilute every figure.
const btc = JSON.parse(fs.readFileSync('data/candles/BTC_USDC_12h.json', 'utf8'));
const dataEnd = new Date((Array.isArray(btc) ? btc : btc.candles).at(-1).timestamp).toISOString().slice(0, 10);
const to = [arg('to', dataEnd), dataEnd].sort()[0];
const since = Date.parse(arg('since', '2026-08-10'));
const RULE = { stayVotes: 3, rebuyConfirmBars: 40 };
fs.mkdirSync(dir, { recursive: true });

function replay(name, tsm) {
  const out = path.join(dir, `${name}.json`);
  const log = fs.openSync(path.join(dir, `${name}.log`), 'w');
  return new Promise((resolve, reject) => {
    const p = spawn('node', ['src/scripts/runSuperbot.mjs', '--cell', 'bot', '--from', from, '--to', to, '--tsm', JSON.stringify(tsm), '--out', out], {
      env: { ...process.env, PAPER_MODE: 'true', TSM_CORE: 'true' }, stdio: ['ignore', log, log],
    });
    p.on('exit', (code) => (code === 0 ? resolve(JSON.parse(fs.readFileSync(out, 'utf8'))) : reject(new Error(`${name} replay failed, see ${dir}/${name}.log`))));
  });
}

const [off, on] = await Promise.all([replay('off', {}), replay('on', RULE)]);
const sleeve = (r) => r.trades.filter((t) => t.why === 'tsm_core_flip');
const key = (t) => `${t.s}|${t.o}|${t.c}`;
const day = (iso) => iso.slice(0, 16).replace('T', ' ');
const line = (t) => `${t.s.padEnd(12)} ${day(t.o)} → ${day(t.c)}  ${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`;

function summary(r) {
  const rets = dailyReturnsFromEquity(r.equity, r.start, r.deposits, Date.parse(r.from));
  const days = [...rets.keys()].sort((a, b) => a - b).filter((d) => d * 86_400_000 >= since);
  let tw = 1; let pk = 1; let dd = 0;
  for (const d of days) { tw *= 1 + rets.get(d); pk = Math.max(pk, tw); dd = Math.max(dd, 1 - tw / pk); }
  const s = sleeve(r).filter((t) => Date.parse(t.c) >= since);
  const sharpe = days.length >= 20 ? annualizedSharpe(days.map((d) => rets.get(d))).toFixed(2) : '—';
  return `return ${(100 * (tw - 1)).toFixed(1)}% · Sharpe ${sharpe} · worst drop ${(100 * dd).toFixed(1)}% · sleeve round trips ${s.length}, P&L $${s.reduce((a, t) => a + t.pnl, 0).toFixed(2)} · final $${r.equity.at(-1).balance.toFixed(2)}`;
}

const last = new Date(off.equity.at(-1).timestamp).toISOString().slice(0, 10);
console.log(`Buy-back shadow · replay ${from} → ${last} · figures from ${new Date(since).toISOString().slice(0, 10)} on`);
console.log(`  rule off (live): ${summary(off)}`);
console.log(`  rule on:         ${summary(on)}`);
const offKeys = new Set(sleeve(off).map(key));
const onKeys = new Set(sleeve(on).map(key));
const onlyOff = sleeve(off).filter((t) => !onKeys.has(key(t)) && Date.parse(t.c) >= since);
const onlyOn = sleeve(on).filter((t) => !offKeys.has(key(t)) && Date.parse(t.c) >= since);
console.log(`\nSleeve round trips only with the rule off (${onlyOff.length}):`);
for (const t of onlyOff) console.log(`  ${line(t)}`);
console.log(`Sleeve round trips only with the rule on (${onlyOn.length}):`);
for (const t of onlyOn) console.log(`  ${line(t)}`);

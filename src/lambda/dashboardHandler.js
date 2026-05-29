/**
 * AWS Lambda handler for the dashboard API.
 * Serves data from S3 state bucket to the static dashboard.
 * Invoked via API Gateway HTTP API.
 */
import { stateStore } from '../state/index.js';

export async function handler(event) {
  const { routeKey, pathParameters, body } = event;
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.requestContext?.http?.path ?? event.rawPath ?? '';

  try {
    // GET /api/status
    if (method === 'GET' && path === '/api/status') {
      const positions = await stateStore.load('positions') ?? [];
      const trades = await stateStore.load('trades') ?? [];
      const lastCycle = await stateStore.load('lastCycle');

      // Calculate balance from last trade or default
      const lastTrade = trades.filter(t => t.balance > 0).pop();
      const balance = lastTrade?.balance ?? 0;
      const totalPnL = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

      return respond(200, {
        mode: process.env.PAPER_MODE === 'true' ? 'paper' : 'live',
        balance,
        positions: positions.map(p => ({
          symbol: p.symbol,
          qty: p.qty,
          entryPrice: p.entryPrice,
          stopLoss: p.stopLoss,
          takeProfit: p.takeProfit,
          highWaterMark: p.highWaterMark,
          openedAt: p.openedAt,
        })),
        totalPnL: Number(totalPnL.toFixed(2)),
        openPositions: positions.length,
        lastCycle: lastCycle?.timestamp ?? null,
      });
    }

    // GET /api/trades
    if (method === 'GET' && path === '/api/trades') {
      const trades = await stateStore.load('trades') ?? [];
      return respond(200, trades);
    }

    // GET /api/deposits
    if (method === 'GET' && path === '/api/deposits') {
      const deposits = await stateStore.load('deposits') ?? [];
      return respond(200, deposits);
    }

    // POST /api/deposits
    if (method === 'POST' && path === '/api/deposits') {
      const payload = JSON.parse(body ?? '{}');
      const { amount, note, date } = payload;

      if (!amount || isNaN(Number(amount)) || Number(amount) === 0) {
        return respond(400, { error: 'amount required (non-zero number)' });
      }

      const deposits = await stateStore.load('deposits') ?? [];
      const entry = {
        id: Date.now(),
        date: date || new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        amount: Number(amount),
        note: note || '',
      };
      deposits.push(entry);
      await stateStore.save('deposits', deposits);

      return respond(200, entry);
    }

    // DELETE /api/deposits/{id}
    if (method === 'DELETE' && path.startsWith('/api/deposits/')) {
      const id = Number(pathParameters?.id ?? path.split('/').pop());
      const deposits = await stateStore.load('deposits') ?? [];
      const idx = deposits.findIndex(d => d.id === id);

      if (idx === -1) return respond(404, { error: 'deposit not found' });

      deposits.splice(idx, 1);
      await stateStore.save('deposits', deposits);

      return respond(200, { ok: true });
    }

    return respond(404, { error: 'not found' });
  } catch (err) {
    console.error(`[DashboardAPI] Error: ${err.message}`, err.stack);
    return respond(500, { error: err.message });
  }
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify(body),
  };
}

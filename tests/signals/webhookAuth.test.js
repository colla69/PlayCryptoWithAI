/**
 * Webhook authentication.
 *
 * Signals posted to this server become votes in the LIVE aggregator, and open
 * positions exit at a lowered threshold — so an unauthenticated poster could
 * force a position dump at market. The server ran exactly that way (open, on
 * host-networked port 3000, enabled by default) from the first commit until
 * 2026-07-29. These tests pin the lockdown: no token → server refuses to start;
 * wrong/missing header → 401 and NOTHING reaches the signal bus.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { startWebhookServer } from '../../src/signals/webhookServer.js';
import signalBus from '../../src/signals/signalBus.js';
import config from '../../config/default.js';

const TOKEN = 'test-secret-token';
const servers = [];

/** Start on an ephemeral port; resolve the bound port. */
function listen(opts) {
  const app = startWebhookServer(0, opts);
  if (!app) return Promise.resolve({ app: null, port: null });
  servers.push(app.server);
  return new Promise((resolve) => {
    app.server.on('listening', () => resolve({ app, port: app.server.address().port }));
  });
}

after(() => { for (const s of servers) s.close(); });

describe('startWebhookServer auth', () => {
  test('webhook is disabled in the default config', () => {
    // The config flip is part of the lockdown — a fresh checkout must not
    // expose the port even before tokens enter the picture.
    assert.equal(config.signals.webhook.enabled, false);
  });

  test('refuses to start without a token', () => {
    assert.equal(startWebhookServer(0, { token: undefined }), null);
    assert.equal(startWebhookServer(0, { token: '' }), null);
    assert.equal(startWebhookServer(0, { token: '   ' }), null);
  });

  test('rejects a missing token header with 401 and emits nothing', async () => {
    const { port } = await listen({ token: TOKEN });
    let emitted = 0;
    const spy = () => { emitted += 1; };
    signalBus.on('signal', spy);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'BTC/USDC', action: 'sell', confidence: 0.9 }),
      });
      assert.equal(res.status, 401);
      assert.equal(emitted, 0, 'unauthenticated signal must never reach the bus');
    } finally {
      signalBus.off('signal', spy);
    }
  });

  test('rejects a wrong token on both signal routes', async () => {
    const { port } = await listen({ token: TOKEN });
    for (const route of ['/signal', '/tradingview']) {
      const res = await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-token': 'wrong' },
        body: JSON.stringify({ symbol: 'BTC/USDC', action: 'buy' }),
      });
      assert.equal(res.status, 401, `${route} must reject a wrong token`);
    }
  });

  test('accepts a valid token and delivers the signal to the bus', async () => {
    const { port } = await listen({ token: TOKEN });
    const received = [];
    const spy = (s) => received.push(s);
    signalBus.on('signal', spy);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/signal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
        body: JSON.stringify({ symbol: 'BTC/USDC', action: 'buy', confidence: 0.7 }),
      });
      assert.equal(res.status, 200);
      assert.equal(received.length, 1);
      assert.equal(received[0].symbol, 'BTC/USDC');
      assert.equal(received[0].signal, 'BUY');
    } finally {
      signalBus.off('signal', spy);
    }
  });

  test('authenticated but malformed payload is a 400, not a crash', async () => {
    const { port } = await listen({ token: TOKEN });
    const res = await fetch(`http://127.0.0.1:${port}/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-token': TOKEN },
      body: JSON.stringify({ nonsense: true }),
    });
    assert.equal(res.status, 400);
  });

  test('health stays open — liveness only, no signal path', async () => {
    const { port } = await listen({ token: TOKEN });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
  });
});

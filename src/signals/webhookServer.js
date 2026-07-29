import crypto from 'crypto';
import express from 'express';
import signalBus from './signalBus.js';
import { parseWebhookPayload } from './signalParser.js';
import logger from '../utils/logger.js';

/**
 * Constant-time shared-secret check. A plain `===` leaks match length via
 * timing; `timingSafeEqual` needs equal-length buffers, so hash both sides.
 */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || !presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function createSignalHandler(source) {
  return (req, res) => {
    try {
      const parsedSignal = parseWebhookPayload(req.body, source);

      if (!parsedSignal) {
        logger.warn(`${source}: invalid signal payload received`);
        return res.status(400).json({ status: 'error', message: 'Invalid signal payload' });
      }

      signalBus.emit('signal', parsedSignal);
      logger.info(
        `${parsedSignal.symbol}: received ${parsedSignal.signal} from ${parsedSignal.source} confidence=${parsedSignal.confidence}`,
      );

      return res.json({ status: 'accepted', signal: parsedSignal });
    } catch (error) {
      logger.error(`${source}: failed to process signal - ${error.message}`);
      return res.status(500).json({ status: 'error', message: 'Failed to process signal' });
    }
  };
}

/**
 * External-signal webhook server.
 *
 * SECURITY: signals posted here become VOTES in the live aggregator (weight
 * `signals.webhook.weight`), and open positions exit at a lowered threshold —
 * an unauthenticated poster could force a position dump at market. This server
 * therefore REFUSES to start without a shared secret (`WEBHOOK_TOKEN` env), and
 * every signal route requires it in the `x-webhook-token` header. It ran open
 * on port 3000 (host-networked in Docker) from the first commit until
 * 2026-07-29; never reintroduce an unauthenticated path to the signal bus.
 *
 * `/health` stays unauthenticated — it exposes only liveness.
 *
 * @param {number} port
 * @param {{token?: string}} [opts] token override for tests; defaults to WEBHOOK_TOKEN
 * @returns {import('express').Express|null} null when refusing to start (no token)
 */
export function startWebhookServer(port = 3000, { token = process.env.WEBHOOK_TOKEN } = {}) {
  if (!token || !String(token).trim()) {
    logger.error(
      'Webhook server NOT started: signals.webhook.enabled is true but WEBHOOK_TOKEN is unset. '
      + 'External signals vote in the live aggregator — an open port is a vote-injection surface. '
      + 'Set WEBHOOK_TOKEN in .env (and send it as the x-webhook-token header) to enable.',
    );
    return null;
  }
  const secret = String(token).trim();

  const app = express();
  app.use(express.json());

  // Auth precedes parsing/handling on every signal route.
  const requireToken = (req, res, next) => {
    if (tokenMatches(req.get('x-webhook-token'), secret)) return next();
    logger.warn(`webhook: rejected unauthenticated ${req.method} ${req.path} from ${req.ip}`);
    return res.status(401).json({ status: 'error', message: 'Missing or invalid x-webhook-token' });
  };

  app.post('/signal', requireToken, createSignalHandler('webhook'));
  app.post('/tradingview', requireToken, createSignalHandler('tradingview'));

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError) {
      logger.warn(`webhook: invalid JSON payload - ${error.message}`);
      return res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }

    return next(error);
  });

  const server = app.listen(port, () => logger.info(`Webhook server listening on port ${port} (token auth required)`));
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Webhook port ${port} already in use — webhook disabled. Change WEBHOOK_PORT in .env`);
    } else {
      logger.error(`Webhook server error: ${err.message}`);
    }
  });
  app.server = server;
  return app;
}

export default startWebhookServer;

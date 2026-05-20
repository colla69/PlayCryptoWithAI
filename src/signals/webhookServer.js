import express from 'express';
import signalBus from './signalBus.js';
import { parseWebhookPayload } from './signalParser.js';
import logger from '../utils/logger.js';

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

export function startWebhookServer(port = 3000) {
  const app = express();
  app.use(express.json());

  app.post('/signal', createSignalHandler('webhook'));
  app.post('/tradingview', createSignalHandler('tradingview'));

  app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  app.use((error, req, res, next) => {
    if (error instanceof SyntaxError) {
      logger.warn(`webhook: invalid JSON payload - ${error.message}`);
      return res.status(400).json({ status: 'error', message: 'Invalid JSON payload' });
    }

    return next(error);
  });

  const server = app.listen(port, () => logger.info(`Webhook server listening on port ${port}`));
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

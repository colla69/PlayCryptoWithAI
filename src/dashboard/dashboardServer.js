import fs from 'fs';
import path from 'path';
import express from 'express';
import dashboardState from './dashboardState.js';
import logger from '../utils/logger.js';
import { Backtester } from '../backtester/index.js';
import {
  ADXStrategy,
  BollingerBandsStrategy,
  CCIStrategy,
  EMAStrategy,
  MACDStrategy,
  RSIStrategy,
  STRATEGY_REGISTRY,
  StochasticStrategy,
} from '../strategies/index.js';
import { calculateMetrics } from '../backtester/metrics.js';
import { fetchOHLCV } from '../exchange/binanceClient.js';
import defaultConfig from '../../config/default.js';

const clients = new Set();
const HEARTBEAT_MS = 15_000;
const publicDir = path.resolve(process.cwd(), 'public');
const indexPath = path.join(publicDir, 'index.html');
const packageJsonPath = path.resolve(process.cwd(), 'package.json');
const packageVersion = fs.existsSync(packageJsonPath)
  ? JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version
  : '0.0.0';

let serverInstance = null;
let heartbeatId = null;

function startHeartbeat() {
  if (heartbeatId) {
    return;
  }

  heartbeatId = setInterval(() => {
    for (const client of clients) {
      client.write(':\n\n');
    }
  }, HEARTBEAT_MS);
  heartbeatId.unref?.();
}

function stopHeartbeatIfIdle() {
  if (clients.size > 0 || !heartbeatId) {
    return;
  }

  clearInterval(heartbeatId);
  heartbeatId = null;
}

export function pushEvent(eventName, data) {
  if (!clients.size) {
    return;
  }

  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

  for (const client of clients) {
    client.write(payload);
  }
}

export function startDashboardServer(port = 3001) {
  if (serverInstance) {
    return serverInstance;
  }

  const app = express();
  app.use(express.json());
  // Serve static files with no caching so dashboard changes take effect on browser refresh
  app.use(express.static(publicDir, { etag: false, lastModified: false, setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }}));

  app.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexPath);
  });

  const sendSummary = (_req, res) => {
    res.json(dashboardState.getSummary());
  };

  const sendSignals = (_req, res) => {
    res.json(dashboardState.getSummary().signalFeed ?? []);
  };

  const sendTrades = (_req, res) => {
    res.json(dashboardState.getSummary().trades ?? []);
  };

  const sendCandles = (symbol, res) => {
    const candles = dashboardState.getCandles(symbol);
    res.json({ symbol, candles, count: candles.length });
  };

  app.get(['/api/status', '/status'], sendSummary);
  app.get(['/api/signals', '/signals'], sendSignals);

  app.get('/api/strategies', (_req, res) => {
    res.json(dashboardState.getSummary().strategyRegistry ?? []);
  });

  app.get(['/api/trades', '/trades'], sendTrades);

  app.get('/api/health', (_req, res) => {
    const summary = dashboardState.getSummary();
    res.json({
      status: 'ok',
      uptime: summary.uptimeMs,
      startTime: summary.startTime,
      cycleCount: summary.cycleCount,
      version: packageVersion,
    });
  });

  app.get('/api/symbols', (_req, res) => {
    res.json(defaultConfig.symbols);
  });

  app.post('/api/backtest', async (req, res) => {
    const { symbol = 'BTC/USDT', timeframe = '1h', limit = 300, trailing = false, strategies: strategyIds } = req.body ?? {};

    try {
      if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ error: 'Invalid symbol' });
      }

      const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 300, 60), 1000);
      const candles = await fetchOHLCV(symbol, timeframe, parsedLimit);
      if (candles.length < 60) {
        return res.status(400).json({ error: 'Not enough candles returned' });
      }

      const strategyFactories = {
        rsi: () => new RSIStrategy(defaultConfig.rsi),
        ema: () => new EMAStrategy(defaultConfig.ema),
        macd: () => new MACDStrategy(defaultConfig.macd),
        bollinger: () => new BollingerBandsStrategy(defaultConfig.bollinger),
        stochastic: () => new StochasticStrategy(defaultConfig.stochastic),
        adx: () => new ADXStrategy(defaultConfig.adx),
        cci: () => new CCIStrategy(defaultConfig.cci),
      };
      const availableStrategyIds = STRATEGY_REGISTRY
        .filter((entry) => (entry.type ?? 'strategy') === 'strategy' && strategyFactories[entry.id])
        .map((entry) => entry.id);
      const selectedIds = Array.isArray(strategyIds) && strategyIds.length > 0
        ? strategyIds.filter((id) => availableStrategyIds.includes(id))
        : ['rsi', 'ema'];
      const strategyInstances = selectedIds.map((id) => strategyFactories[id]()).filter(Boolean);

      if (!strategyInstances.length) {
        return res.status(400).json({ error: 'No valid strategies selected' });
      }

      const riskConfig = { ...defaultConfig.risk };
      if (trailing) {
        riskConfig.trailingStopPct = defaultConfig.risk.trailingStopPct ?? 0.015;
      } else {
        riskConfig.trailingStopPct = undefined;
      }

      const backtester = new Backtester(strategyInstances, { ...defaultConfig, risk: riskConfig });
      const result = await backtester.run(symbol, candles);
      const metrics = calculateMetrics(result.trades, result.equity, result.initialBalance);

      return res.json({
        symbol,
        timeframe,
        candleCount: candles.length,
        strategies: selectedIds,
        trailing,
        metrics,
        trades: result.trades.slice(-50).reverse(),
        equity: result.equity,
        initialBalance: result.initialBalance,
        finalBalance: result.finalBalance,
      });
    } catch (error) {
      logger.error(`Backtest API error: ${error.message}`);
      return res.status(500).json({ error: error.message });
    }
  });

  app.get(['/api/candles', '/candles'], (req, res) => {
    const symbol = String(req.query.symbol || 'BTC/USDT');
    sendCandles(symbol, res);
  });

  app.get('/candles/:symbol', (req, res) => {
    sendCandles(String(req.params.symbol || 'BTC/USDT'), res);
  });

  app.get(['/api/events', '/events'], (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');

    clients.add(res);
    startHeartbeat();
    res.write(`event: cycle\ndata: ${JSON.stringify(dashboardState.getSummary())}\n\n`);

    req.on('close', () => {
      clients.delete(res);
      stopHeartbeatIfIdle();
      res.end();
    });
  });

  serverInstance = app.listen(port, () => {
    logger.info(`Dashboard running at http://localhost:${port}`);
  });

  serverInstance.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Dashboard port ${port} already in use — dashboard disabled. Kill the old process or change DASHBOARD_PORT in .env`);
    } else {
      logger.error(`Dashboard server error: ${err.message}`);
    }
  });

  return serverInstance;
}

export default {
  startDashboardServer,
  pushEvent,
};

# playAIStocks

Phase 1 crypto paper-trading bot for Binance market data using RSI and EMA crossover signals.

## Features
- Node.js ES modules
- Binance market data via `ccxt`
- RSI-14 and EMA 12/26 strategies
- Signal aggregation with confidence scoring
- Paper trading with stop loss / take profit
- Winston logging and CSV trade journal

## Setup
1. Copy `.env.example` to `.env`
2. Add Binance API credentials if you want authenticated balance access
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start in paper mode:
   ```bash
   npm run paper
   ```

## Scripts
- `npm start` - runs the bot using current env settings
- `npm run paper` - forces paper mode

## Logs
- Application logs: `logs/app.log`
- Trade journal: `logs/trades.csv`

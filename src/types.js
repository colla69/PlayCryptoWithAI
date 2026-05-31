/**
 * Shared type definitions for the playAIStocks trading bot.
 * Import this file for JSDoc type hints — no runtime code.
 *
 * Usage in any module:
 *   import './types.js'; // activate typedefs for IDE
 *   // then use: /** @type {Candle[]} *\/
 */

/**
 * @typedef {object} Candle
 * @property {number} timestamp - Unix ms
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {object} Position
 * @property {number} qty - Quantity of base asset held
 * @property {number} entryPrice - Fill price at entry
 * @property {number} stopLoss - Current stop-loss price
 * @property {number} takeProfit - Take-profit target price
 * @property {number} initialStopLoss - Original SL before trailing/break-even adjustments
 * @property {number} highWaterMark - Highest price seen since entry (for trailing stop)
 * @property {number} [trailingStopPct] - Trailing stop percentage (undefined if disabled)
 * @property {string} openedAt - ISO timestamp when position was opened
 * @property {number} [currentPrice] - Last known price (paper trader only)
 * @property {string} [orderId] - Exchange order ID (live trader only)
 */

/**
 * @typedef {object} TradeResult
 * @property {string} symbol - Trading pair (e.g. 'BTC/USDC')
 * @property {'BUY'|'SELL'} side
 * @property {number} qty
 * @property {number} [entryPrice] - Present on BUY results
 * @property {number} [exitPrice] - Present on SELL results
 * @property {number} [pnl] - Realized P&L (SELL only)
 * @property {string} [reason] - Exit reason: 'stop_loss'|'take_profit'|'trailing_stop'|'strategy_sell'
 * @property {string} timestamp - ISO timestamp
 * @property {number} balance - Quote balance after trade
 * @property {string} [openedAt] - When the position was originally opened
 * @property {number} [stopLoss] - SL level (BUY result)
 * @property {number} [takeProfit] - TP level (BUY result)
 */

/**
 * @typedef {object} RiskConfig
 * @property {number} initialBalance - Starting capital
 * @property {number} maxPositionPct - Max fraction of balance per trade (0-1)
 * @property {number} stopLossPct - Stop-loss distance from entry (0-1)
 * @property {number} takeProfitPct - Take-profit distance from entry (0-1)
 * @property {number} [trailingStopPct] - Trailing stop pct (0 = disabled)
 * @property {number} [breakEvenTriggerPct] - Move SL to entry after this % gain
 * @property {number} maxDailyLossPct - Max daily loss as fraction of balance
 * @property {number} maxOpenPositions - Concurrent position limit
 * @property {number} minConfidence - Minimum aggregator confidence to allow trade
 */

/**
 * @typedef {object} StrategyResult
 * @property {string} name - Strategy identifier (e.g. 'RSI', 'BB')
 * @property {'BUY'|'SELL'|'HOLD'} signal
 * @property {number} confidence - 0 to 1
 * @property {string} reason - Human-readable explanation
 * @property {number} [value] - Indicator value (optional)
 */

/**
 * @typedef {object} AggregatorResult
 * @property {'BUY'|'SELL'|'HOLD'} decision - Final aggregated decision
 * @property {number} confidence - Weighted confidence score
 * @property {StrategyResult[]} signals - Individual strategy outputs
 * @property {object[]} externalSignals - External signal inputs (webhook/telegram)
 */

/**
 * @typedef {object} TraderStatus
 * @property {number} balance - Current quote currency balance
 * @property {Array<Position & {symbol: string}>} positions - Open positions
 * @property {number} totalPnL - Cumulative realized P&L
 */

export {};

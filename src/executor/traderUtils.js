/**
 * Shared trader utilities — pure calculation functions used by both PaperTrader and LiveTrader.
 * No side effects, no I/O, no logging — callers handle mutations and logging.
 */

const roundPrice = (value) => Number(Number(value ?? 0).toFixed(8));

/**
 * Determine if trailing stop should be updated.
 * @param {{entryPrice: number, highWaterMark: number, stopLoss: number, trailingStopPct?: number}} position
 * @param {number} currentPrice
 * @returns {{shouldUpdate: boolean, newHighWaterMark?: number, newStopLoss?: number}}
 */
export function calcTrailingStop(position, currentPrice) {
  if (!position || !position.trailingStopPct) {
    return { shouldUpdate: false };
  }

  if (currentPrice <= position.entryPrice || currentPrice <= position.highWaterMark) {
    return { shouldUpdate: false };
  }

  const newHighWaterMark = roundPrice(currentPrice);
  const newStopLoss = roundPrice(currentPrice * (1 - position.trailingStopPct));

  if (newStopLoss > position.stopLoss) {
    return { shouldUpdate: true, newHighWaterMark, newStopLoss };
  }

  return { shouldUpdate: false, newHighWaterMark };
}

/**
 * Determine if break-even stop should be triggered.
 * @param {{entryPrice: number, stopLoss: number}} position
 * @param {number} currentPrice
 * @param {number} breakEvenTriggerPct - e.g. 0.05 for 5%
 * @returns {{shouldTrigger: boolean, newStopLoss?: number}}
 */
export function calcBreakEven(position, currentPrice, breakEvenTriggerPct) {
  const bePct = Number(breakEvenTriggerPct ?? 0);
  if (bePct <= 0 || position.stopLoss >= position.entryPrice) {
    return { shouldTrigger: false };
  }

  if (currentPrice >= position.entryPrice * (1 + bePct)) {
    // Lock stop above entry to cover round-trip trading fees (~0.2%)
    return { shouldTrigger: true, newStopLoss: roundPrice(position.entryPrice * 1.002) };
  }

  return { shouldTrigger: false };
}

/**
 * Determine exit reason based on current price vs stop-loss and take-profit.
 * @param {{stopLoss: number, takeProfit: number, initialStopLoss: number, trailingStopPct?: number}} position
 * @param {number} currentPrice
 * @returns {{shouldExit: boolean, reason?: 'stop_loss'|'trailing_stop'|'take_profit'}}
 */
export function calcExitSignal(position, currentPrice) {
  if (currentPrice <= position.stopLoss) {
    const reason = position.trailingStopPct && position.stopLoss > position.initialStopLoss
      ? 'trailing_stop'
      : 'stop_loss';
    return { shouldExit: true, reason };
  }

  if (currentPrice >= position.takeProfit) {
    return { shouldExit: true, reason: 'take_profit' };
  }

  return { shouldExit: false };
}

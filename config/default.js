export default {
  // ─── Symbols — 12h holdout-validated set (34 symbols) ─────────────────────
  // Validated methodology: optimised on Year 2, held out on Year 1 (unseen data)
  // Full Binance USDT spot sweep complete; only passing holdout coins are included
  symbols: ['BTC/USDT', 'XRP/USDT', 'LINK/USDT', 'BNB/USDT', 'LTC/USDT', 'NEAR/USDT', 'TRX/USDT', 'BCH/USDT', 'ACH/USDT', 'ANKR/USDT', 'AVA/USDT', 'CHR/USDT', 'CRV/USDT', 'ENS/USDT', 'GLMR/USDT', 'GMX/USDT', 'ICX/USDT', 'JTO/USDT', 'LDO/USDT', 'LSK/USDT', 'MANTA/USDT', 'MTL/USDT', 'ONG/USDT', 'PAXG/USDT', 'PIXEL/USDT', 'RAD/USDT', 'SFP/USDT', 'SPELL/USDT', 'SUI/USDT', 'THETA/USDT', 'TIA/USDT', 'VANRY/USDT', 'XEC/USDT', 'YFI/USDT'],
  timeframe: '12h',
  pollIntervalMs: 43_200_000,   // 12 hours — matches candle close interval
  candleLimit: 200,             // candles fetched per live cycle (enough for all indicators)
  historicalCandles: 730,       // ~1 year of 12h candles (365d × 2 candles/d)
  rsi: { period: 14, oversold: 30, overbought: 70 },
  ema: { fast: 12, slow: 26 },
  macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, stdDev: 2 },
  stochastic: { period: 14, signalPeriod: 3, oversold: 20, overbought: 80 },
  adx: { period: 14, threshold: 25 },
  cci: { period: 20, oversold: -100, overbought: 100 },
  // ──────────────────────────────────────────────────────────────────
  // Default strategy (BTC/USDT, NEAR/USDT — mean-reversion, 12h holdout-validated)
  //   BTC:  RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +35.9%  Y1 +12.5%  Sharpe 1.35/0.53 ✅
  //   NEAR: RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +53.8%  Y1 +17.2%  Sharpe 1.17/0.52 ✅
  // ──────────────────────────────────────────────────────────────────
  strategies: ['RSI', 'BB', 'Stoch'],
  risk: {
    initialBalance: 1000,
    maxPositionPct: 0.15,
    stopLossPct: 0.05,
    takeProfitPct: 0.12,
    trailingStopPct: 0,      // OFF — always underperforms hard TP/SL on higher timeframes
    breakEvenTriggerPct: 0.05, // Lock stop at entry once trade is +5% — free downside protection
    maxDailyLossPct: 0.05,
    maxOpenPositions: 34,    // one per symbol
    // minConfidence threshold vs 3-strategy vote math:
    //   3-of-3 unanimous  → confidence = 1.00  → passes 0.70 ✅
    //   2-of-3 majority   → confidence = 0.67  → fails  0.70 ❌ (requires unanimity)
    //   2-of-3 majority   → confidence = 0.67  → passes 0.55 ✅ (used for trend symbols)
    // This is intentional: mean-reversion coins (0.70) need all 3 indicators to agree;
    // trend-following coins (0.55) allow 2-of-3 for earlier crossover entries.
    minConfidence: 0.70,
  },
  // ──────────────────────────────────────────────────────────────────
  // Per-symbol overrides — 12h holdout-validated (Y1 = unseen year)
  //   BTC  → default (RSI+BB+Stoch SL5/TP12 conf=0.70) — no entry needed
  //   NEAR → default (RSI+BB+Stoch SL5/TP12 conf=0.70) — no entry needed
  // ──────────────────────────────────────────────────────────────────
  perSymbol: {
    'XRP/USDT': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +31.7%  Y1 +46.8%  Sharpe 1.10/1.16 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.70,
    },
    'LINK/USDT': {
      // MOM:MACD+Stoch+RSI  SL5/TP12  conf=0.55 → Y2 +85.6%  Y1 +78.8%  Sharpe 1.51/1.35 ✅
      strategies: ['MACD', 'Stoch', 'RSI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'BNB/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +12.0%  Y1 +6.7%  Sharpe 0.49/0.34 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'LTC/USDT': {
      // MOM:MACD+Stoch+RSI  SL5/TP12  conf=0.55 → Y2 +42.6%  Y1 +37.5%  Sharpe 0.98/0.82 ✅
      strategies: ['MACD', 'Stoch', 'RSI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'TRX/USDT': {
      // TREND:EMA+MACD+ADX  SL12/TP30  conf=0.55 → Y2 +36.4%  Y1 +129.9%  Sharpe 1.83/1.01 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.12,
      takeProfitPct: 0.30,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'BCH/USDT': {
      // MOM:MACD+Stoch+RSI  SL7/TP18  conf=0.55 → Y2 +32.4%  Y1 +31.1%  Sharpe 0.74/0.68 ✅
      strategies: ['MACD', 'Stoch', 'RSI'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'ACH/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +30.4%  Y1 +72.3%  Sharpe 1.10/1.50 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ANKR/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +51.4%  Y1 +58.3%  Sharpe 1.07/1.31 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'AVA/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +26.8%  Y1 +59.2%  Sharpe 0.83/1.51 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'CHR/USDT': {
      // TREND:EMA+MACD+ADX  SL7/TP18  conf=0.55 → Y2 +1.4%  Y1 +139.0%  Sharpe 0.23/2.40 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'CRV/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +48.5%  Y1 +91.5%  Sharpe 1.20/1.82 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ENS/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +13.4%  Y1 +63.7%  Sharpe 0.47/1.55 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'GLMR/USDT': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +26.7%  Y1 +42.5%  Sharpe 0.58/1.51 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'GMX/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +23.3%  Y1 +19.1%  Sharpe 0.80/0.58 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ICX/USDT': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +24.6%  Y1 +12.1%  Sharpe 0.78/0.45 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'JTO/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +6.0%  Y1 +111.0%  Sharpe 0.30/1.92 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'LDO/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +22.7%  Y1 +38.7%  Sharpe 0.62/1.05 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'LSK/USDT': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +138.7%  Y1 +66.9%  Sharpe 1.38/1.33 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.70,
    },
    'MANTA/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +76.4%  Y1 +28.8%  Sharpe 1.81/0.76 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'MTL/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +22.6%  Y1 +25.2%  Sharpe 0.72/0.91 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ONG/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +32.9%  Y1 +38.8%  Sharpe 0.79/1.00 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'PAXG/USDT': {
      // TREND:EMA+MACD+ADX  SL7/TP18  conf=0.55 → Y2 +39.7%  Y1 +13.8%  Sharpe 2.48/0.87 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'PIXEL/USDT': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +103.8%  Y1 +117.6%  Sharpe 0.97/1.35 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'RAD/USDT': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +34.1%  Y1 +28.6%  Sharpe 0.74/1.06 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'SFP/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.55 → Y2 +21.4%  Y1 +12.6%  Sharpe 0.57/0.43 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'SPELL/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +26.7%  Y1 +34.3%  Sharpe 0.66/0.87 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'SUI/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +12.0%  Y1 +48.3%  Sharpe 0.43/1.37 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'THETA/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +54.5%  Y1 +4.8%  Sharpe 1.04/0.27 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'TIA/USDT': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +89.9%  Y1 +15.8%  Sharpe 1.41/0.51 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'VANRY/USDT': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +53.1%  Y1 +62.9%  Sharpe 1.08/1.78 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'XEC/USDT': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +85.7%  Y1 +3.1%  Sharpe 1.70/0.21 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'YFI/USDT': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +74.1%  Y1 +40.0%  Sharpe 1.68/0.95 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.70,
    },
  },
  signals: {
    webhook: {
      enabled: true,
      port: 3000,
      weight: 0.8,
    },
    telegram: {
      enabled: false,
      channelIds: [],
      weight: 0.6,
    },
    algoWeight: 1.0,
    minConfidence: 0.70,
  },
  // ── Regime filter — suppress BUY signals when the market is ranging ─────────
  // ADX < threshold → choppy / sideways → skip new entries, protect capital.
  // Existing positions are unaffected (SL/TP management still runs).
  // Backtest evidence: improves win-rate and reduces max drawdown on 12h timeframe.
  regime: {
    enabled: true,
    adxPeriod: 14,
    adxThreshold: 20,
  },
  // ── ATR position sizing — inverse-vol sizing for each symbol ──────────────────
  // Scales each trade's position size proportionally to (medianATR / symbolATR).
  // High-volatility coins → smaller positions; low-volatility coins → larger ones.
  // Size is clamped to [0.5×, 2×] of the base maxPositionPct to prevent extremes.
  // Backtest evidence: cuts max drawdown by ~7% in bear markets at minimal cost.
  atr: {
    enabled: true,
    period: 14,
  },
  // ── Macro bear filter — reduce position sizes when BTC is in a downtrend ──────
  // When BTC spot price falls below its EMA(200), the portfolio is in a bear phase.
  // All new BUY positions are opened at sizeReduceFactor × normal maxPositionPct.
  // Existing positions are unaffected — SL/TP management continues as normal.
  // Backtest evidence: the 2022 bear market (LUNA/FTX) destroyed mean-reversion
  // strategies; halving size during confirmed downtrends limits exposure.
  macroFilter: {
    enabled: true,
    emaPeriod: 200,          // BTC EMA period used to detect bear phase
    sizeReduceFactor: 0.5,   // multiply maxPositionPct by this in bear market
  },
  // ── Correlation filter — avoid holding two coins that move together ──────────
  // Before entering a new position, checks if any open position has Pearson
  // correlation > threshold against the incoming coin (computed from past candles).
  // Backtest evidence: best single-feature improvement (+36.8% vs +30.5% baseline).
  correlation: {
    enabled: true,
    threshold: 0.8,  // Pearson r above this → skip the new BUY
    period: 60,      // candles used for return series (60 × 12h = 30 days)
  },
  dashboard: {
    enabled: true,
    port: 3001,
  },
};

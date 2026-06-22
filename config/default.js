export default {
  // ─── Symbols — 12h holdout-validated set (22 symbols, USDC pairs) ────────────
  // 11 coins dropped: AVA, CHR, GLMR, ICX, MTL, ONG, RAD, SFP, SPELL, XEC, YFI
  // — no USDC spot pair available on Binance (EU USDT restriction)
  // ANKR also dropped: listed in Binance markets but has no USDC candle data
  // ─── Symbols — 12h holdout-validated set (38 symbols, USDC pairs) ────────────
  // 11 coins dropped: AVA, CHR, GLMR, ICX, MTL, ONG, RAD, SFP, SPELL, XEC, YFI
  // — no USDC spot pair available on Binance (EU USDT restriction)
  // ANKR also dropped: listed in Binance markets but has no USDC candle data
  // 2025-05 addition: +11 new coins (optimizer-validated, ≥3 holdout trades each)
  //   Dropped from candidate list:
  //   ZEC  — optimizer upgrade had only 3 holdout trades; 28% WR in backtest → Sharpe killer
  //   FTM  — insufficient history (1005 candles < 1460 required for Y1+Y2 split)
  //   XLM  — no optimizer upgrade found (best alt was -13.7% holdout)
  //   FET  — no optimizer upgrade found (best alt was -5.6% holdout)
  //   DOT  — no optimizer upgrade found (best alt was -0.1% holdout)
  //   AAVE — no optimizer upgrade found (best alt was -5.9% holdout)
  //   MATIC— insufficient history (515 candles < 1460 required)
  symbols: ['BTC/USDC', 'XRP/USDC', 'LINK/USDC', 'BNB/USDC', 'LTC/USDC', 'NEAR/USDC', 'TRX/USDC', 'BCH/USDC', 'ACH/USDC', 'CRV/USDC', 'ENS/USDC', 'GMX/USDC', 'JTO/USDC', 'LDO/USDC', 'LSK/USDC', 'MANTA/USDC', 'PAXG/USDC', 'PIXEL/USDC', 'SUI/USDC', 'THETA/USDC', 'TIA/USDC', 'VANRY/USDC', 'SOL/USDC', 'ADA/USDC', 'AVAX/USDC', 'DOGE/USDC', 'INJ/USDC', 'ETH/USDC', 'WLD/USDC', 'PEPE/USDC', 'TON/USDC', 'RENDER/USDC', 'ENA/USDC', 'ICP/USDC', 'APT/USDC', 'ARB/USDC', 'JUP/USDC'],
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
  supertrend: { period: 10, multiplier: 3.0 },
  mfi:        { period: 14, oversold: 20, overbought: 80 },
  obv:        { emaPeriod: 20 },
  psar:       { step: 0.02, max: 0.2 },
  williamsR:  { period: 14, oversold: -80, overbought: -20 },
  supportResistance: { lookback: 2000, swingWindow: 5, zoneTolerance: 0.005, minTouches: 2, nearZonePct: 0.015 },
  // ──────────────────────────────────────────────────────────────────
  // Default strategy (BTC/USDC, NEAR/USDC — mean-reversion, 12h holdout-validated)
  //   BTC:  RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +35.9%  Y1 +12.5%  Sharpe 1.35/0.53 ✅
  //   NEAR: RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +53.8%  Y1 +17.2%  Sharpe 1.17/0.52 ✅
  // ──────────────────────────────────────────────────────────────────
  strategies: ['RSI', 'BB', 'Stoch', 'SR'],
  risk: {
    initialBalance: 1000,
    maxPositionPct: 0.15,
    stopLossPct: 0.05,
    takeProfitPct: 0.12,
    trailingStopPct: 0,      // OFF — always underperforms hard TP/SL on higher timeframes
    breakEvenTriggerPct: 0.05, // Lock stop at entry once trade is +5% — free downside protection
    maxDailyLossPct: 0.05,
    maxOpenPositions: 4,     // Post-fix sweep (commits 6113b0e/5952815, 2026-06-22):
                              //   slots=3 mtf=0.50  Y2 +111% Sh 2.17 DD -17%  OOS +84% Sh 1.83 DD -14%
                              //   slots=4 mtf=0.55  Y2  +70% Sh 2.19 DD  -7%  OOS +78% Sh 2.22 DD  -8%  ← current
                              //   slots=4 mtf=0.45  Y2  +97% Sh 2.27 DD -13%  OOS +73% Sh 1.98 DD -15%  (more return, more DD)
    // ── Phase 1 (do_it_again_better branch) ────────────────────────────
    // OLD aggregator (pre-Phase 1, BROKEN): HOLD votes were suppressed from the
    // denominator so 2-of-3 BUY + 1 HOLD all returned confidence 1.00, making
    // minConfidence 0.55 vs 0.70 nearly indistinguishable in practice.
    // NEW aggregator (Phase 1): HOLDs count in the denominator and per-strategy
    // confidence is the vote weight, so:
    //   3-of-3 unanimous BUY all conf 1.0   → confidence = 1.00
    //   3-of-3 unanimous BUY all conf 0.6   → confidence = 0.60
    //   2-of-3 BUY conf 1.0 + 1 HOLD        → confidence = 0.67  (was 1.00)
    //   2-of-3 BUY conf 1.0 + 1 SELL        → confidence = 0.67
    //   1-of-3 BUY  + 2 HOLD                → conf 0.33, HOLD usually wins by weight
    // The per-symbol minConfidence values below were calibrated against the old
    // formula. The `confidenceThresholdScale` knob is a one-shot multiplier (0..1)
    // applied to every minConfidence in live + backtester so the bot keeps
    // trading at a sensible frequency. Phase 4 walk-forward retunes per-symbol
    // values from scratch and this should be set back to 1.0 then.
    minConfidence: 0.70,
    confidenceThresholdScale: 0.65,
    // ── ATR-based stops (Phase 1) ──────────────────────────────────────────
    // When enabled, BUY orders compute SL/TP from current ATR% instead of fixed
    // stopLossPct/takeProfitPct. Volatile coins get wider stops naturally;
    // less-volatile coins get tighter stops without losing the cushion.
    // Clamped to [minSlPct, maxSlPct] and [minTpPct, maxTpPct] to avoid extremes.
    // The same multipliers apply in live + backtester (live ≡ backtest invariant).
    atrStops: {
      enabled: true,     // turn on once baseline measured
      slMultiplier: 1.5, // SL = atrPct × 1.5
      tpMultiplier: 3.0, // TP = atrPct × 3.0  (R:R = 1:2)
      minSlPct: 0.02,    // never tighter than 2%
      maxSlPct: 0.12,    // never wider than 12%
      minTpPct: 0.04,    // never tighter than 4%
      maxTpPct: 0.30,    // never wider than 30%
    },
    // ── Two-stage exit (Phase 1) ───────────────────────────────────────────
    // When enabled, partial-close `firstStageFraction` of the position at
    // `firstStagePctOfTp` of the way to TP, then force break-even on the
    // remainder. Captures some profit on retracements without giving up
    // the runner. Only fires once per position.
    twoStageExit: {
      enabled: false,             // tested: -8pp return, -0.1 Sharpe — reverting to OFF
      firstStagePctOfTp: 0.5,     // partial close at +50% of TP target
      firstStageFraction: 0.5,    // close 50% of qty
    },
    // ── Phase 7 portfolio risk gates ──────────────────────────────────────
    // Weekly DD circuit breaker: pause new entries for `cooldownHours` after
    // the rolling 7-day P&L breaches `lossThreshold` (fraction of initial).
    // Existing positions stay managed normally (SL/TP/break-even all active).
    weeklyDDBreaker: {
      enabled: true,
      lossThreshold: 0.10,    // -10% in any 7-day window triggers
      cooldownHours: 72,      // pause new entries for 3 days
    },
    // Position aging exit: close positions open more than maxAgeBars without
    // hitting TP/SL. Frees capital sitting in sluggish trades; non-adaptive.
    positionAgingExit: {
      enabled: true,
      maxAgeBars: 14,         // 14 × 12h = 7 days
    },
  },
  // Phase 7: correlation cap on new entries — replaces the previously
  // rejected `correlation` block. The OLD impl was a routing filter
  // (try-next-symbol). The NEW one is a hard cap on the BUY itself, which
  // is what the test labelled net-negative. Re-evaluating with the new
  // confidence-weighted aggregator + a tighter threshold (0.85 vs 0.80).
  correlation: {
    enabled: true,
    threshold: 0.85,
    period: 60,
  },
  // ──────────────────────────────────────────────────────────────────
  // Per-symbol overrides — 12h holdout-validated (Y1 = unseen year)
  //   BTC  → default (RSI+BB+Stoch SL5/TP12 conf=0.70) — no entry needed
  //   NEAR → default (RSI+BB+Stoch SL5/TP12 conf=0.70) — no entry needed
  // ──────────────────────────────────────────────────────────────────
  perSymbol: {
    'BTC/USDC': {
      // ADX+PSAR+HeikinAshi  SL5/TP12  conf=0.55 → optimizer holdout: +7.7%  Sharpe 0.34 ✅
      strategies: ["EMA","PSAR","HeikinAshi"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'XRP/USDC': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +31.7%  Y1 +46.8%  Sharpe 1.10/1.16 ✅
      strategies: ["BB","Stoch","EMA"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'LINK/USDC': {
      // MOM:MACD+Stoch+RSI  SL5/TP12  conf=0.55 → Y2 +85.6%  Y1 +78.8%  Sharpe 1.51/1.35 ✅
      strategies: ["BB","Stoch","Supertrend"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'BNB/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +12.0%  Y1 +6.7%  Sharpe 0.49/0.34 ✅
      strategies: ["WilliamsR","HeikinAshi","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'LTC/USDC': {
      // MOM:MACD+Stoch+RSI  SL5/TP12  conf=0.55 → Y2 +42.6%  Y1 +37.5%  Sharpe 0.98/0.82 ✅
      strategies: ["BB","EMA","WilliamsR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'TRX/USDC': {
      // TREND:EMA+MACD+ADX  SL12/TP30  conf=0.55 → Y2 +36.4%  Y1 +129.9%  Sharpe 1.83/1.01 ✅
      strategies: ["CCI","Stoch","StochRSI"],
      stopLossPct: 0.12,
      takeProfitPct: 0.30,
      minConfidence: 0.70,
      adx: { period: 14, threshold: 20 },
    },
    'BCH/USDC': {
      // MOM:MACD+Stoch+RSI  SL7/TP18  conf=0.55 → Y2 +32.4%  Y1 +31.1%  Sharpe 0.74/0.68 ✅
      strategies: ["BB","OBV","WilliamsR"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      rsi: { period: 14, oversold: 35, overbought: 65 },
    },
    'ACH/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +30.4%  Y1 +72.3%  Sharpe 1.10/1.50 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ANKR/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +51.4%  Y1 +58.3%  Sharpe 1.07/1.31 ✅
      strategies: ["RSI","BB","CCI"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'AVA/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +26.8%  Y1 +59.2%  Sharpe 0.83/1.51 ✅
      // NOTE: No USDC pair — kept as config reference but not in symbols list
      strategies: ["BB","Stoch","WilliamsR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'CHR/USDC': {
      // TREND:EMA+MACD+ADX  SL7/TP18  conf=0.55 → Y2 +1.4%  Y1 +139.0%  Sharpe 0.23/2.40 ✅
      // NOTE: No USDC pair — kept as config reference but not in symbols list
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'CRV/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +48.5%  Y1 +91.5%  Sharpe 1.20/1.82 ✅
      strategies: ["ADX","StochRSI","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'ENS/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +13.4%  Y1 +63.7%  Sharpe 0.47/1.55 ✅
      strategies: ["BB","PSAR","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'GLMR/USDC': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +26.7%  Y1 +42.5%  Sharpe 0.58/1.51 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'GMX/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +23.3%  Y1 +19.1%  Sharpe 0.80/0.58 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'ICX/USDC': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +24.6%  Y1 +12.1%  Sharpe 0.78/0.45 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'JTO/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +6.0%  Y1 +111.0%  Sharpe 0.30/1.92 ✅
      strategies: ["CCI","PSAR","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'LDO/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +22.7%  Y1 +38.7%  Sharpe 0.62/1.05 ✅
      strategies: ["MACD","ADX","WilliamsR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'LSK/USDC': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +138.7%  Y1 +66.9%  Sharpe 1.38/1.33 ✅
      strategies: ["MACD","MFI","PSAR"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'MANTA/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +76.4%  Y1 +28.8%  Sharpe 1.81/0.76 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'MTL/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +22.6%  Y1 +25.2%  Sharpe 0.72/0.91 ✅
      strategies: ["EMA","MFI","WilliamsR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'ONG/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +32.9%  Y1 +38.8%  Sharpe 0.79/1.00 ✅
      strategies: ['RSI', 'BB', 'CCI'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'PAXG/USDC': {
      // TREND:EMA+MACD+ADX  SL7/TP18  conf=0.55 → Y2 +39.7%  Y1 +13.8%  Sharpe 2.48/0.87 ✅
      strategies: ['MACD', 'ADX', 'Supertrend'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'PIXEL/USDC': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +103.8%  Y1 +117.6%  Sharpe 0.97/1.35 ✅
      strategies: ["EMA","ADX","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'RAD/USDC': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +34.1%  Y1 +28.6%  Sharpe 0.74/1.06 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'SFP/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.55 → Y2 +21.4%  Y1 +12.6%  Sharpe 0.57/0.43 ✅
      strategies: ['RSI', 'Stoch', 'WilliamsR'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'SPELL/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +26.7%  Y1 +34.3%  Sharpe 0.66/0.87 ✅
      strategies: ["RSI","EMA","PSAR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'SUI/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +12.0%  Y1 +48.3%  Sharpe 0.43/1.37 ✅
      strategies: ["RSI","Stoch","MFI"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'THETA/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +54.5%  Y1 +4.8%  Sharpe 1.04/0.27 ✅
      strategies: ["RSI","CCI","OBV"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'TIA/USDC': {
      // MR:RSI+BB+CCI  SL5/TP12  conf=0.70 → Y2 +89.9%  Y1 +15.8%  Sharpe 1.41/0.51 ✅
      strategies: ["CCI","MACD","HeikinAshi"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'VANRY/USDC': {
      // TREND:EMA+MACD+ADX  SL5/TP12  conf=0.55 → Y2 +53.1%  Y1 +62.9%  Sharpe 1.08/1.78 ✅
      strategies: ['EMA', 'MACD', 'ADX'],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
      adx: { period: 14, threshold: 20 },
    },
    'XEC/USDC': {
      // MR:RSI+BB+Stoch  SL5/TP12  conf=0.70 → Y2 +85.7%  Y1 +3.1%  Sharpe 1.70/0.21 ✅
      strategies: ["RSI","Supertrend","OBV"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'YFI/USDC': {
      // MR:RSI+BB+Stoch  SL7/TP18  conf=0.70 → Y2 +74.1%  Y1 +40.0%  Sharpe 1.68/0.95 ✅
      strategies: ['RSI', 'BB', 'Stoch'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.70,
    },
    'SOL/USDC': {
      // BB+WilliamsR+StochRSI  SL7/TP18  conf=0.55 → optimizer holdout: +34.2%  Sharpe 0.75 ✅
      strategies: ['BB', 'WilliamsR', 'StochRSI'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'ADA/USDC': {
      // CCI+Stoch+MFI  SL5/TP12  conf=0.55 → optimizer holdout: +16.7%  Sharpe 0.42 ✅
      strategies: ["RSI","BB","CCI"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'AVAX/USDC': {
      // CCI+MFI+OBV  SL7/TP18  conf=0.55 → optimizer holdout: +47.1%  Sharpe 1.15 ✅
      strategies: ["RSI","MACD","PSAR"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'DOGE/USDC': {
      // EMA+PSAR+HeikinAshi  SL7/TP18  conf=0.55 → optimizer holdout: +11.6%  Sharpe 0.41 ✅
      strategies: ['EMA', 'PSAR', 'HeikinAshi'],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'INJ/USDC': {
      // RSI+StochRSI+HeikinAshi  SL7/TP18  conf=0.55 → optimizer holdout: +54.0%  Sharpe 0.98 ✅
      strategies: ["ADX","OBV","StochRSI"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    // ── New coins — 17 additions, optimizer-pending ────────────────────────
    // Large caps (ETH, ZEC, FTM, XLM): SL5/TP12  conf=0.70  (mean-reversion defaults)
    // Mid/small caps:                   SL7/TP18  conf=0.55  (wider stops, earlier entries)
    // strategies key omitted until perSymbolOptimizer sets it
    'ETH/USDC': {
      // CCI+Stoch+StochRSI  SL5/TP12  conf=0.70 → optimizer holdout: +9.0%  Sharpe 0.42 [4t] ✅
      strategies: ["Supertrend","MFI","SR"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.55,
    },
    'ZEC/USDC': {
      // CCI+Stoch+OBV  SL5/TP12  conf=0.70 → optimizer holdout: +19.0%  Sharpe 1.19 [3t] ✅
      strategies: ["CCI","Stoch","OBV"],
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'FTM/USDC': {
      // Skipped by optimizer — insufficient candles (1005 < 1460); uses global default
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'XLM/USDC': {
      // No upgrade found — best alt holdout was -13.7%; uses global default
      stopLossPct: 0.05,
      takeProfitPct: 0.12,
      minConfidence: 0.70,
    },
    'FET/USDC': {
      // No upgrade found — best alt holdout was -5.6%; uses global default
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'WLD/USDC': {
      // BB+CCI+ADX  SL7/TP18  conf=0.55 → optimizer holdout: +47.0%  Sharpe 1.01 [7t] ✅
      strategies: ["BB","CCI","ADX"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'PEPE/USDC': {
      // EMA+Supertrend+OBV  SL7/TP18  conf=0.55 → optimizer holdout: +56.8%  Sharpe 1.60 [4t] ✅
      strategies: ["EMA","Supertrend","OBV"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'TON/USDC': {
      // EMA+OBV+StochRSI  SL7/TP18  conf=0.55 → optimizer holdout: +17.7%  Sharpe 0.67 [4t] ✅
      strategies: ["EMA","OBV","StochRSI"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'RENDER/USDC': {
      // EMA+OBV+WilliamsR  SL7/TP18  conf=0.55 → optimizer holdout: +13.1%  Sharpe 0.85 [3t] ✅
      strategies: ["EMA","OBV","WilliamsR"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'ENA/USDC': {
      // RSI+BB+CCI  SL7/TP18  conf=0.55 → optimizer holdout: +47.6%  Sharpe 0.98 [4t] ✅
      strategies: ["RSI","BB","CCI"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'ICP/USDC': {
      // RSI+BB+Stoch  SL7/TP18  conf=0.55 → optimizer holdout: +28.8%  Sharpe 0.70 [7t] ✅
      strategies: ["RSI","BB","Stoch"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'DOT/USDC': {
      // No upgrade found — best alt holdout was -0.1%; uses global default
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'AAVE/USDC': {
      // No upgrade found — best alt holdout was -5.9%; uses global default
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'MATIC/USDC': {
      // Skipped by optimizer — insufficient candles (515 < 1460); uses global default
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'APT/USDC': {
      // BB+Stoch+MFI  SL7/TP18  conf=0.55 → optimizer holdout: +139.7%  Sharpe 2.02 [8t] ✅
      strategies: ["BB","Stoch","MFI"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'ARB/USDC': {
      // RSI+WilliamsR+HeikinAshi  SL7/TP18  conf=0.55 → optimizer holdout: +30.4%  Sharpe 0.98 [3t] ✅
      strategies: ["RSI","WilliamsR","HeikinAshi"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
    },
    'JUP/USDC': {
      // BB+CCI+OBV  SL7/TP18  conf=0.55 → optimizer holdout: +47.0%  Sharpe 1.07 [5t] ✅
      strategies: ["BB","CCI","OBV"],
      stopLossPct: 0.07,
      takeProfitPct: 0.18,
      minConfidence: 0.55,
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
    // Multi-bar entry confirmation (Phase 1): borderline-confidence directional
    // signals (conf below midpoint between minConfidence and 1.0) require the
    // previous bar to agree before being executed. Kills one-bar fakeouts.
    // Live + backtester enable this; tests opt out via constructor flag.
    multiBarConfirmation: true,
  },
  // ── Regime filter — suppress BUY signals when the market is ranging ─────────
  // ADX < threshold → choppy / sideways → skip new entries, protect capital.
  // Backtest evidence: slight DD improvement (-16.65% → -16.18%) but costs ~4pp
  // return. Net-negative on 12h with current symbol mix — disabled.
  regime: {
    enabled: false,
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
  // ── Regime classifier (Phase 4) ──────────────────────────────────────────
  // Optional override for unit tests / experiments. Production uses defaults.
  regimeClassifier: {
    emaPeriod: 200,
    adxPeriod: 14,
    adxTrendThreshold: 25,
    hysteresisBars: 3,
  },
  btcDominance: {
    enabled: true,
    blockThresholdPp: 1.0,   // +1 percentage point above 7-day SMA
    refreshIntervalMs: 6 * 60 * 60 * 1000, // 6h
  },
  // ── Fear & Greed entry threshold modulator (Phase 3) ──────────────────────
  // Adjusts per-symbol minConfidence based on market sentiment.
  // Greed > 80 → tighten (demand more conviction). Fear < 20 → loosen (contrarian).
  fearGreed: {
    enabled: true,
    greedHigh: 80,
    fearLow:   20,
    tightenBy: 0.05,
    loosenBy:  0.05,
  },
  // ── Correlation filter — moved to risk.correlation block at top of file
  // (Phase 7 revisit with confidence-weighted aggregator + tighter threshold).
  // The OLD rejected impl was a routing filter; new impl is a hard cap on the
  // BUY itself. See risk.correlation above.
  // ── Multi-Timeframe (MTF) entry alignment filter ──────────────────────────────
  // Before entering a 12h BUY, checks the last 15m candles within that 12h period.
  // If fewer than `minAlignScore` fraction of those candles are green (close > open),
  // the entry is skipped — the short-term trend is against the 12h signal.
  //
  // Only applies to symbols that have 15m candle data on disk:
  //   BTC, XRP, LINK, BNB, LTC, NEAR, TRX, BCH  (8 of 34 symbols)
  //   → other symbols pass through unfiltered.
  //
  // Backtest evidence (1yr): +23.38% → +29.19% (+5.8pp),  Sharpe 1.37 → 1.55
  //                 18-month: +31.37% → +36.33% (+5.0pp),  Sharpe 1.06 → 1.17
  // Optimal params: alignBars=16 (4h), minAlignScore=0.50 (≥8 green out of 16)
  // 38/730 BUY signals blocked per year — low false-positive rate.
  //
  // Post-fix sweep (2026-06-22, slots=3, all filters on): 0.50 wins on raw return.
  //   mtf=0.40  Y2  +75% / OOS +37%   (too permissive, OOS hit hard)
  //   mtf=0.45  Y2 +109% / OOS +67%   (close to baseline)
  //   mtf=0.50  Y2 +111% / OOS +84%   ← current
  //   mtf=0.55  Y2  +74% / OOS +80%   (DD halved to -8/-11% — risk-adj alternative)
  mtfFilter: {
    enabled: true,
    alignBars: 16,         // 16 × 15m = 4h lookback window within the 12h candle
    minAlignScore: 0.50,   // minimum fraction of green 15m candles to allow entry
    reduceFactor: 0,       // 0 = skip entry; e.g. 0.5 = half position when misaligned
  },

  // ── Confidence-proportional position sizing ────────────────────────────────
  // Scales position size linearly based on signal confidence:
  //   conf ≥ mid (0.65)  → linear from 1.0× to max (1.5×)
  //   conf < mid         → linear from min (0.6×) to 1.0×
  //
  // Applied after ATR + Kelly sizing, before macro/MTF multipliers.
  //
  // Backtest evidence (1yr, with MTF): +31.88% → +35.10% (+3.2pp),
  //                                     Sharpe 1.77 → 1.84,  DD -8.33% → -9.03%
  // MTF early exit: tested — hurts return (recoveries cancelled), NOT enabled.
  confSizing: {
    enabled: true,
    mid: 0.65,   // neutral point: confidence at this level = 1× position
    max: 1.5,    // maximum multiplier at conf=1.0
    min: 0.6,    // minimum multiplier at conf=0.0
  },
  // ── 4h MTF momentum filter ────────────────────────────────────────────────────
  // Before entering a 12h BUY, checks the 4h candle structure using
  // EMA(8)/EMA(21) crossover (60%) + RSI(14) direction (40%).
  // Score < minScore → entry is blocked (4h trend is bearish).
  //
  // Backtest evidence:
  //   Y2:      +54.2% Sharpe 2.58  DD -3.6%  WR 65.1% (vs 68.7%/2.41/-12.6%/54.5% baseline)
  //   Full OOS: +689% Sharpe 1.45  DD -11.8% WR 63.8% (vs +453%/1.99/-23%/54.8% baseline)
  //   Calmar 58.5 vs 19.7 — 3× improvement.
  mtf4hFilter: {
    enabled: true,
    minScore: 0.45,      // minimum 4h momentum score to allow entry
    lookback: 21,        // number of 4h candles to compute EMA/RSI over
    fetchBars: 30,       // candles to fetch (lookback + warmup)
  },
  // ── Regime-aware position sizing (ADX-based) ──────────────────────────────────
  // Scales position size by the symbol's ADX strength at entry time:
  //   ADX ≥ boostThresh  → multiply by boostFactor (trends → bigger bets)
  //   ADX < penaltyThresh → multiply by penaltyFactor (chop → smaller bets)
  //
  // Backtest evidence (combined with 4h filter):
  //   Full OOS: +893% Sharpe 1.55 DD -12.1% WR 63.8% (vs +689% 4h-only)
  //   Calmar 73.9 — adds +30% return with <0.5pp DD cost.
  regimeSizing: {
    enabled: true,
    boostThresh: 25,       // ADX above this → strong trend
    penaltyThresh: 15,     // ADX below this → choppy range
    boostFactor: 1.3,      // size multiplier in trends
    penaltyFactor: 0.5,    // size multiplier in chop
    adxPeriod: 14,         // ADX calculation period
  },
  dashboard: {
    enabled: true,
    port: 3001,
  },
};

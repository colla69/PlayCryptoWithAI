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
  // Skip a symbol's cycle when its newest bar is older than this many periods.
  // Thin/delisted markets keep returning klines that never advance — LSK, TON
  // and GMX each fed the aggregator a frozen series for weeks in the 2026-07
  // soak. 2 periods (24h on 12h candles) clears the normal case (the forming
  // bar is ~0 periods old; a not-yet-published one is 1) with a wide margin.
  maxCandleStalenessPeriods: 2,
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
    initialBalance: 1000,   // Paper starting balance + FALLBACK base for %-limits.
                            // Live %-of-account brakes (maxDailyLossPct, weekly DD
                            // breaker) scale off LIVE equity once known — this value
                            // only anchors them before the first balance reading.
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
    // trading at a sensible frequency under the stricter confidence-weighted formula.
    //
    // Phase 4 retune outcome (measured, not assumed): the per-symbol optimizer
    // (MIN_TRADES≥8, deflated-Sharpe≥0.5, shared aggregator) found NO combo that
    // beats the current per-symbol configs with statistical significance — they
    // survive the strict bar, so combos were left unchanged. The scale was then
    // swept on the full live filter stack:
    //   scale 1.00 → STARVED (3 trades/90d, 0 on longer windows) — raw thresholds non-viable
    //   scale 0.75 → returns collapse (full_history +6.4%)
    //   scale 0.65 → BEST risk-adjusted (last_90d +15.3% Sh3.04 DD-4.4%; full +24.6% Sh1.32 DD-3.7%)
    //   scale 0.55 → more trades but DD worsens to -7.8/-9.7%
    // Walk-forward (forward-only) at 0.65: +25.5% Sh1.38 DD-5.36%, MC not fragile.
    // → 0.65 is the validated calibration, NOT a temporary hack. Do not set to 1.0.
    minConfidence: 0.70,
    confidenceThresholdScale: 0.65,
    // ── ATR-based stops (Phase 1) ──────────────────────────────────────────
    // When enabled, BUY orders compute SL/TP from current ATR% instead of fixed
    // stopLossPct/takeProfitPct. Volatile coins get wider stops naturally;
    // less-volatile coins get tighter stops without losing the cushion.
    // Clamped to [minSlPct, maxSlPct] and [minTpPct, maxTpPct] to avoid extremes.
    // The same multipliers apply in live + backtester (live ≡ backtest invariant).
    atrStops: {
      enabled: false,    // A/B (Phase 1): net-negative vs well-tuned per-symbol fixed stops — OFF
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
  // ── Bear policy (Phase 6a) ───────────────────────────────────────────────
  // When BTC regime enters BEAR_TREND or BEAR_CHOP:
  //   1. Block all new entries for the duration of the bear regime
  //   2. On the BAR of transition into bear, close all open positions
  //      (subsequent bars do NOT repeatedly force-close — open positions
  //      become managed by SL/TP/break-even like normal)
  // Default ON for the user's "low DD imperative" priority. Set
  // bearPolicy.enabled = false to revert to the prior macro-halving-only
  // behaviour (positions stay open through bear; sizing halved).
  bearPolicy: {
    enabled: true,
    restrictTo: 'trend_only',   // 'trend_only' (default) or 'all_bear' (more defensive but -17pp return on y2 backtest)
  },
  // ── Regime-conditional strategy routing (Phase 4) ───────────────────────
  // When enabled, the per-symbol strategy LIST swaps based on BTC regime.
  // BULL_TREND uses trend pack, BULL_RANGE uses mean-reversion pack;
  // BEAR_* uses an empty list (no entries — overlaps with bearPolicy).
  // The actual bundle definitions live in src/engine/regimeRouter.js
  // (DEFAULT_REGIME_BUNDLES) and can be overridden per-symbol via
  // config.perSymbol[sym].regimeStrategyBundles.
  //
  // Defaulting OFF for the initial ship — Phase 4 walk-forward retune
  // will turn it on after validating the bundle composition.
  regimeRouting: {
    enabled: false,
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
  // ── Live drift monitor (Phase 8) ──────────────────────────────────────────
  // Each cycle, compare the rolling per-trade live Sharpe to the backtest
  // reference and warn when they diverge beyond `zThreshold` standard errors.
  // driftRefSharpe is a PER-TRADE Sharpe (not the daily-equity one printed by
  // runBaseline). Leave null for log-only observability; set it from a per-trade
  // backtest stat to enable alerts.
  monitor: {
    enabled: true,
    windowDays: 30,
    minTrades: 10,
    zThreshold: 2,
    driftRefSharpe: null,
  },
  // ── Logistic-regression meta-overlay (Phase 5) ────────────────────────────
  // P(win) entry gate trained offline by src/scripts/trainMetaOverlay.mjs →
  // data/meta_overlay.json. DISABLED: on current data (376 samples) the gate's
  // held-out admitted win rate (12.5%) is WORSE than the base rate (39.5%) —
  // it does not beat baseline. Keep enabled=false until a retrain clearly wins
  // AND the gate is mirrored into BOTH main.js and PortfolioBacktester (parity)
  // and re-validated on the baseline/walk-forward. Gate-only, never sizing.
  metaOverlay: {
    enabled: false,
    threshold: 0.55,
    modelPath: 'data/meta_overlay.json',
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
  //   mtf=0.50  Y2 +111% / OOS +84%
  //   mtf=0.55  Y2  +74% / OOS +80%   (DD halved to -8/-11% — risk-adj alternative)
  //
  // ⚠️ SUPERSEDED 2026-06-24: the sweep above ran when only ~8/37 symbols had 15m data
  // (the rest passed through UNFILTERED). After backfilling 15m for ALL 37 symbols (deep
  // 6yr data), this filter now applies portfolio-wide — a different regime. On the
  // complete data a forward-only walk-forward shows 0.50 is TOO TIGHT:
  //   0.50→0.30 : WF Sharpe 1.01→1.25, DSR 0.01→0.15, return +73%→+131%
  //               (cost: forward-only max DD ~-21%→-32%).
  //   0.40 is the lower-DD middle ground (windowed 6yr +118%/Sh1.19) if DD matters more.
  mtfFilter: {
    enabled: true,
    alignBars: 16,         // 16 × 15m = 4h lookback window within the 12h candle
    minAlignScore: 0.30,   // 2026-06-24: relaxed 0.50→0.30 (full 15m coverage); see note above
    reduceFactor: 0,       // 0 = skip entry; e.g. 0.5 = half position when misaligned
  },

  // ── Momentum-leader filter (2026-06-25) ──────────────────────────────────────
  // Block BUYs in relative-strength laggards: require a non-negative trailing
  // `lookback`-bar return on the entry timeframe ("don't buy falling knives").
  // The bot's oversold strategies (RSI/BB/Stoch) otherwise buy dips in downtrends;
  // requiring positive momentum keeps only dips-in-uptrends.
  // Forward-only walk-forward (deep 6yr data): Sharpe 1.50→1.60, DSR 0.11→0.18,
  // WR 60→69%, PF 4.7→7.6. Applied in BOTH live (`core/filters.js`) and backtest
  // (`portfolioBacktester.js`) via the shared `utils/momentum.js` helper — parity.
  momentumFilter: {
    enabled: true,
    minPct: 0,             // require trailing return ≥ 0 (in an uptrend)
    lookback: 20,          // bars (20 × 12h = 10 days)
  },

  // ── TSM majors core sleeve (2026-07-02) ──────────────────────────────────────
  // Time-series-momentum "beta with a seatbelt": hold each core symbol long while
  // trailing-momentum lookbacks are positive, sit in cash otherwise.
  // Exits ONLY on signal flip — no SL/TP/trailing/aging (positions carry isCore
  // and are skipped by stop management and scalper risk gates). Keyed as
  // '<symbol>#core' so a scalper position on the same symbol can coexist.
  // Study (docs/TREND_CORE_STUDY.md): combo rule = Sharpe 1.27 / DD −36% /
  // DSR 0.94 on 9yr incl. the 2018+2022 bears, vs B&H 0.78 / −84%.
  // Runs in PAPER and LIVE (real market orders — deploymentPct of the account).
  // Default OFF — TSM_CORE=true is the deliberate opt-in in either mode.
  tsmCore: {
    enabled: process.env.TSM_CORE === 'true',
    symbols: ['BTC/USDC', 'ETH/USDC'],
    lookbackBars: [60, 90, 120],  // 30/45/60 days on 12h trailing-momentum votes
    // Slow-in hysteresis (9yr USDT study incl. 2018+2022 bears): enter only when
    // ALL lookbacks are positive, hold while a majority stays positive. Beats the
    // symmetric 2-of-3 vote on Sharpe (0.93→1.04 BTC+ETH) and cuts round trips
    // ~3× (251→86). Vol targeting + macro overlay (below) complete the combo
    // rule: Sharpe 1.27, DD −36%, DSR 0.94 on the 4-major 9yr study.
    enterVotes: 3,                // open a new core position: positives ≥ this
    stayVotes: 2,                 // keep an open core position: positives ≥ this
    deploymentPct: 0.5,           // sleeve share of equity (risk dial: DD scales ~linearly)
    // Vol-targeted sizing (combo rule): slot size × min(1, volTarget/realizedVol).
    // 9yr study: Sharpe 1.12→1.23, DD −58→−44% on the 4-major universe.
    volTarget: 0.6,               // annualised vol target (crypto-calibrated; ≤1 slot, no leverage)
    volWindowBars: 60,            // realized-vol window (30 days of 12h bars)
    minFraction: 0.2,             // floor on the vol fraction
    resizeThresholdPct: 0.15,     // rebalance a held slot when drift > 15% of the slot
    // Equity risk-off overlay (M1): half size while NASDAQ < its 100d EMA.
    // The one context overlay that improved Sharpe AND DD in every universe
    // tested (1.23→1.27, DD −44→−36%, DSR 0.94). FRED feed, keyless, 12h cache;
    // fetch failure → neutral. See docs/TREND_CORE_STUDY.md.
    macroOverlay: {
      enabled: true,
      emaDays: 100,
      riskOffFactor: 0.5,
    },
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

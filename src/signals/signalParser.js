const DEFAULT_TEXT_CONFIDENCE = 0.7;
const DEFAULT_WEBHOOK_CONFIDENCE = 0.7;
const BASE_TELEGRAM_CONFIDENCE = 0.7;

const ACTION_ALIASES = {
  BUY: 'BUY',
  LONG: 'BUY',
  SELL: 'SELL',
  SHORT: 'SELL',
  HOLD: 'HOLD',
};

const EXCLUDED_SYMBOL_TOKENS = new Set([
  'BUY', 'SELL', 'LONG', 'SHORT', 'HOLD', 'SIGNAL', 'ENTRY', 'ALERT',
  'SPOT', 'FUTURES', 'NOW', 'PAIR', 'TRADE', 'BINANCE', 'BYBIT', 'OKX',
  'COINBASE', 'USDT', 'HIGH', 'LOW', 'MEDIUM', 'RISK', 'COIN', 'EXCHANGE',
  'LEVERAGE', 'TARGET', 'STOP', 'LOSS', 'PROFIT', 'TAKE', 'OPTIONAL',
]);

// ── Telegram channel patterns ─────────────────────────────────────────────────
// Covers: Binance Killers, Fat Pig Signals, Universal Crypto Signals, Learn2Trade

const TG_PATTERNS = {
  // Symbol: $ADA/USDT, #BTCUSDT, Coin: BTC, Pair: ETH/USDT
  symbol: [
    /(?:coin|pair)[:\s]+[$#]?([A-Z]{2,10}(?:\/[A-Z]{2,10}|USDT|BTC|ETH|BNB)?)/i,
    /[$#]([A-Z]{2,10}(?:\/[A-Z]{2,10}|USDT|BTC|ETH|BNB)?)/,
    /\b([A-Z]{2,10}\/[A-Z]{2,10})\b/,
    /\b([A-Z]{2,10}USDT)\b/,
  ],

  // Action: BUY SIGNAL, 🟢 BUY, LONG, SHORT, SELL SIGNAL
  action: /\b(BUY|SELL|LONG|SHORT)\b(?:\s+SIGNAL)?/i,

  // "#SPOT SIGNAL" without explicit BUY → implicit BUY (Binance Killers style)
  impliedBuy: /#SPOT\s+SIGNAL|SPOT\s+SIGNAL/i,

  // Entry: "Entry: 0.52", "Entry Price: 65000", "Buy: $3,228", range "0.520 – 0.530" → average
  entry: /(?:entry(?:\s+\w+)?|buy|enter(?:ing)?)[:\s]+\$?([\d,\.]+)\s*(?:[–\-—~to]+\s*\$?([\d,\.]+))?/i,

  // Take profit: TP1: 0.55, Target 1: $3,280, Take Profit: 0.55, Targets: 0.55 / 0.57
  takeProfit: /(?:tp\s*\d*|target\s*\d*|take\s*profit\s*\d*)[:\s]+\$?([\d,\.]+)/gi,

  // Stop loss: SL: 0.51, Stop Loss: $3,190, Stop: 0.51
  stopLoss: /(?:sl|stop\s*(?:loss)?)[:\s]+\$?([\d,\.]+)/i,

  // Confidence hint: Confidence: HIGH → +0.05 bonus
  confidenceHigh: /confidence[:\s]+high/i,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function stripEmojis(text) {
  // Remove Unicode emoji and common symbol chars, then collapse whitespace
  return text
    .replace(/\p{Emoji_Presentation}/gu, ' ')
    .replace(/[🟢🔴🟡⚡💰🎯🛑📈🚀❌✅⚠️🔔💎🐷]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(str) {
  if (!str) return null;
  const n = Number(String(str).replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function clampConfidence(value, fallback = DEFAULT_WEBHOOK_CONFIDENCE) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Number(Math.max(0, Math.min(1, numeric)).toFixed(2));
}

function normalizeAction(action) {
  if (typeof action !== 'string') return null;
  return ACTION_ALIASES[action.trim().toUpperCase()] ?? null;
}

function normalizeSymbol(rawSymbol) {
  if (typeof rawSymbol !== 'string') return null;

  let s = rawSymbol.trim().toUpperCase().replace(/[$#]/g, '');
  if (!s) return null;

  if (s.includes(':')) s = s.split(':').at(-1);
  s = s.replace(/[-_]/g, '/').replace(/\s+/g, '');

  if (s.includes('/')) {
    const [base, quote] = s.split('/');
    return base && quote ? `${base}/${quote}` : null;
  }
  if (/^[A-Z]{2,10}USDT$/.test(s)) return `${s.slice(0, -4)}/USDT`;
  if (/^[A-Z]{2,10}BTC$/.test(s))  return `${s.slice(0, -3)}/BTC`;
  if (/^[A-Z]{2,10}ETH$/.test(s))  return `${s.slice(0, -3)}/ETH`;
  if (/^[A-Z]{2,10}BNB$/.test(s))  return `${s.slice(0, -3)}/BNB`;
  if (/^[A-Z]{2,10}$/.test(s))     return `${s}/USDT`;
  return null;
}

function detectAction(text) {
  const match = text.toUpperCase().match(/\b(BUY|SELL|LONG|SHORT|HOLD)\b/);
  return normalizeAction(match?.[1] ?? null);
}

function detectSymbol(text) {
  const upper = text.toUpperCase();

  for (const pattern of TG_PATTERNS.symbol) {
    const m = upper.match(pattern);
    if (m?.[1]) {
      const sym = normalizeSymbol(m[1]);
      if (sym) return sym;
    }
  }

  const tokens = upper.match(/\b[A-Z]{2,10}\b/g) ?? [];
  for (const token of tokens) {
    if (EXCLUDED_SYMBOL_TOKENS.has(token)) continue;
    const sym = normalizeSymbol(token);
    if (sym) return sym;
  }
  return null;
}

function buildSignal({ symbol, signal, source, confidence, reason, entry, takeProfit, stopLoss }) {
  const out = { symbol, signal, source, confidence, reason, timestamp: new Date().toISOString() };
  if (entry != null)      out.entry = entry;
  if (takeProfit?.length) out.takeProfit = takeProfit;
  if (stopLoss != null)   out.stopLoss = stopLoss;
  return out;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parses Telegram channel messages from Binance Killers, Fat Pig Signals,
 * Universal Crypto Signals, Learn2Trade and similar channels.
 * Extracts: action, symbol, entry, takeProfit[], stopLoss, confidence.
 * Confidence is boosted when entry/TP/SL are present.
 */
export function parseTelegramSignal(rawText, source = 'telegram') {
  if (typeof rawText !== 'string' || !rawText.trim()) return null;

  const text = stripEmojis(rawText);

  // Explicit BUY/SELL/LONG/SHORT, or fall back to implied BUY from "#SPOT SIGNAL"
  let action = normalizeAction(text.match(TG_PATTERNS.action)?.[1] ?? null);
  if (!action && TG_PATTERNS.impliedBuy.test(text)) action = 'BUY';
  if (!action || action === 'HOLD') return null;

  const symbol = detectSymbol(text);
  if (!symbol) return null;

  // Entry price — supports ranges like "0.520 – 0.530" (average)
  let entry = null;
  const entryMatch = text.match(TG_PATTERNS.entry);
  if (entryMatch) {
    const lo = parseNumber(entryMatch[1]);
    const hi = parseNumber(entryMatch[2]);
    entry = hi ? Math.round(((lo + hi) / 2) * 1e8) / 1e8 : lo;
  }

  // All take-profit levels
  const takeProfits = [];
  let tpMatch;
  const tpRegex = new RegExp(TG_PATTERNS.takeProfit.source, 'gi');
  while ((tpMatch = tpRegex.exec(text)) !== null) {
    const v = parseNumber(tpMatch[1]);
    if (v) takeProfits.push(v);
  }

  // Stop loss
  const slMatch = text.match(TG_PATTERNS.stopLoss);
  const stopLoss = slMatch ? parseNumber(slMatch[1]) : null;

  // Confidence: base + bonus for each level of completeness
  let confidence = BASE_TELEGRAM_CONFIDENCE;
  if (entry)              confidence += 0.05;
  if (takeProfits.length) confidence += 0.05;
  if (stopLoss)           confidence += 0.05;
  if (TG_PATTERNS.confidenceHigh.test(text)) confidence += 0.05;
  confidence = clampConfidence(confidence, BASE_TELEGRAM_CONFIDENCE);

  return buildSignal({
    symbol,
    signal: action,
    source,
    confidence,
    reason: 'external:telegram',
    entry,
    takeProfit: takeProfits,
    stopLoss,
  });
}

/** Generic plain-text signal parser (webhooks, simple bots). */
export function parseTextSignal(text, source = 'text') {
  if (typeof text !== 'string' || !text.trim()) return null;

  // Try the richer Telegram parser first
  const rich = parseTelegramSignal(text, source);
  if (rich) return rich;

  const signal = detectAction(text);
  const symbol = detectSymbol(text);
  if (!signal || !symbol) return null;

  return buildSignal({ symbol, signal, source, confidence: DEFAULT_TEXT_CONFIDENCE, reason: 'external:text' });
}

/** TradingView / generic webhook JSON parser. */
export function parseWebhookPayload(body, source = 'webhook') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const genericSymbol = normalizeSymbol(body.symbol);
  const genericSignal = normalizeAction(body.action);
  if (genericSymbol && genericSignal) {
    return buildSignal({
      symbol: genericSymbol, signal: genericSignal, source,
      confidence: clampConfidence(body.confidence),
      reason: `external:${source}`,
    });
  }

  const tvSymbol = normalizeSymbol(body.ticker ?? body.symbol);
  const tvSignal = normalizeAction(body.strategy?.order_action);
  if (tvSymbol && tvSignal) {
    return buildSignal({
      symbol: tvSymbol, signal: tvSignal, source,
      confidence: clampConfidence(body.confidence),
      reason: `external:${source}`,
    });
  }

  return null;
}

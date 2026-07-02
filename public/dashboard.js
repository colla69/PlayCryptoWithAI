    const API_BASE = window.location.origin;
    const REASON_MAP = {
      rsi_buy: 'RSI oversold',
      rsi_sell: 'RSI overbought',
      bb_buy: 'Price at lower Bollinger Band',
      bb_sell: 'Price at upper Bollinger Band',
      macd_buy: 'MACD bullish crossover',
      macd_sell: 'MACD bearish crossover',
      ema_buy: 'Price above EMA',
      ema_sell: 'Price below EMA',
      stoch_buy: 'Stochastic oversold',
      stoch_sell: 'Stochastic overbought',
      adx_buy: 'Strong uptrend (ADX)',
      adx_sell: 'Strong downtrend (ADX)',
      cci_buy: 'CCI oversold',
      cci_sell: 'CCI overbought',
    };

    const state = {
      summary: null,
      trades: [],
      source: null,
      reconnectTimer: null,
      connected: false,
    };

    const el = {
      modeBadge: document.getElementById('modeBadge'),
      connectionDot: document.getElementById('connectionDot'),
      connectionLabel: document.getElementById('connectionLabel'),
      liveClock: document.getElementById('liveClock'),
      portfolioValue: document.getElementById('portfolioValue'),
      portfolioSub: document.getElementById('portfolioSub'),
      totalPnl: document.getElementById('totalPnl'),
      totalPnlSub: document.getElementById('totalPnlSub'),
      winRate: document.getElementById('winRate'),
      winRateSub: document.getElementById('winRateSub'),
      openPositionsCount: document.getElementById('openPositionsCount'),
      positionsPanel: document.getElementById('positionsPanel'),
      positionsCountLabel: document.getElementById('positionsCountLabel'),
      positionsBody: document.getElementById('positionsBody'),
      signalFeed: null,
      tradesBody: document.getElementById('tradesBody'),
      lastCycle: document.getElementById('lastCycle'),
      nextCycle: document.getElementById('nextCycle'),
      runningFor: document.getElementById('runningFor'),
      timeframe: document.getElementById('timeframe'),
      watching: document.getElementById('watching'),
    };

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // Fixed-position tooltip that escapes any overflow:hidden parent
    const hintTooltip = document.getElementById('hintTooltip');
    document.addEventListener('mouseover', (e) => {
      const btn = e.target.closest('[data-hint]');
      if (!btn) return;
      const lines = JSON.parse(btn.dataset.hint);
      const extra = btn.dataset.hintExtra || '';
      hintTooltip.innerHTML = lines.map(l => `<div>• ${escapeHtml(l)}</div>`).join('') +
        (extra ? `<div style="margin-top:6px;color:#818cf8;font-size:11px">${escapeHtml(extra)}</div>` : '');
      hintTooltip.style.display = 'block';
    });
    document.addEventListener('mousemove', (e) => {
      if (!hintTooltip.style.display || hintTooltip.style.display === 'none') return;
      const x = e.clientX + 12;
      const y = e.clientY + 12;
      const w = hintTooltip.offsetWidth;
      const h = hintTooltip.offsetHeight;
      hintTooltip.style.left = (x + w > window.innerWidth ? x - w - 24 : x) + 'px';
      hintTooltip.style.top  = (y + h > window.innerHeight ? y - h - 12 : y) + 'px';
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest('[data-hint]')) hintTooltip.style.display = 'none';
    });

    function endpoint(path) {
      return `${API_BASE}${path}`;
    }

    // EUR/USD exchange rate — fetched once on load, refreshed every 10 min
    let eurRate = null;
    async function refreshEurRate() {
      try {
        const r = await fetch('https://open.er-api.com/v6/latest/USD', { cache: 'no-store' });
        if (r.ok) {
          const data = await r.json();
          eurRate = data?.rates?.EUR ?? null;
        }
      } catch (_) { /* non-critical */ }
    }
    refreshEurRate();
    setInterval(refreshEurRate, 10 * 60 * 1000);

    function formatEur(usdValue) {
      if (!eurRate) return null;
      const eur = Number(usdValue) * eurRate;
      if (!Number.isFinite(eur)) return null;
      return eur.toLocaleString(undefined, { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Returns "±$X.XX / ±€Y.YY" or just "±$X.XX" if rate not available
    function formatSignedDual(usdValue) {
      const prefix = usdValue >= 0 ? '+' : '';
      const usd = `${prefix}${formatMoney(Math.abs(usdValue))}`;
      const eurStr = eurRate ? ` / ${usdValue >= 0 ? '+' : '−'}${formatEur(Math.abs(usdValue))}` : '';
      return `${usd}${eurStr}`;
    }

    async function fetchJson(path) {
      const response = await fetch(endpoint(path), { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`Request failed: ${path}`);
      }
      return response.json();
    }

    function getBaseSymbol(symbol = '') {
      return String(symbol).split('/')[0] || 'COIN';
    }

    function getPriceDecimals(value, symbol = '') {
      const amount = Math.abs(Number(value) || 0);
      const base = getBaseSymbol(symbol).toUpperCase();

      if (base === 'BTC') return 2;
      if (amount >= 1) return 4;
      if (amount >= 0.01) return 5;
      return 6;
    }

    function formatQty(qty) {
      const n = Number(qty);
      if (!Number.isFinite(n) || n === 0) return '—';
      if (n >= 1_000_000)  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
      if (n >= 1_000)      return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
      if (n >= 1)          return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
      return n.toLocaleString(undefined, { maximumSignificantDigits: 5 });
    }

    function formatPrice(value, symbol = '') {
      const amount = Number(value ?? 0);
      if (!Number.isFinite(amount)) return '—';
      return `$${amount.toLocaleString(undefined, {
        minimumFractionDigits: getPriceDecimals(amount, symbol),
        maximumFractionDigits: getPriceDecimals(amount, symbol),
      })}`;
    }

    function formatMoney(value) {
      const amount = Number(value ?? 0);
      if (!Number.isFinite(amount)) return '$0.00';
      return amount.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }

    function formatSignedMoney(value) {
      const amount = Number(value ?? 0);
      const prefix = amount > 0 ? '+' : '';
      return `${prefix}${formatMoney(amount)}`;
    }

    function formatPercent(value, digits = 2) {
      const amount = Number(value ?? 0);
      if (!Number.isFinite(amount)) return '0%';
      const prefix = amount > 0 ? '+' : '';
      return `${prefix}${amount.toFixed(digits)}%`;
    }

    function classForValue(value) {
      const amount = Number(value ?? 0);
      if (amount > 0) return 'positive';
      if (amount < 0) return 'negative';
      return 'neutral';
    }

    function setConnection(connected) {
      state.connected = connected;
      el.connectionDot.classList.toggle('connected', connected);
      el.connectionLabel.textContent = connected ? 'Connected' : 'Disconnected';
    }

    function renderClock() {
      el.liveClock.textContent = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    }

    function formatDuration(ms) {
      const totalMinutes = Math.max(0, Math.floor(Number(ms || 0) / 60000));
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const parts = [];
      if (days) parts.push(`${days}d`);
      if (hours || days) parts.push(`${hours}h`);
      parts.push(`${minutes}m`);
      return parts.join(' ');
    }

    function relativeTime(dateLike) {
      if (!dateLike) return '—';
      const target = typeof dateLike === 'number' ? dateLike : new Date(dateLike).getTime();
      if (!Number.isFinite(target)) return '—';

      const diffMs = target - Date.now();
      const future = diffMs > 0;
      const totalMinutes = Math.max(0, Math.round(Math.abs(diffMs) / 60000));

      if (Math.abs(diffMs) < 30000) {
        return future ? 'in moments' : 'just now';
      }

      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const parts = [];

      if (days) parts.push(`${days}d`);
      if (hours) parts.push(`${hours}h`);
      if (minutes || !parts.length) parts.push(`${minutes}m`);

      return future ? `in ${parts.slice(0, 2).join(' ')}` : `${parts.slice(0, 2).join(' ')} ago`;
    }

    function formatFeedTime(dateLike) {
      if (!dateLike) return '--:--';
      const date = new Date(dateLike);
      if (Number.isNaN(date.getTime())) return '--:--';
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatTradeTime(dateLike) {
      if (!dateLike) return '—';
      const date = new Date(dateLike);
      if (Number.isNaN(date.getTime())) return '—';
      return date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    function prettifyReason(reason) {
      if (!reason) return '—';
      const raw = String(reason).trim();
      if (REASON_MAP[raw]) return REASON_MAP[raw];
      return raw
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
    }

    function tradeResultLabel(trade) {
      if (trade?.side === 'BUY') return '🛒 Position Opened';

      switch (trade?.reason) {
        case 'take_profit':
          return '✅ Take Profit';
        case 'stop_loss':
        case 'trailing_stop':
          return '🛑 Stop Loss';
        case 'strategy_sell':
          return '📤 Signal Exit';
        default:
          return prettifyReason(trade?.reason || '—');
      }
    }

    function getWatchCount(summary) {
      const runtimeSymbols = summary?.runtimeConfig?.symbols;
      if (Array.isArray(runtimeSymbols) && runtimeSymbols.length) return runtimeSymbols.length;

      const symbols = new Set([
        ...Object.keys(summary?.prices || {}),
        ...Object.keys(summary?.latestStrategyResults || {}),
        ...(summary?.signalFeed || []).map((signal) => signal.symbol),
        ...(summary?.latestStatus?.positions || []).map((position) => position.symbol),
      ].filter(Boolean));

      return symbols.size;
    }

    // Returns open trades derived from trade history: BUYs without a matching SELL for the same symbol.
    function getPortfolioStats(summary) {
      const positions  = summary?.latestStatus?.positions || [];
      const maxSlots    = summary?.runtimeConfig?.maxOpenPositions || 0;
      const cashBalance = Number(summary?.latestStatus?.balance ?? summary?.metrics?.balance ?? 0);
      const realizedPnl = Number(summary?.metrics?.totalPnL ?? 0);
      const openMarketValue = positions.reduce((total, position) => {
        const price = position.currentPrice != null ? Number(position.currentPrice) : Number(position.entryPrice ?? 0);
        return total + price * Number(position.qty ?? 0);
      }, 0);
      const openCostBasis = positions.reduce((total, position) => total + (Number(position.entryPrice ?? 0) * Number(position.qty ?? 0)), 0);
      const unrealizedPnl = positions.reduce((total, position) => total + Number(position.unrealizedPnl ?? 0), 0);
      const portfolioValue = cashBalance + openMarketValue;
      const totalPnl = realizedPnl + unrealizedPnl;
      const startingBalance = cashBalance + openCostBasis - realizedPnl;
      const pnlPct = startingBalance > 0 ? (totalPnl / startingBalance) * 100 : 0;

      return {
        cashBalance,
        portfolioValue,
        totalPnl,
        pnlPct,
        unrealizedPnl,
        openCount: positions.length,
        maxSlots,
        watchCount: getWatchCount(summary),
      };
    }

    function renderHeader(summary) {
      const mode = String(summary?.mode || 'PAPER').toUpperCase();
      el.modeBadge.textContent = mode;
      el.modeBadge.className = `badge ${mode === 'LIVE' ? 'mode-live' : mode === 'TESTNET' ? 'mode-testnet' : 'mode-paper'}`;
    }

    function renderSummary(summary) {
      const stats       = getPortfolioStats(summary);
      const wins        = Number(summary?.metrics?.wins ?? 0);
      const losses      = Number(summary?.metrics?.losses ?? 0);
      const closedTrades = wins + losses;

      // Main number = available cash; sub = total portfolio value (cash + open positions)
      el.portfolioValue.textContent = formatMoney(stats.cashBalance);
      const posVal   = stats.portfolioValue - stats.cashBalance;
      const botOnline = summary?.latestStatus != null;
      if (el.portfolioSub) {
        if (posVal > 0) {
          const staleSuffix = !botOnline ? ' · ⚠️ bot offline' : '';
          el.portfolioSub.textContent = `Portfolio total: ${formatMoney(stats.portfolioValue)} · In positions: ${formatMoney(posVal)}${staleSuffix}`;
        } else if (stats.openCount > 0 && !botOnline) {
          el.portfolioSub.textContent = `${stats.openCount} open position${stats.openCount === 1 ? '' : 's'} tracked · ⚠️ bot offline`;
        } else {
          el.portfolioSub.textContent = 'No open positions — full balance available';
        }
      }
      // P&L stat card: percentage as main, $ amount in sub-line, hover shows exact dollar
      const pnlSign = stats.totalPnl >= 0 ? '+' : '';
      el.totalPnl.textContent = formatPercent(stats.pnlPct);
      el.totalPnl.className = `stat-main ${classForValue(stats.totalPnl)}`;
      el.totalPnl.title = `${pnlSign}${formatMoney(Math.abs(stats.totalPnl))} total`;
      el.totalPnl.style.cursor = 'default';
      const eurPnl = eurRate ? ` · ${formatEur(stats.totalPnl)}` : '';
      el.totalPnlSub.textContent = `${formatSignedMoney(stats.totalPnl)} overall${eurPnl}`;

      el.winRate.textContent = `${Number(summary?.metrics?.winRate ?? 0).toFixed(0)}%`;
      el.winRateSub.textContent = `${closedTrades} closed trade${closedTrades === 1 ? '' : 's'} tracked`;
      el.openPositionsCount.textContent = `${stats.openCount} / ${stats.maxSlots || stats.watchCount || 0}`;
    }

    function renderPositions(summary) {
      const positions = summary?.latestStatus?.positions || [];
      const botOnline = summary?.latestStatus != null;

      el.positionsPanel.hidden = positions.length === 0;
      el.positionsCountLabel.textContent = positions.length
        ? `${positions.length} open position${positions.length === 1 ? '' : 's'}`
        : '';

      if (!positions.length) {
        el.positionsBody.innerHTML = '';
        return;
      }

      el.positionsBody.innerHTML = positions.map((position) => {
        const entry      = Number(position.entryPrice ?? 0);
        const qty        = Number(position.qty ?? 0);
        const costBasis  = entry * qty;
        const stopLoss   = Number(position.stopLoss ?? 0);
        const takeProfit = Number(position.takeProfit ?? 0);
        const stopPct    = entry > 0 ? ((entry - stopLoss) / entry) * 100 : 0;
        const takePct    = entry > 0 ? ((takeProfit - entry) / entry) * 100 : 0;
        const unrealized = Number(position.unrealizedPnl ?? 0);
        const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null;
        const unrealizedDisplay = unrealizedPct !== null
          ? `<span title="${formatSignedMoney(unrealized)}" style="cursor:default">${formatPercent(unrealizedPct)}</span>`
          : '—';
        const base       = getBaseSymbol(position.symbol);
        const heldFor    = position.openedAt ? formatDuration(Date.now() - new Date(position.openedAt).getTime()) : '—';

        // TSM core positions have no SL/TP by design — exits happen on the
        // momentum-vote flip, sizing drifts toward a vol/macro target.
        const isCore = position.isCore === true || String(position.symbol).endsWith('#core');

        // Detect break-even: stop loss is within 0.2% of entry price (was moved there by the BE rule)
        const isBreakEven = entry > 0 && stopLoss > 0 && Math.abs(stopLoss - entry) / entry < 0.002;
        const protectionHtml = isCore
          ? `<span class="protection-badge protection-normal" title="TSM core sleeve position — no stop loss or take profit; exits when the momentum vote flips, resizes toward its volatility/macro target">🧲 Momentum core</span>`
          : isBreakEven
            ? `<span class="protection-badge protection-breakeven" title="Stop loss has been moved to entry — this position cannot close at a loss">⚡ Break-even</span>`
            : stopLoss > 0
              ? `<span class="protection-badge protection-normal" title="Fixed stop loss at ${formatPercent(-stopPct)} below entry">🛑 ${formatPercent(-stopPct)}</span>`
              : '—';
        const slHtml = isCore
          ? '<div title="Core positions exit on the momentum-vote flip, not a stop">—</div>'
          : `<div>${formatPrice(stopLoss, position.symbol)}</div><div class="helper">${formatPercent(-stopPct)}</div>`;
        const tpHtml = isCore
          ? '<div title="Core positions ride the trend — no take-profit cap">—</div>'
          : `<div>${formatPrice(takeProfit, position.symbol)}</div><div class="helper">${formatPercent(takePct)}</div>`;

        return `
          <tr data-symbol="${escapeHtml(position.symbol)}" data-entry="${entry}" data-qty="${qty}">
            <td>
              <div class="coin-cell">
                <span class="coin-icon">${escapeHtml(base.slice(0, 4))}</span>
                <div class="small-stack">
                  <div class="coin-name">${escapeHtml(base)}</div>
                  <div class="coin-pair">${escapeHtml(position.symbol)}</div>
                </div>
              </div>
            </td>
            <td>
              <div>${qty > 0 ? formatQty(qty) : '—'}</div>
              <div class="helper">${costBasis > 0 ? formatMoney(costBasis) : ''}</div>
            </td>
            <td class="${classForValue(unrealized)}">${formatSignedMoney(unrealized)}</td>
            <td>${formatPrice(entry, position.symbol)}</td>
            <td class="pos-current-price">${formatPrice(position.currentPrice ?? entry, position.symbol)}</td>
            <td class="pos-unrealized ${classForValue(unrealized)}">${unrealizedDisplay}</td>
            <td>${slHtml}</td>
            <td>${tpHtml}</td>
            <td>${protectionHtml}</td>
            <td title="${escapeHtml(position.openedAt || '')}">${escapeHtml(heldFor)}</td>
            <td>
              <button class="close-pos-btn" data-symbol="${escapeHtml(position.symbol)}"
                title="Manually close this position at market price"
                onclick="confirmClosePosition('${escapeHtml(position.symbol)}')">
                Close
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }

    window._signalPage = 1;
    async function loadSignalHistory(page) {
      const body = document.getElementById('signalHistoryBody');
      if (!body) return;
      if (typeof page === 'number' && page >= 1) window._signalPage = page;
      const symbolFilter = document.getElementById('signalFilterSymbol')?.value || '';
      const decisionFilter = document.getElementById('signalFilterDecision')?.value || '';
      const pageSize = document.getElementById('signalPageSize')?.value || '100';
      const params = new URLSearchParams({ page: String(window._signalPage), pageSize });
      if (symbolFilter) params.set('symbol', symbolFilter);
      if (decisionFilter) params.set('decision', decisionFilter);

      // Populate symbol dropdown from runtime config
      const symSelect = document.getElementById('signalFilterSymbol');
      if (symSelect && symSelect.options.length <= 1 && state.summary?.runtimeConfig?.symbols?.length) {
        for (const sym of state.summary.runtimeConfig.symbols) {
          const opt = document.createElement('option');
          opt.value = sym;
          opt.textContent = getBaseSymbol(sym);
          symSelect.appendChild(opt);
        }
        if (symbolFilter) symSelect.value = symbolFilter;
      }

      try {
        const res = await fetchJson(`/api/signal-history?${params}`);
        const data = res.items || [];
        const total = res.total || 0;
        const totalPages = res.totalPages || 1;

        // Update pagination controls
        const pageInfo = document.getElementById('signalPageInfo');
        const prevBtn = document.getElementById('signalPrevBtn');
        const nextBtn = document.getElementById('signalNextBtn');
        if (pageInfo) pageInfo.textContent = `Page ${window._signalPage} of ${totalPages} (${total} signals)`;
        if (prevBtn) prevBtn.disabled = window._signalPage <= 1;
        if (nextBtn) nextBtn.disabled = window._signalPage >= totalPages;

        if (!data.length) {
          body.innerHTML = '<tr><td colspan="7" class="empty-state">No signals recorded yet. Signals will appear after the first cycle runs.</td></tr>';
          return;
        }
        body.innerHTML = data.map(signal => {
          const decision = String(signal.decision || 'HOLD').toUpperCase();
          const decisionClass = decision.toLowerCase();
          const icon = decision === 'BUY' ? '🟢' : decision === 'SELL' ? '🔴' : '⚪';
          const conf = (Number(signal.confidence ?? 0) * 100).toFixed(0);
          const strategies = (signal.strategies || []).join(', ');
          const reasons = (signal.reasons || []).map(prettifyReason).join(' + ') || '—';
          const blocked = signal.blockReason ? `<span class="signal-blocked">${escapeHtml(signal.blockReason)}</span>` : '—';
          const time = new Date(signal.timestamp).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
          return `<tr>
            <td>${escapeHtml(time)}</td>
            <td><strong>${escapeHtml(getBaseSymbol(signal.symbol))}</strong></td>
            <td><span class="signal-tag ${decisionClass}">${icon} ${decision}</span></td>
            <td>${conf}%</td>
            <td style="font-size:11px">${escapeHtml(strategies)}</td>
            <td style="font-size:11px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(reasons)}">${escapeHtml(reasons)}</td>
            <td style="font-size:11px">${blocked}</td>
          </tr>`;
        }).join('');
      } catch {
        body.innerHTML = '<tr><td colspan="7" class="empty-state">Failed to load signal history.</td></tr>';
      }
    }
    window.loadSignalHistory = loadSignalHistory;

    function renderTrades() {
      const allTrades = (state.trades.length ? state.trades : (state.summary?.trades || []));
      const trades = allTrades.slice(0, 20);

      if (!trades.length) {
        el.tradesBody.innerHTML = '<tr><td colspan="9" class="empty-state">No trades yet. Closed positions and new entries will show up here.</td></tr>';
        return;
      }

      el.tradesBody.innerHTML = trades.map((trade) => {
        const side = String(trade.side || 'SELL').toUpperCase();
        const sideClass = side === 'BUY' ? 'buy' : side === 'SELL' ? 'sell' : 'hold';
        const pnl = Number(trade.pnl ?? 0);
        const price = Number(trade.entryPrice ?? trade.price ?? 0);
        const qty   = Number(trade.qty ?? 0);
        const tradeCost = price * qty;
        const tradeSize = side === 'SELL'
          ? Number(trade.exitPrice ?? price) * qty
          : tradeCost;
        const tradePnlPct = tradeCost > 0 ? (pnl / tradeCost) * 100 : null;
        const pnlDisplay = side === 'BUY'
          ? `<span class="neutral">–${formatMoney(tradeCost)}</span>`
          : tradePnlPct !== null
            ? `<span title="${formatSignedMoney(pnl)}" style="cursor:default">${formatPercent(tradePnlPct)}</span>`
            : formatSignedMoney(pnl);
        const base = getBaseSymbol(trade.symbol);
        const isSmoke = String(trade.note || '').includes('smoke-test');
        const tsEncoded = encodeURIComponent(trade.timestamp || '');
        return `
          <tr${isSmoke ? ' style="opacity:0.5" title="Smoke-test trade"' : ''}>
            <td title="${escapeHtml(new Date(trade.timestamp || Date.now()).toLocaleString())}">${escapeHtml(formatTradeTime(trade.timestamp))}${isSmoke ? ' <span style="font-size:0.7em;color:#64748b">🔬</span>' : ''}</td>
            <td>
              <div class="coin-cell">
                <span class="coin-icon">${escapeHtml(base.slice(0, 4))}</span>
                <div class="small-stack">
                  <div class="coin-name">${escapeHtml(base)}</div>
                  <div class="coin-pair">${escapeHtml(trade.symbol || '—')}</div>
                </div>
              </div>
            </td>
            <td><span class="signal-tag ${sideClass}">${escapeHtml(side)}</span></td>
            <td title="${qty > 0 ? formatQty(qty) + ' ' + escapeHtml(getBaseSymbol(trade.symbol)) : ''}">${tradeSize > 0 ? formatMoney(tradeSize) : '—'}</td>
            <td>${trade.entryPrice ? formatPrice(trade.entryPrice, trade.symbol) : trade.price ? formatPrice(trade.price, trade.symbol) : '—'}</td>
            <td>${trade.exitPrice ? formatPrice(trade.exitPrice, trade.symbol) : '—'}</td>
            <td class="${classForValue(pnl)}">${pnlDisplay}</td>
            <td><span class="result-badge">${escapeHtml(tradeResultLabel(trade))}</span></td>
            <td><button class="del-trade-btn" data-ts="${tsEncoded}" title="Delete this trade">✕</button></td>
          </tr>
        `;
      }).join('');

      // Attach delete handlers
      el.tradesBody.querySelectorAll('.del-trade-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteTrade(btn.dataset.ts));
      });
    }

    async function deleteTrade(tsEncoded) {
      const ts = decodeURIComponent(tsEncoded);
      if (!confirm(`Delete this trade entry?\n\n${ts}`)) return;
      try {
        const r = await fetch(`${API_BASE}/api/trades/${tsEncoded}`, { method: 'DELETE' });
        if (r.ok) {
          state.trades = state.trades.filter(t => t.timestamp !== ts);
          renderTrades();
        } else {
          alert('Failed to delete trade');
        }
      } catch { alert('Failed to delete trade'); }
    }
    window.deleteTrade = deleteTrade;

    function renderFooter(summary) {
      const runtime = summary?.runtimeConfig || {};
      // Use the exact next-run timestamp from the backend (aligned to candle close),
      // falling back to the old estimate only if it hasn't been set yet.
      const nextCycleTime = summary?.nextRunAt
        ?? (summary?.lastUpdatedAt && Number(runtime.pollIntervalMs) > 0
          ? new Date(summary.lastUpdatedAt).getTime() + Number(runtime.pollIntervalMs)
          : null);

      el.lastCycle.textContent  = relativeTime(summary?.lastUpdatedAt);
      el.nextCycle.textContent  = nextCycleTime ? relativeTime(nextCycleTime) : '—';
      el.runningFor.textContent = formatDuration(summary?.uptimeMs ?? 0);
      el.timeframe.textContent  = runtime.timeframe || '—';
      el.watching.textContent   = `${getWatchCount(summary)} coin${getWatchCount(summary) === 1 ? '' : 's'}`;
    }

    function toggleLegend() {
      const panel  = document.getElementById('legendPanel');
      const toggle = document.getElementById('legendToggle');
      const open   = panel.classList.toggle('open');
      toggle.textContent = open ? '✕ Close' : 'ℹ Legend';
    }

    function renderFilters(summary) {
      const inner = document.getElementById('filtersInner');
      if (!inner) return;
      const filters  = summary?.activeFilters  || {};
      const blocked  = summary?.blockedStats   || {};
      const strats   = (summary?.strategiesConfig || []).map((s) => s.name);
      const pills    = [];

      // Break-even stop
      const be = filters.breakEven;
      if (be) {
        const pct = be.triggerPct > 0 ? ` +${(be.triggerPct * 100).toFixed(0)}%` : '';
        pills.push(`<span class="filter-pill ${be.enabled ? 'filter-on' : 'filter-off'}" title="Once price rises ${pct}, the stop loss moves to entry price — locking in break-even">⚡ Break-even${escapeHtml(pct)}</span>`);
      }

      // Trailing stop
      const ts = filters.trailingStop;
      if (ts && ts.pct > 0) {
        pills.push(`<span class="filter-pill ${ts.enabled ? 'filter-on' : 'filter-off'}" title="Stop loss trails the price upward, locking in gains as the trade moves in our favour">🔻 Trailing ${(ts.pct * 100).toFixed(0)}%</span>`);
      }

      // Regime filter
      const rc = filters.regime;
      if (rc) {
        pills.push(`<span class="filter-pill ${rc.enabled ? 'filter-on' : 'filter-off'}" title="Blocks new BUY entries when ADX < ${rc.adxThreshold} — the market is ranging/choppy rather than trending">📉 Regime ADX&lt;${rc.adxThreshold}</span>`);
      }

      // Correlation filter
      const cc = filters.correlation;
      if (cc) {
        pills.push(`<span class="filter-pill ${cc.enabled ? 'filter-on' : 'filter-off'}" title="Skips a BUY if an open position has Pearson r &gt; ${cc.threshold} with the incoming coin — avoids doubling up on the same market move">🔗 Correlation r&gt;${cc.threshold}</span>`);
      }

      // Blocked stats this session
      if (blocked.total > 0) {
        pills.push('<span class="filter-divider"></span>');
        const parts = [];
        if (blocked.regime      > 0) parts.push(`${blocked.regime} regime`);
        if (blocked.correlation > 0) parts.push(`${blocked.correlation} corr`);
        if (blocked.daily       > 0) parts.push(`${blocked.daily} daily`);
        if (blocked.risk        > 0) parts.push(`${blocked.risk} risk`);
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        pills.push(`<span class="filter-pill filter-blocked" title="BUY signals blocked by active filters this session">⚠️ ${blocked.total} BUY${blocked.total === 1 ? '' : 's'} blocked${escapeHtml(detail)}</span>`);
      }

      // Active strategies
      if (strats.length) {
        pills.push('<span class="filter-divider"></span>');
        pills.push(`<span class="filter-pill filter-strategies" title="Technical strategies that each cast a vote on every BUY / SELL decision">📊 ${escapeHtml(strats.join(' · '))}</span>`);
      }

      inner.innerHTML = pills.join('') || '<span class="filter-pill filter-off">No filter info yet</span>';
    }

    // Phase 9 — BTC regime, cross-asset context, and circuit-breaker status.
    // Reuses the .filter-pill styling so no new CSS is needed. All fields are
    // optional (null until the first 12h cycle populates them).
    function renderMarketContext(summary) {
      const inner = document.getElementById('marketStripInner');
      if (!inner) return;
      const regime = summary?.regime || null;
      const ctx    = summary?.marketContext || null;
      const cb     = summary?.circuitBreaker || null;
      const pills  = [];
      const niceRegime = (r) => String(r || '').replace('_', ' ');

      if (regime?.label) {
        const bull = String(regime.label).startsWith('BULL');
        const adx  = Number.isFinite(regime.adx) ? ` · ADX ${regime.adx}` : '';
        const when = regime.changedAt ? ' — since ' + new Date(regime.changedAt).toLocaleString() : '';
        pills.push(`<span class="filter-pill ${bull ? 'filter-on' : 'filter-blocked'}" title="BTC market regime (EMA200 × ADX, 3-bar hysteresis)${escapeHtml(when)}">🧭 ${escapeHtml(niceRegime(regime.label))}${escapeHtml(adx)}</span>`);
        if (regime.candidate && regime.candidate !== regime.label && regime.streak > 0) {
          pills.push(`<span class="filter-pill filter-off" title="Pending regime — needs 3 consecutive bars to switch">→ ${escapeHtml(niceRegime(regime.candidate))} (${regime.streak}/3)</span>`);
        }
      } else {
        pills.push('<span class="filter-pill filter-off" title="Regime is computed once per 12h cycle">🧭 Regime — pending first cycle</span>');
      }

      const ctxPills = [];
      if (ctx?.btcDominance?.value != null) {
        const d = ctx.btcDominance;
        const arrow = d.deltaPct > 0.1 ? '▲' : d.deltaPct < -0.1 ? '▼' : '→';
        ctxPills.push(`<span class="filter-pill filter-strategies" title="Bitcoin dominance (% of total mcap). Rising dominance pressures alts; the BTC.D gate blocks alt entries when the 7-day trend rises sharply.">₿.D ${d.value.toFixed(1)}% ${arrow}</span>`);
      }
      if (ctx?.ethBtc?.value != null) {
        const e = ctx.ethBtc;
        const arrow = e.deltaFrac > 0.01 ? '▲' : e.deltaFrac < -0.01 ? '▼' : '→';
        ctxPills.push(`<span class="filter-pill filter-strategies" title="ETH/BTC ratio — rising = altseason on (size up alts), falling = altseason off.">Ξ/₿ ${e.value.toFixed(5)} ${arrow}</span>`);
      }
      if (Number.isFinite(ctx?.fearGreed)) {
        const fg = ctx.fearGreed;
        const label = fg >= 80 ? 'Extreme Greed' : fg >= 60 ? 'Greed' : fg >= 40 ? 'Neutral' : fg >= 20 ? 'Fear' : 'Extreme Fear';
        ctxPills.push(`<span class="filter-pill filter-strategies" title="Crypto Fear &amp; Greed index. >80 tightens entry confidence by +0.05; <20 relaxes it by -0.05 (contrarian).">😱 F&amp;G ${fg} · ${escapeHtml(label)}</span>`);
      }
      if (ctxPills.length) { pills.push('<span class="filter-divider"></span>'); pills.push(...ctxPills); }

      if (cb) {
        const breakers = [];
        if (cb.bearEntriesBlocked) breakers.push(`<span class="filter-pill filter-blocked" title="${escapeHtml(cb.bearReason || 'Bear regime — new entries blocked')}">🐻 Bear: entries blocked</span>`);
        if (cb.weeklyDDActive) {
          const ends = cb.cooldownEndsAt ? ` (ends ${new Date(cb.cooldownEndsAt).toLocaleString()})` : '';
          breakers.push(`<span class="filter-pill filter-blocked" title="Weekly drawdown circuit breaker active — new entries paused${escapeHtml(ends)}">🚨 Weekly DD breaker</span>`);
        }
        pills.push('<span class="filter-divider"></span>');
        pills.push(breakers.length ? breakers.join('') : '<span class="filter-pill filter-on" title="No circuit breaker active — new entries permitted">✅ Breakers clear</span>');
      }

      inner.innerHTML = pills.join('') || '<span class="filter-pill filter-off">No market context yet</span>';
    }

    function renderTsmCore(summary) {
      const strip = document.getElementById('tsmStrip');
      const inner = document.getElementById('tsmStripInner');
      if (!strip || !inner) return;
      const core = summary?.tsmCore || null;
      strip.hidden = !core;
      if (!core) return;

      const updated = document.getElementById('tsmStripUpdated');
      if (updated && core.updatedAt) updated.textContent = `updated ${new Date(core.updatedAt).toLocaleString()}`;

      const pills = [];
      const total = core.symbols?.[0]?.total ?? 3;
      const rule = `enter ${core.enterVotes ?? '·'}/${total} · stay ≥${core.stayVotes ?? '·'} · deploy ${Math.round((core.deploymentPct ?? 0) * 100)}%` +
        (core.volTarget ? ` · vol target ${Math.round(core.volTarget * 100)}%` : '');
      pills.push(`<span class="filter-pill filter-strategies" title="Trend-following core sleeve: long while trailing momentum votes are positive, cash otherwise. No stop loss or take profit — exits only when the vote flips; position size follows a volatility target and the macro overlay.">🧲 ${escapeHtml(rule)}</span>`);

      const m = core.macro || {};
      const stateStr = String(m.state || 'n/a');
      const macroCls = stateStr.toUpperCase().includes('RISK-OFF') ? 'filter-blocked'
        : stateStr.includes('risk-on') ? 'filter-on' : 'filter-off';
      pills.push(`<span class="filter-pill ${macroCls}" title="Equity risk-off overlay: sleeve positions run at half size while the NASDAQ Composite is below its 100-day EMA (crypto has been equity-correlated since 2020).">🏛 NASDAQ ${escapeHtml(stateStr)}</span>`);

      pills.push('<span class="filter-divider"></span>');
      for (const s of core.symbols || []) {
        const positive = Number(s.positive ?? 0);
        const dots = '●'.repeat(positive) + '○'.repeat(Math.max(0, Number(s.total ?? 3) - positive));
        const stateCls = s.held ? 'filter-on' : 'filter-off';
        const vol = Number.isFinite(s.realizedVol) ? ` · vol ${(s.realizedVol * 100).toFixed(0)}%` : '';
        const sizing = s.held
          ? ` · $${Number(s.currentUsd ?? 0).toLocaleString()} of $${Number(s.targetUsd ?? 0).toLocaleString()}`
          : ` · would size ×${Number(s.fraction ?? 1).toFixed(2)}`;
        const warming = s.insufficientHistory ? ' (warming up)' : '';
        pills.push(`<span class="filter-pill ${stateCls}" title="Momentum votes on the trailing lookbacks — all must be positive to enter, a majority to stay. ${s.held ? 'Holding: current vs target sleeve allocation; drift over 15% triggers a rebalance.' : 'In cash until the votes turn positive.'}">${escapeHtml(getBaseSymbol(s.symbol))} ${dots} ${positive}/${Number(s.total ?? 3)} · ${s.held ? 'LONG' : 'CASH'}${escapeHtml(vol)}${escapeHtml(sizing)}${escapeHtml(warming)}</span>`);
      }
      inner.innerHTML = pills.join('');
    }

    function render(summary) {
      state.summary = summary;
      renderHeader(summary);
      renderSummary(summary);
      renderFilters(summary);
      renderMarketContext(summary);
      renderTsmCore(summary);
      renderPositions(summary);
      renderTrades();
      renderFooter(summary);
    }

    function mergeTrade(trade) {
      const key = [trade.timestamp, trade.symbol, trade.side, trade.exitPrice ?? trade.entryPrice ?? trade.price].join('|');
      const existing = new Set();
      const merged = [trade, ...state.trades].filter((item) => {
        const itemKey = [item.timestamp, item.symbol, item.side, item.exitPrice ?? item.entryPrice ?? item.price].join('|');
        if (existing.has(itemKey)) return false;
        existing.add(itemKey);
        return true;
      });
      if (!existing.has(key)) merged.unshift(trade);
      state.trades = merged.slice(0, 50);
    }

    async function loadInitialState() {
      const [summary, trades] = await Promise.all([
        fetchJson('/status'),
        fetchJson('/trades').catch(() => []),
      ]);

      state.trades = Array.isArray(trades) ? trades.slice(0, 50) : (summary.trades || []).slice(0, 50);
      render(summary);
    }

    function connectEvents() {
      clearTimeout(state.reconnectTimer);
      if (state.source) state.source.close();

      const source = new EventSource(endpoint('/events'));
      state.source = source;

      source.onopen = () => setConnection(true);

      source.addEventListener('cycle', (event) => {
        const summary = JSON.parse(event.data);
        state.trades = (summary.trades || []).slice(0, 50);
        render(summary);
      });

      source.addEventListener('trade', (event) => {
        const trade = JSON.parse(event.data);
        mergeTrade(trade);
        renderTrades();
      });

      source.addEventListener('prices', (event) => {
        const prices = JSON.parse(event.data); // { "BCH/USDT": 371.5, ... }
        updatePositionPrices(prices);
        // also update summary prices cache for history-derived positions
        if (state.summary) state.summary.prices = { ...(state.summary.prices || {}), ...prices };
      });

      source.onerror = () => {
        setConnection(false);
        source.close();
        state.reconnectTimer = setTimeout(connectEvents, 3000);
      };
    }

    // Surgically update only price + P&L cells for open positions — no full re-render.
    function updatePositionPrices(prices) {
      const rows = document.querySelectorAll('#positionsBody tr[data-symbol]');
      rows.forEach(row => {
        const symbol = row.dataset.symbol;
        const price  = prices[symbol];
        if (!price) return;
        const entry    = Number(row.dataset.entry);
        const qty      = Number(row.dataset.qty);
        const costBasis = entry * qty;
        const unrealized = (price - entry) * qty;
        const unrealizedPct = costBasis > 0 ? (unrealized / costBasis) * 100 : null;

        const priceCell = row.querySelector('.pos-current-price');
        if (priceCell) priceCell.textContent = formatPrice(price, symbol);

        const pnlCell = row.querySelector('.pos-unrealized');
        if (pnlCell && unrealizedPct !== null) {
          pnlCell.className = `pos-unrealized ${classForValue(unrealized)}`;
          pnlCell.innerHTML = `<span title="${formatSignedMoney(unrealized)}" style="cursor:default">${formatPercent(unrealizedPct)}</span>`;
        }
      });
    }

    renderClock();
    setInterval(renderClock, 1000);
    setInterval(() => {
      if (state.summary) render(state.summary);
    }, 30000);

    // ── Live price polling every 5s with countdown ────────────────────────────
    const PRICE_REFRESH_S = 5;
    let priceCountdown = PRICE_REFRESH_S;
    const countdownEl  = document.getElementById('priceCountdownSecs');
    const countdownWrap = document.getElementById('priceRefreshCountdown');

    async function pollPositionPrices() {
      priceCountdown = PRICE_REFRESH_S;
      try {
        const r = await fetch(`${API_BASE}/api/status`, { cache: 'no-store' });
        if (!r.ok) return;
        const data = await r.json();
        const prices = data.prices || {};
        if (Object.keys(prices).length) updatePositionPrices(prices);
        if (state.summary) state.summary.prices = { ...(state.summary.prices || {}), ...prices };
      } catch (_) {}
    }

    // Tick the countdown every second; fire the poll when it hits 0
    setInterval(() => {
      const hasPositions = document.querySelectorAll('#positionsBody tr[data-symbol]').length > 0;
      if (countdownWrap) countdownWrap.style.display = hasPositions ? 'inline' : 'none';
      if (!hasPositions) { priceCountdown = PRICE_REFRESH_S; return; }
      priceCountdown--;
      if (countdownEl) countdownEl.textContent = Math.max(priceCountdown, 0);
      if (priceCountdown <= 0) pollPositionPrices();
    }, 1000);

    // ── Refresh balance from exchange ──────────────────────────────────────
    async function refreshBalance() {
      const btn = document.getElementById('refreshBalanceBtn');
      if (btn) { btn.disabled = true; btn.textContent = '🔄 Syncing…'; }
      try {
        const r = await fetch(`${API_BASE}/api/refresh-balance`, { method: 'POST' });
        if (!r.ok) { alert('Balance refresh failed'); return; }
        const data = await r.json();
        if (btn) btn.textContent = `✓ $${Number(data.balance ?? 0).toFixed(2)}`;
        // Reload the summary to reflect new balance
        const summary = await fetchJson('/status');
        render(summary);
      } catch (e) {
        if (btn) btn.textContent = '❌ Error';
      } finally {
        setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh Balance'; } }, 3000);
      }
    }
    window.refreshBalance = refreshBalance;

    // ── Manual close position ──────────────────────────────────────────────
    async function confirmClosePosition(symbol) {
      if (!confirm(`Close position: ${symbol} at market price?\n\nThis will place a market SELL order immediately.`)) return;
      const btn = document.querySelector(`.close-pos-btn[data-symbol="${symbol}"]`);
      if (btn) { btn.disabled = true; btn.textContent = 'Closing…'; }
      try {
        const encoded = encodeURIComponent(symbol);
        const r = await fetch(`${API_BASE}/api/close-position/${encoded}`, { method: 'POST' });
        const data = await r.json();
        if (!r.ok) {
          alert(`Failed to close ${symbol}: ${data.error ?? r.statusText}`);
          if (btn) { btn.disabled = false; btn.textContent = 'Close'; }
          return;
        }
        const pnlStr = typeof data.pnl === 'number'
          ? ` · P&L: ${data.pnl >= 0 ? '+' : ''}$${data.pnl.toFixed(2)}`
          : '';
        alert(`✅ ${symbol} closed at $${data.exitPrice?.toFixed?.(4) ?? '?'}${pnlStr}`);
        // Dashboard will refresh via SSE; remove row immediately as feedback
        const row = document.querySelector(`#positionsBody tr[data-symbol="${symbol}"]`);
        if (row) row.remove();
      } catch (e) {
        alert(`Error closing ${symbol}: ${e.message}`);
        if (btn) { btn.disabled = false; btn.textContent = 'Close'; }
      }
    }
    window.confirmClosePosition = confirmClosePosition;


    function logLevelColor(line) {
      if (line.includes(' error:') || line.includes('❌')) return '#f87171';
      if (line.includes(' warn:')  || line.includes('⚠️')) return '#fb923c';
      if (line.includes('🔬'))                              return '#818cf8';
      if (line.includes('✅') || line.includes('BUY '))     return '#4ade80';
      if (line.includes('SELL '))                           return '#f472b6';
      return '#94a3b8';
    }
    let _logsAbort = null;
    let _logsDebounce = null;

    async function loadLogs() {
      const body   = document.getElementById('logsBody');
      const lines  = document.getElementById('logLines')?.value || 500;
      const filterRaw = document.getElementById('logFilter')?.value?.trim() || '';
      const filter = encodeURIComponent(filterRaw);
      if (!body) return;

      // Cancel any in-flight request so stale responses can't overwrite newer ones
      if (_logsAbort) { _logsAbort.abort(); }
      _logsAbort = new AbortController();
      const signal = _logsAbort.signal;

      try {
        const r = await fetch(`${API_BASE}/api/logs?lines=${lines}&filter=${filter}`, { cache: 'no-store', signal });
        const data = await r.json();
        if (!data.lines?.length) {
          body.innerHTML = filterRaw
            ? `<div style="color:#475569">No log entries match <strong style="color:#94a3b8">${escapeHtml(filterRaw)}</strong>.</div>`
            : '<div style="color:#475569">No log entries found.</div>';
          return;
        }
        body.innerHTML = data.lines.map(line =>
          `<div style="color:${logLevelColor(line)};border-bottom:1px solid #1e293b;padding:1px 0">${escapeHtml(line)}</div>`
        ).join('');
      } catch (e) {
        if (e.name === 'AbortError') return; // superseded by newer request — ignore
        body.innerHTML = `<div style="color:#f87171">Failed to load logs: ${escapeHtml(e.message)}</div>`;
      }
    }
    window.loadLogs = loadLogs;

    // Debounced version for the filter input — waits 300 ms after last keystroke
    function loadLogsDebounced() {
      clearTimeout(_logsDebounce);
      _logsDebounce = setTimeout(loadLogs, 300);
    }
    window.loadLogsDebounced = loadLogsDebounced;

    // Auto-refresh logs every 15s if logs tab is active
    setInterval(() => {
      if (document.getElementById('tab-logs')?.classList.contains('active')) loadLogs();
      if (document.getElementById('tab-signals')?.classList.contains('active')) loadSignalHistory();
    }, 15000);
    loadLogs();

    // ── Tab navigation ───────────────────────────────────────────────────
    function switchTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === `tab-${tabId}`));
      localStorage.setItem('playai-active-tab', tabId);
      if (tabId === 'logs') loadLogs();
      if (tabId === 'signals') loadSignalHistory();
      if (tabId === 'tools') { renderPnlChart(); renderDailyPnlChart(); }
    }
    window.switchTab = switchTab;

    // Restore tab from localStorage
    (function restoreTab() {
      const saved = localStorage.getItem('playai-active-tab');
      if (saved && document.getElementById(`tab-${saved}`)) switchTab(saved);
    })();

    // ── P&L Chart ─────────────────────────────────────────────────────────
    let _pnlChartDataFull = [];
    let _cumulativeRange = 'all';

    function rangeToCutoff(range) {
      if (range === 'all') return 0;
      const days = { '7d': 7, '30d': 30, '180d': 180, '365d': 365 }[range] || 30;
      return Date.now() - days * 86400000;
    }

    function filterByRange(data, range, timeKey = 'time') {
      const cutoff = rangeToCutoff(range);
      if (!cutoff) return data;
      return data.filter(d => {
        const t = d[timeKey] instanceof Date ? d[timeKey].getTime() : new Date(d[timeKey]).getTime();
        return t >= cutoff;
      });
    }

    async function fetchPnlData() {
      try {
        const trades = await fetch(`${API_BASE}/api/trades`, { cache: 'no-store' }).then(r => r.json());
        if (!Array.isArray(trades)) return [];
        const closed = trades
          .filter(t => t.side === 'SELL' && t.pnl != null)
          .sort((a, b) => new Date(a.exitTime || a.timestamp).getTime() - new Date(b.exitTime || b.timestamp).getTime());
        let cumulative = 0;
        return closed.map(t => {
          cumulative += Number(t.pnl || 0);
          return { time: new Date(t.exitTime || t.timestamp), pnl: cumulative, symbol: t.symbol, tradePnl: Number(t.pnl || 0) };
        });
      } catch (e) { return []; }
    }

    function renderPnlChart() {
      fetchPnlData().then(data => {
        _pnlChartDataFull = data;
        const filtered = filterByRange(data, _cumulativeRange);
        drawPnlCanvas(filtered);
      });
    }

    function drawPnlCanvas(data) {
      const canvas = document.getElementById('pnlCanvas');
      const totalEl = document.getElementById('pnlTotalValue');
      if (!canvas) return;

      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const W = rect.width;
      const H = rect.height;
      const pad = { top: 20, right: 20, bottom: 40, left: 65 };
      const chartW = W - pad.left - pad.right;
      const chartH = H - pad.top - pad.bottom;

      ctx.clearRect(0, 0, W, H);

      // Total display
      const total = data.length ? data[data.length - 1].pnl : 0;
      if (totalEl) {
        const sign = total >= 0 ? '+' : '';
        totalEl.textContent = `${sign}$${Math.abs(total).toFixed(2)}`;
        totalEl.style.color = total >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
      }

      if (data.length === 0) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Not enough closed trades to plot chart', W / 2, H / 2);
        return;
      }

      const pnls = data.map(d => d.pnl);
      const minPnl = Math.min(0, ...pnls);
      const maxPnl = Math.max(0, ...pnls);
      const range = maxPnl - minPnl || 1;
      const minTime = data[0].time.getTime();
      const maxTime = data[data.length - 1].time.getTime();
      const timeRange = maxTime - minTime || 1;

      function xPos(t) { return pad.left + ((t.getTime() - minTime) / timeRange) * chartW; }
      function yPos(v) { return pad.top + chartH - ((v - minPnl) / range) * chartH; }

      // Grid lines
      ctx.strokeStyle = 'rgba(48, 54, 61, 0.5)';
      ctx.lineWidth = 0.5;
      const gridLines = 5;
      for (let i = 0; i <= gridLines; i++) {
        const y = pad.top + (i / gridLines) * chartH;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + chartW, y);
        ctx.stroke();
        // Y label
        const val = maxPnl - (i / gridLines) * range;
        ctx.fillStyle = '#8b949e';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`$${val.toFixed(2)}`, pad.left - 8, y + 4);
      }

      // Zero line
      const zeroY = yPos(0);
      ctx.strokeStyle = 'rgba(139, 148, 158, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(pad.left + chartW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      // X-axis labels
      ctx.fillStyle = '#8b949e';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      const xLabels = Math.min(6, data.length);
      for (let i = 0; i < xLabels; i++) {
        const idx = Math.round((i / (xLabels - 1)) * (data.length - 1));
        const d = data[idx].time;
        const label = `${d.getMonth() + 1}/${d.getDate()}`;
        ctx.fillText(label, xPos(d), H - pad.bottom + 20);
      }

      // Draw line with gradient fill
      ctx.beginPath();
      ctx.moveTo(xPos(data[0].time), yPos(data[0].pnl));
      for (let i = 1; i < data.length; i++) {
        ctx.lineTo(xPos(data[i].time), yPos(data[i].pnl));
      }

      // Stroke the line
      const lineGrad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
      lineGrad.addColorStop(0, '#3fb950');
      lineGrad.addColorStop(1, '#f85149');
      ctx.strokeStyle = total >= 0 ? '#3fb950' : '#f85149';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Fill area to zero
      ctx.lineTo(xPos(data[data.length - 1].time), zeroY);
      ctx.lineTo(xPos(data[0].time), zeroY);
      ctx.closePath();
      const fillColor = total >= 0 ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)';
      ctx.fillStyle = fillColor;
      ctx.fill();

      // Data points
      for (let i = 0; i < data.length; i++) {
        ctx.beginPath();
        ctx.arc(xPos(data[i].time), yPos(data[i].pnl), 3, 0, Math.PI * 2);
        ctx.fillStyle = data[i].tradePnl >= 0 ? '#3fb950' : '#f85149';
        ctx.fill();
      }

      // Store chart params for tooltip
      canvas._chartParams = { data, xPos, yPos, pad, W, H, chartW, chartH };
    }

    // Tooltip on hover
    (function setupPnlTooltip() {
      const canvas = document.getElementById('pnlCanvas');
      const tooltip = document.getElementById('pnlTooltip');
      if (!canvas || !tooltip) return;

      canvas.addEventListener('mousemove', (e) => {
        const params = canvas._chartParams;
        if (!params || !params.data.length) { tooltip.style.display = 'none'; return; }
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        if (mx < params.pad.left || mx > params.W - params.pad.right) { tooltip.style.display = 'none'; return; }

        // Find closest data point
        let closest = 0;
        let closestDist = Infinity;
        for (let i = 0; i < params.data.length; i++) {
          const dx = Math.abs(params.xPos(params.data[i].time) - mx);
          if (dx < closestDist) { closestDist = dx; closest = i; }
        }
        const d = params.data[closest];
        const sign = d.pnl >= 0 ? '+' : '';
        tooltip.innerHTML = `<div><strong>${d.time.toLocaleDateString()}</strong></div><div>Cumulative: ${sign}$${d.pnl.toFixed(2)}</div><div style="color:var(--muted)">${d.symbol} ${d.tradePnl >= 0 ? '+' : ''}$${d.tradePnl.toFixed(2)}</div>`;
        tooltip.style.display = 'block';
        const tx = Math.min(mx + 12, params.W - 160);
        const ty = Math.max(my - 60, 4);
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
      });

      canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    })();

    // Auto-refresh P&L chart every 60s if visible
    setInterval(() => {
      if (document.getElementById('tab-tools')?.classList.contains('active')) {
        renderPnlChart();
        renderDailyPnlChart();
      }
    }, 60000);

    // Redraw on resize
    window.addEventListener('resize', () => {
      if (document.getElementById('tab-tools')?.classList.contains('active')) {
        if (_pnlChartDataFull.length) drawPnlCanvas(filterByRange(_pnlChartDataFull, _cumulativeRange));
        if (_dailyPnlDataFull.length) drawDailyPnlCanvas(filterByRange(_dailyPnlDataFull, _dailyRange, 'date'));
      }
    });

    // ── Daily P&L Bar Chart ─────────────────────────────────────────────────────
    let _dailyPnlDataFull = [];
    let _dailyRange = 'all';

    async function fetchDailyPnl() {
      try {
        const data = await fetch(`${API_BASE}/api/daily-pnl`, { cache: 'no-store' }).then(r => r.json());
        return Array.isArray(data) ? data : [];
      } catch { return []; }
    }

    function renderDailyPnlChart() {
      fetchDailyPnl().then(data => {
        _dailyPnlDataFull = data;
        const filtered = filterDailyByRange(data, _dailyRange);
        drawDailyPnlCanvas(filtered);
        updatePeriodSummary(filtered);
      });
    }

    function filterDailyByRange(data, range) {
      if (range === 'all') return data;
      const days = { '7d': 7, '30d': 30, '180d': 180, '365d': 365 }[range] || 30;
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      return data.filter(d => d.date >= cutoff);
    }

    function updatePeriodSummary(data) {
      const el7 = document.getElementById('weeklyPnlValue');
      const elTrades = document.getElementById('weeklyPnlTrades');
      if (!el7) return;

      const totalPnl = data.reduce((sum, d) => sum + d.pnl, 0);
      const totalTrades = data.reduce((sum, d) => sum + d.trades, 0);
      const totalWins = data.reduce((sum, d) => sum + d.wins, 0);
      const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '—';

      const sign = totalPnl >= 0 ? '+' : '';
      el7.textContent = `${sign}$${Math.abs(totalPnl).toFixed(2)}`;
      el7.style.color = totalPnl >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
      elTrades.textContent = totalTrades > 0 ? `(${totalTrades} trades, ${wr}% WR)` : '';
    }

    function drawDailyPnlCanvas(data) {
      const canvas = document.getElementById('dailyPnlCanvas');
      if (!canvas) return;

      const rect = canvas.parentElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';

      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      const W = rect.width;
      const H = rect.height;
      const pad = { top: 20, right: 20, bottom: 40, left: 65 };
      const chartW = W - pad.left - pad.right;
      const chartH = H - pad.top - pad.bottom;

      ctx.clearRect(0, 0, W, H);

      if (data.length === 0) {
        ctx.fillStyle = '#8b949e';
        ctx.font = '14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No daily P&L data for this period', W / 2, H / 2);
        return;
      }

      // Compute cumulative daily P&L for the line
      let cumulative = 0;
      const points = data.map(d => {
        cumulative += d.pnl;
        return { date: d.date, cumPnl: cumulative, dayPnl: d.pnl, trades: d.trades, wins: d.wins, realized: d.realized, unrealized: d.unrealized };
      });

      const pnls = points.map(p => p.cumPnl);
      const minPnl = Math.min(0, ...pnls);
      const maxPnl = Math.max(0, ...pnls);
      const range = (maxPnl - minPnl) || 1;

      function xPos(i) { return pad.left + (i / Math.max(points.length - 1, 1)) * chartW; }
      function yPos(v) { return pad.top + chartH - ((v - minPnl) / range) * chartH; }
      const zeroY = yPos(0);

      // Grid lines
      ctx.strokeStyle = 'rgba(48, 54, 61, 0.5)';
      ctx.lineWidth = 0.5;
      const gridLines = 5;
      for (let i = 0; i <= gridLines; i++) {
        const y = pad.top + (i / gridLines) * chartH;
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + chartW, y);
        ctx.stroke();
        const val = maxPnl - (i / gridLines) * range;
        ctx.fillStyle = '#8b949e';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`$${val.toFixed(2)}`, pad.left - 8, y + 4);
      }

      // Zero line
      ctx.strokeStyle = 'rgba(139, 148, 158, 0.4)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, zeroY);
      ctx.lineTo(pad.left + chartW, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);

      // X-axis date labels
      ctx.fillStyle = '#8b949e';
      ctx.font = '11px Inter, sans-serif';
      ctx.textAlign = 'center';
      const xLabels = Math.min(6, points.length);
      for (let i = 0; i < xLabels; i++) {
        const idx = Math.round((i / (xLabels - 1)) * (points.length - 1));
        const dt = new Date(points[idx].date);
        ctx.fillText(`${dt.getMonth() + 1}/${dt.getDate()}`, xPos(idx), H - pad.bottom + 20);
      }

      // Draw line
      ctx.beginPath();
      ctx.moveTo(xPos(0), yPos(points[0].cumPnl));
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(xPos(i), yPos(points[i].cumPnl));
      }
      const total = points[points.length - 1].cumPnl;
      ctx.strokeStyle = total >= 0 ? '#3fb950' : '#f85149';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Fill area to zero
      ctx.lineTo(xPos(points.length - 1), zeroY);
      ctx.lineTo(xPos(0), zeroY);
      ctx.closePath();
      ctx.fillStyle = total >= 0 ? 'rgba(63, 185, 80, 0.1)' : 'rgba(248, 81, 73, 0.1)';
      ctx.fill();

      // Data points
      for (let i = 0; i < points.length; i++) {
        ctx.beginPath();
        ctx.arc(xPos(i), yPos(points[i].cumPnl), 3, 0, Math.PI * 2);
        ctx.fillStyle = points[i].dayPnl >= 0 ? '#3fb950' : '#f85149';
        ctx.fill();
      }

      // Store for tooltip
      canvas._chartParams = { data: points, xPos, yPos, pad, W, H, chartW, chartH };
    }

    // Tooltip for daily P&L
    (function setupDailyPnlTooltip() {
      const canvas = document.getElementById('dailyPnlCanvas');
      const tooltip = document.getElementById('dailyPnlTooltip');
      if (!canvas || !tooltip) return;

      canvas.addEventListener('mousemove', (e) => {
        const p = canvas._chartParams;
        if (!p || !p.data.length) { tooltip.style.display = 'none'; return; }
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        if (mx < p.pad.left || mx > p.W - p.pad.right) { tooltip.style.display = 'none'; return; }

        // Find closest data point
        let closest = 0, closestDist = Infinity;
        for (let i = 0; i < p.data.length; i++) {
          const dx = Math.abs(p.xPos(i) - mx);
          if (dx < closestDist) { closestDist = dx; closest = i; }
        }
        const d = p.data[closest];
        const sign = d.dayPnl >= 0 ? '+' : '';
        const cumSign = d.cumPnl >= 0 ? '+' : '';
        const wr = d.trades > 0 ? ((d.wins / d.trades) * 100).toFixed(0) : '—';
        const realStr = d.realized ? `Realized: ${d.realized >= 0 ? '+' : ''}$${Math.abs(d.realized).toFixed(2)}` : '';
        const unrealStr = d.unrealized ? ` · Open: ${d.unrealized >= 0 ? '+' : '-'}$${Math.abs(d.unrealized).toFixed(2)}` : '';
        tooltip.innerHTML = `<div><strong>${d.date}</strong></div><div>Day: ${sign}$${Math.abs(d.dayPnl).toFixed(2)}</div><div>Cumulative: ${cumSign}$${Math.abs(d.cumPnl).toFixed(2)}</div><div style="color:var(--muted)">${realStr}${unrealStr}</div><div style="color:var(--muted)">${d.trades} trade${d.trades !== 1 ? 's' : ''} · ${wr}% WR</div>`;
        tooltip.style.display = 'block';
        tooltip.style.left = Math.min(mx + 12, p.W - 180) + 'px';
        tooltip.style.top = Math.max(e.clientY - rect.top - 80, 4) + 'px';
      });

      canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    })();

    // ── Range button handlers ─────────────────────────────────────────────────
    document.getElementById('cumulativeRangeBtns')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      _cumulativeRange = btn.dataset.range;
      document.querySelectorAll('#cumulativeRangeBtns .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawPnlCanvas(filterByRange(_pnlChartDataFull, _cumulativeRange));
    });

    document.getElementById('dailyRangeBtns')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      _dailyRange = btn.dataset.range;
      document.querySelectorAll('#dailyRangeBtns .range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filtered = filterDailyByRange(_dailyPnlDataFull, _dailyRange);
      drawDailyPnlCanvas(filtered);
      updatePeriodSummary(filtered);
    });

    // ── Deposit Tracker ───────────────────────────────────────────────────────
    async function loadDeposits() {
      try {
        const deposits = await fetch(`${API_BASE}/api/deposits`).then(r => r.json());
        const list = document.getElementById('depositList');
        const totalEl = document.getElementById('depositTotal');
        const roiEl = document.getElementById('depositROI');
        if (!Array.isArray(deposits)) return;

        const total = deposits.reduce((s, d) => s + d.amount, 0);
        totalEl.textContent = `$${total.toFixed(2)}`;

        // Compute true ROI: (portfolio total value - total deposited) / total deposited
        // portfolioValue shows cash only; portfolioSub has the full value including open positions
        const subText = document.getElementById('portfolioSub')?.textContent || '';
        const totalMatch = subText.match(/Portfolio total:\s*\$([0-9,.]+)/);
        const cashText = document.getElementById('portfolioValue')?.textContent || '';
        const cashBalance = parseFloat(cashText.replace(/[^0-9.-]/g, '')) || 0;
        const portfolioTotal = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : cashBalance;
        if (total > 0 && portfolioTotal > 0) {
          const roi = ((portfolioTotal - total) / total * 100).toFixed(1);
          roiEl.textContent = `${roi >= 0 ? '+' : ''}${roi}%`;
          roiEl.style.color = roi >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
        } else {
          roiEl.textContent = '—';
          roiEl.style.color = 'var(--muted)';
        }

        if (!deposits.length) {
          list.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">No deposits recorded yet.</div>';
          return;
        }

        list.innerHTML = deposits.slice().reverse().map(d => {
          const date = d.date || new Date(d.timestamp).toISOString().slice(0, 10);
          const displayDate = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
          const sign = d.amount >= 0 ? '+' : '';
          const color = d.amount >= 0 ? 'var(--green-bright)' : 'var(--red-bright)';
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-bottom:1px solid var(--border);font-size:12px">
            <span>${displayDate}${d.note ? ' — <span style="color:var(--muted)">' + d.note + '</span>' : ''}</span>
            <span style="display:flex;align-items:center;gap:12px">
              <strong style="color:${color}">${sign}$${Math.abs(d.amount).toFixed(2)}</strong>
              <button onclick="removeDeposit(${d.id})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px" title="Remove">×</button>
            </span>
          </div>`;
        }).join('');
      } catch (e) { /* silent */ }
    }

    async function addDeposit() {
      const amountEl = document.getElementById('depositAmount');
      const noteEl = document.getElementById('depositNote');
      const dateEl = document.getElementById('depositDate');
      const amount = parseFloat(amountEl.value);
      if (!amount || isNaN(amount)) { amountEl.focus(); return; }
      const date = dateEl.value || new Date().toISOString().slice(0, 10);
      const resp = await fetch(`${API_BASE}/api/deposits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, note: noteEl.value.trim(), date }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: 'Unknown error' }));
        alert(`Failed to save deposit: ${err.error || resp.statusText}`);
        return;
      }
      amountEl.value = '';
      noteEl.value = '';
      dateEl.value = '';
      loadDeposits();
    }
    window.addDeposit = addDeposit;

    async function removeDeposit(id) {
      if (!confirm('Remove this deposit entry?')) return;
      await fetch(`${API_BASE}/api/deposits/${id}`, { method: 'DELETE' });
      loadDeposits();
    }
    window.removeDeposit = removeDeposit;

    // Load deposits when tools tab opens
    const origSwitchTab = window.switchTab;
    window.switchTab = function(tabId) {
      origSwitchTab(tabId);
      if (tabId === 'tools') {
        loadDeposits();
        const dateEl = document.getElementById('depositDate');
        if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
      }
    };
    // Initial load if tools tab is active
    if (document.getElementById('tab-tools')?.classList.contains('active')) loadDeposits();

    loadInitialState()
      .catch(() => {
        el.tradesBody.innerHTML = '<tr><td colspan="8" class="empty-state">Could not load the dashboard. Make sure the bot is running on http://localhost:3001.</td></tr>';
      })
      .finally(connectEvents);

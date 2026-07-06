//测试git推送
(function () {
  'use strict';

  if (document.querySelector('#gme-root')) return;

  // ══════════════════════════════════════════════════════
  //  常量
  // ══════════════════════════════════════════════════════

  const MANUAL_TOKEN_KEY = 'gme_manual_token';
  const STORAGE = chrome.storage.local;
  const FEE_RATE = 0.15;

  // ══════════════════════════════════════════════════════
  //  状态
  // ══════════════════════════════════════════════════════

  let STATE = {
    history: [],           // 原始事件
    deals: [],             // event==="deal"
    pending: [],           // event==="new"
    stats: null,
    tokenSource: null,
    loading: false,
    page: 0,
    pageSize: 15,
    sortCol: 'ts',
    sortDir: 'desc',
    assetCache: new Map(), // itemdefid -> { name, icon_url, tags }
    assetCacheLoading: new Set()
  };

  // ══════════════════════════════════════════════════════
  //  Token 管理
  // ══════════════════════════════════════════════════════

  // content script 运行在隔离世界，无法直接访问页面 localStorage，
  // 通过 background 的 chrome.scripting.executeScript(world:'MAIN') 读取
  let _autoTokenPromise = null;

  function getAutoToken() {
    if (_autoTokenPromise) return _autoTokenPromise;
    _autoTokenPromise = chrome.runtime.sendMessage({ type: 'GET_AUTO_TOKEN' })
      .then(r => r?.token || null)
      .catch(() => null)
      .then(t => { _autoTokenPromise = null; return t; });
    return _autoTokenPromise;
  }

  function getManualToken() {
    return new Promise(r => STORAGE.get(MANUAL_TOKEN_KEY, res => r(res[MANUAL_TOKEN_KEY] || null)));
  }

  function saveManualToken(t) {
    return new Promise(r => STORAGE.set({ [MANUAL_TOKEN_KEY]: t }, r));
  }

  function clearManualToken() {
    return new Promise(r => STORAGE.remove(MANUAL_TOKEN_KEY, r));
  }

  async function getToken() {
    const a = await getAutoToken(); if (a) { STATE.tokenSource = 'auto'; return a; }
    const m = await getManualToken(); if (m) { STATE.tokenSource = 'manual'; return m; }
    STATE.tokenSource = null; return null;
  }

  // ══════════════════════════════════════════════════════
  //  API 调用
  // ══════════════════════════════════════════════════════

  async function authFetch(endpoint, actionName, extraParams = {}) {
    const token = await getToken();
    if (!token) throw new Error('TokenNotFound');
    const parts = [`action=${encodeURIComponent(actionName)}`, `token=${encodeURIComponent(token)}`, 'appid=1067', 'language=zh_CN'];
    for (const [k, v] of Object.entries(extraParams)) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    const resp = await fetch(`https://market-proxy.gaijin.net${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://trade.gaijin.net',
        'Referer': 'https://trade.gaijin.net/'
      },
      body: parts.join('&')
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  // ── 物品信息缓存 ─────────────────────────────────────

  function extractItemdefid(hashname) {
    if (!hashname) return null;
    if (hashname.startsWith('ugcitem_')) return hashname.substring(8);
    if (hashname.startsWith('item_')) return hashname.substring(5);
    const m = hashname.match(/^id(\d+)/);
    if (m) return m[1];
    if (/^\d+$/.test(hashname)) return hashname;
    return null;
  }

  async function resolveAssetInfo(hashname) {
    if (!hashname) return null;
    const cached = STATE.assetCache.get(hashname);
    if (cached) return cached;

    const itemdefid = extractItemdefid(hashname);
    if (!itemdefid || STATE.assetCacheLoading.has(itemdefid)) {
      // 返回一个临时名称
      return { name: hashname, icon_url: null, tags: [] };
    }

    STATE.assetCacheLoading.add(itemdefid);
    try {
      const data = await authFetch('/assetAPI', 'GetAssetClassInfo', {
        'class_name0': '__itemdefid',
        'class_value0': itemdefid,
        'class_count': '1'
      });
      const asset = data?.result?.asset;
      if (asset) {
        const info = {
          name: asset.market_name || hashname,
          icon_url: asset.icon_url || null,
          tags: []
        };
        // 解析 tags
        if (asset.tags && Array.isArray(asset.tags)) {
          info.tags = asset.tags.filter(t => t && t.name).map(t => ({
            name: t.name,
            color: t.color || '#888',
            category: t.category || ''
          }));
        }
        STATE.assetCache.set(hashname, info);
        STATE.assetCache.set(itemdefid, info); // 也用 id 缓存
        return info;
      }
    } catch { /* ignore */ }
    STATE.assetCacheLoading.delete(itemdefid);
    return { name: hashname, icon_url: null, tags: [] };
  }

  async function enrichEvents(events) {
    const unique = new Set();
    events.forEach(e => {
      const key = e.hashname || e.market_name;
      if (key && !STATE.assetCache.has(key)) unique.add(key);
    });
    // 并行加载前20个
    // 并行加载（分批，每批 10 个，避免并发过多）
    const entries = Array.from(unique);
    for (let i = 0; i < entries.length; i += 10) {
      const batch = entries.slice(i, i + 10);
      await Promise.allSettled(batch.map(h => resolveAssetInfo(h)));
    }
  }

  // ── 加载交易历史 ─────────────────────────────────────

  async function loadHistory() {
    const token = await getToken();
    if (!token) { updateStatsBar('❌ 未找到 Token，请在设置页手动输入'); return; }

    STATE.loading = true;
    setBtn('#gme-load-history', true);
    updateStatsBar('📥 正在加载...');

    try {
      const PAGE_SIZE = 100, MAX_PAGES = 15;
      let all = [], skip = 0;

      for (let p = 0; p < MAX_PAGES; p++) {
        const data = await authFetch('/web', 'cln_get_user_history', { count: String(PAGE_SIZE), skip: String(skip) });
        const evts = data?.response?.events || [];
        if (!evts.length) break;
        all = all.concat(evts);
        skip += evts.length;
        updateStatsBar(`📥 ${all.length} 条...`);
        if (evts.length < PAGE_SIZE) break;
      }

      STATE.history = all;
      STATE.deals = all.filter(e => e.event === 'deal');

      // 过滤活跃挂单：event==='new' 且没有对应的 cancel 或 deal 记录
      const newOrderIds = new Set();
      const closedOrderIds = new Set(); // 已取消或已成交的 orderId
      for (const e of all) {
        if (e.event === 'new' && e.orderId) newOrderIds.add(e.orderId);
        if ((e.event === 'cancel' || e.event === 'deal') && e.orderId) closedOrderIds.add(e.orderId);
      }
      // 活跃挂单 = 所有 'new' 中排除已关闭的
      STATE.pending = all.filter(e => e.event === 'new' && e.orderId && !closedOrderIds.has(e.orderId));
      // 去重：同一个 orderId 只保留一条（最新的）
      const seen = new Set();
      STATE.pending = STATE.pending.filter(e => {
        if (seen.has(e.orderId)) return false;
        seen.add(e.orderId);
        return true;
      });

      // 后台缓存
      chrome.runtime.sendMessage({ type: 'STORE_TRADE_BATCH', events: all.slice(0, 2000) });

      // 异步加载物品信息 — 等待完成后再渲染
      await enrichEvents(all);

      computeStats();
      renderHistory();
      renderStats();
      updateStatsBar();
    } catch (err) {
      updateStatsBar(err.message === 'TokenNotFound' ? '❌ Token 无效' : `❌ ${err.message}`);
    } finally {
      STATE.loading = false;
      setBtn('#gme-load-history', false);
    }
  }

  function setBtn(sel, disabled) {
    const b = document.querySelector(sel);
    if (b) b.disabled = disabled;
  }

  // ══════════════════════════════════════════════════════
  //  统计计算
  // ══════════════════════════════════════════════════════

  function computeStats() {
    let totalBuy = 0, totalSell = 0, buyCnt = 0, sellCnt = 0;
    const itemMap = {};

    for (const e of STATE.deals) {
      const price = (e.price || 0) / 10000;
      const qty = e.count || 1;
      const total = price * qty;
      if (e.type === 'BUY') { totalBuy += total; buyCnt += qty; }
      else { totalSell += total; sellCnt += qty; }

      const key = e.hashname || e.market_name || e.id;
      const cached = STATE.assetCache.get(key) || STATE.assetCache.get(e.hashname);
      const displayName = cached?.name || e.market_name || key;
      if (!itemMap[key]) itemMap[key] = { name: displayName, buyQty: 0, sellQty: 0, buyTotal: 0, sellTotal: 0, sellNet: 0 };
      if (e.type === 'BUY') { itemMap[key].buyQty += qty; itemMap[key].buyTotal += total; }
      else { itemMap[key].sellQty += qty; itemMap[key].sellTotal += total; itemMap[key].sellNet += total * (1 - FEE_RATE); }
    }

    const fee = totalSell * FEE_RATE;
    const net = totalSell * (1 - FEE_RATE);
    const profit = net - totalBuy;
    const margin = totalBuy > 0 ? ((profit / totalBuy) * 100) : 0;

    STATE.stats = {
      total: STATE.history.length, deals: STATE.deals.length, pending: STATE.pending.length,
      buyCnt, sellCnt, totalBuy, totalSell, fee, net, profit, margin,
      items: Object.values(itemMap).sort((a, b) => (b.sellNet - b.buyTotal) - (a.sellNet - a.buyTotal))
    };
  }

  // ══════════════════════════════════════════════════════
  //  DOM 工具
  // ══════════════════════════════════════════════════════

  function qs(s, ctx) { return (ctx || document).querySelector(s); }
  function qsa(s, ctx) { return Array.from((ctx || document).querySelectorAll(s)); }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'innerHTML') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
      else e.setAttribute(k, v);
    }
    for (const c of (Array.isArray(children) ? children : [children])) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c instanceof Node) e.appendChild(c);
    }
    return e;
  }

  // ── 物品单元格渲染 ───────────────────────────────────

  function renderItemCell(event) {
    const name = event.itemName || event.market_name || event.hashname || 'N/A';
    const firstLetter = name.charAt(0).toUpperCase();
    const cached = STATE.assetCache.get(event.hashname) || STATE.assetCache.get(extractItemdefid(event.hashname));
    const displayName = cached?.name || name;
    const iconUrl = cached?.icon_url || null;
    const tags = cached?.tags || event.tags || [];

    let html = '<div class="item-cell">';
    if (iconUrl) {
      html += `<img class="item-icon" src="${iconUrl}" alt="${displayName}" data-fl="${firstLetter}" data-fn="${displayName}" loading="lazy" />`;
    } else {
      html += `<div class="item-icon-placeholder" title="${displayName}">${firstLetter}</div>`;
    }
    html += `<div><div class="item-name" title="${displayName}">${displayName}</div>`;
    if (tags.length > 0) {
      html += '<div class="item-tags">';
      tags.filter(t => t.category === 'quality' || t.category === 'country').forEach(t => {
        const c = t.color ? (t.color.startsWith('#') ? t.color : '#' + t.color) : '#888';
        html += `<span class="tag" style="background:${c}">${t.name}</span>`;
      });
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function attachImageFallbacks(container) {
    if (!container) return;
    container.querySelectorAll('.item-icon').forEach(img => {
      if (img.complete && img.naturalWidth === 0) replaceIcon(img);
      else img.onerror = () => replaceIcon(img);
    });
  }

  function replaceIcon(img) {
    const letter = img.getAttribute('data-fl') || '?';
    const name = img.getAttribute('data-fn') || '';
    const div = document.createElement('div');
    div.className = 'item-icon-placeholder';
    div.title = name;
    div.textContent = letter;
    img.replaceWith(div);
  }

  // ── 详情弹窗 ───────────────────────────────────────

  function showModal(event) {
    const overlay = el('div', { className: 'gme-modal-overlay' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const price = (event.price || 0) / 10000;
    const total = price * (event.count || 1);
    const isSell = event.type === 'SELL';
    const expected = isSell ? total * (1 - FEE_RATE) : total / (1 - FEE_RATE);
    const time = event.ts ? new Date(event.ts * 1000).toLocaleString('zh-CN') : '-';

    overlay.innerHTML = `
      <div class="gme-modal">
        <div class="gme-modal-header">
          <span class="gme-modal-title">订单详情</span>
          <button class="gme-btn gme-btn-sm" onclick="this.closest('.gme-modal-overlay').remove()">✕</button>
        </div>
        <div class="gme-modal-body">
          <div class="gme-detail-row"><span class="gme-detail-label">订单ID</span><span class="gme-detail-value mono">${event.orderId || 'N/A'}</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">类型</span><span class="gme-detail-value">${isSell ? '出售' : '购买'}</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">物品</span><span class="gme-detail-value">${event.market_name || event.hashname || '-'}</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">单价</span><span class="gme-detail-value ${isSell ? 'price-sell' : 'price-buy'}">${price.toFixed(2)} GJN</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">数量</span><span class="gme-detail-value mono">${event.count}</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">总价</span><span class="gme-detail-value">${total.toFixed(2)} GJN</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">预期金额</span><span class="gme-detail-value">${expected.toFixed(2)} GJN (${isSell ? '到手' : '保本'})</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">时间</span><span class="gme-detail-value">${time}</span></div>
          <div class="gme-detail-row"><span class="gme-detail-label">事件ID</span><span class="gme-detail-value mono" style="font-size:10px;">${event.id || '-'}</span></div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  }

  // ══════════════════════════════════════════════════════
  //  创建面板
  // ══════════════════════════════════════════════════════

  function createPanel() {
    const root = el('div', { id: 'gme-root' });

    // 悬浮按钮
    // 悬浮按钮 — 直接绑定事件（el() 不支持嵌套 on 对象语法）
    const toggle = el('button', {
      id: 'gme-toggle', className: 'gme-toggle', title: 'Gaijin Market Enhancer (Ctrl+Shift+G)'
    });
    toggle.addEventListener('click', togglePanel);
    toggle.innerHTML = toggleIcon(false);
    root.appendChild(toggle);

    // 面板
    const panel = el('div', { id: 'gme-panel', className: 'gme-panel' });
    panel.innerHTML = `
      <div class="gme-panel-header" id="gme-drag-handle">
        <span class="gme-panel-title">📊 Gaijin Market Enhancer</span>
        <div class="gme-header-actions">
          <button class="gme-btn gme-btn-sm" id="gme-refresh" title="刷新 (Ctrl+Shift+R)">🔄</button>
          <button class="gme-btn gme-btn-sm" id="gme-close" title="关闭 (Esc)">✕</button>
        </div>
      </div>
      <div class="gme-panel-tabs">
        <button class="gme-tab gme-tab--active" data-tab="history">交易历史</button>
        <button class="gme-tab" data-tab="stats">数据统计</button>
        <button class="gme-tab" data-tab="search">市场行情</button>
        <button class="gme-tab" data-tab="settings">设置</button>
      </div>
      <div class="gme-panel-content">
        <!-- 交易历史 Tab -->
        <div class="gme-tab-content gme-tab-content--active" id="gme-tab-history">
          <div class="gme-controls">
            <select id="gme-page-size" class="gme-select">
              <option value="15">每页 15</option>
              <option value="25">每页 25</option>
              <option value="50">每页 50</option>
            </select>
            <input type="text" id="gme-filter-input" class="gme-input" placeholder="搜索订单号 / 物品名..." />
            <button class="gme-btn gme-btn-primary" id="gme-load-history">📥 加载数据</button>
          </div>
          <div class="gme-stats-bar" id="gme-stats-bar">等待加载...</div>
          <div class="gme-sub-tabs" id="gme-sub-tabs">
            <button class="gme-sub-tab gme-sub-tab--active" data-sub="deals">成交记录 <span class="gme-sub-badge" id="gme-deal-count">0</span></button>
            <button class="gme-sub-tab" data-sub="pending">挂单记录 <span class="gme-sub-badge" id="gme-pending-count">0</span></button>
          </div>
          <div class="gme-sub-panel gme-sub-panel--active" id="gme-sub-deals">
            <div class="gme-table-wrap"><table class="gme-table" id="gme-deal-table">
              <thead><tr>
                <th data-sort="type">类型</th>
                <th data-sort="item" style="min-width:160px;">物品</th>
                <th data-sort="price">单价</th>
                <th data-sort="count">数量</th>
                <th data-sort="total">总价</th>
                <th data-sort="expected">预期金额</th>
                <th data-sort="orderId">订单ID</th>
                <th data-sort="ts">时间</th>
                <th>操作</th>
              </tr></thead>
              <tbody id="gme-deal-body"></tbody>
            </table></div>
            <div class="gme-pagination" id="gme-deal-pagination"></div>
          </div>
          <div class="gme-sub-panel" id="gme-sub-pending">
            <div class="gme-table-wrap"><table class="gme-table" id="gme-pending-table">
              <thead><tr>
                <th>状态 / 类型</th>
                <th style="min-width:160px;">物品</th>
                <th>挂单单价</th>
                <th>数量</th>
                <th>预期到手</th>
                <th>订单ID</th>
                <th>挂单时间</th>
              </tr></thead>
              <tbody id="gme-pending-body"></tbody>
            </table></div>
          </div>
        </div>

        <!-- 数据统计 Tab -->
        <div class="gme-tab-content" id="gme-tab-stats">
          <div class="gme-stats-grid" id="gme-stats-cards"></div>
          <div class="gme-sub-tabs">
            <button class="gme-sub-tab gme-sub-tab--active" data-sub="sell-records">出售记录</button>
            <button class="gme-sub-tab" data-sub="buy-records">购买记录</button>
            <button class="gme-sub-tab" data-sub="profit-loss">物品盈亏</button>
          </div>
          <div class="gme-sub-panel gme-sub-panel--active" id="gme-sub-sell-records">
            <div class="gme-table-wrap" style="max-height:320px;overflow-y:auto;">
              <table class="gme-table" id="gme-sell-table">
                <thead><tr>
                  <th>物品</th><th>单价</th><th>数量</th><th>成交总额</th><th>预期到手</th><th>时间</th>
                </tr></thead>
                <tbody id="gme-sell-body"></tbody>
              </table>
            </div>
          </div>
          <div class="gme-sub-panel" id="gme-sub-buy-records">
            <div class="gme-table-wrap" style="max-height:320px;overflow-y:auto;">
              <table class="gme-table" id="gme-buy-table">
                <thead><tr>
                  <th>物品</th><th>单价</th><th>数量</th><th>成交总额</th><th>保本价格</th><th>时间</th>
                </tr></thead>
                <tbody id="gme-buy-body"></tbody>
              </table>
            </div>
          </div>
          <div class="gme-sub-panel" id="gme-sub-profit-loss">
            <div class="gme-table-wrap" style="max-height:400px;overflow-y:auto;">
              <table class="gme-table" id="gme-profit-table">
                <thead><tr>
                  <th>物品</th><th>买入</th><th>买入总额</th><th>卖出</th><th>卖出总额</th><th>已售到手</th><th>总盈亏</th><th>当前库存</th><th>保本售价</th><th>扭亏为盈目标价</th>
                </tr></thead>
                <tbody id="gme-profit-body"></tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 市场行情 Tab -->
        <div class="gme-tab-content" id="gme-tab-search">
          <div class="gme-controls">
            <input type="text" id="gme-search-input" class="gme-input" placeholder="搜索市场物品..." />
            <button class="gme-btn gme-btn-primary" id="gme-search-btn">🔍 搜索</button>
          </div>
          <div class="gme-search-results" id="gme-search-results"></div>
          <div class="gme-detail" id="gme-item-detail" style="display:none"></div>
        </div>

        <!-- 设置 Tab -->
        <div class="gme-tab-content" id="gme-tab-settings">
          <div class="gme-settings-group">
            <h4>🔑 Token 状态</h4>
            <p id="gme-token-status">检测中...</p>
            <p id="gme-token-source" style="font-size:11px;color:var(--gme-text-2);margin-top:2px;"></p>
          </div>
          <div class="gme-settings-group">
            <h4>✏️ 手动输入 Token</h4>
            <p style="font-size:11px;color:var(--gme-text-2);margin-bottom:6px;">
              从 F12 → Application → Local Storage → <code>MarketApp,auth,tokenPair</code> 复制值粘贴
            </p>
            <textarea id="gme-token-input" class="gme-textarea" rows="2" placeholder="在此粘贴 Token..."></textarea>
            <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
              <button class="gme-btn gme-btn-primary" id="gme-save-token">💾 保存</button>
              <button class="gme-btn" id="gme-retry-auto">🔄 重试自动</button>
              <button class="gme-btn" id="gme-clear-token" style="border-color:var(--gme-red);color:var(--gme-red);">✕ 清除</button>
            </div>
            <p id="gme-token-feedback" style="font-size:11px;margin-top:4px;"></p>
          </div>
          <div class="gme-settings-group">
            <h4>📦 缓存</h4>
            <p id="gme-cache-info">查询中...</p>
            <button class="gme-btn" id="gme-clear-cache">清除缓存</button>
          </div>
          <div class="gme-settings-group">
            <h4>⌨ 快捷键</h4>
            <ul class="gme-shortcuts">
              <li><kbd>Ctrl+Shift+R</kbd> 刷新数据</li>
              <li><kbd>Ctrl+Shift+G</kbd> 开关面板</li>
              <li><kbd>Esc</kbd> 关闭面板</li>
            </ul>
          </div>
          <div class="gme-settings-group">
            <h4>ℹ️ 版本</h4>
            <p>v2.0.0</p>
          </div>
        </div>
      </div>
    `;

    root.appendChild(panel);
    document.body.appendChild(root);
    bindEvents(panel);
    makeDraggable(panel);
  }

  // ── 面板开关 ──────────────────────────────────────────

  function togglePanel() {
    const panel = document.querySelector('#gme-panel');
    const btn = document.querySelector('#gme-toggle');
    if (!panel || !btn) return;
    const isOpen = panel.classList.toggle('gme-panel--visible');
    btn.innerHTML = toggleIcon(isOpen);
    btn.classList.toggle('gme-toggle--open', isOpen);
    btn.title = isOpen ? '关闭面板 (Ctrl+Shift+G)' : '打开 Gaijin Market Enhancer (Ctrl+Shift+G)';
    if (isOpen) {
      updateSettings();
    }
  }

  function toggleIcon(isOpen) {
    return isOpen ? '✕' : '📊';
  }

  // ══════════════════════════════════════════════════════
  //  可拖动
  // ══════════════════════════════════════════════════════

  function makeDraggable(panel) {
    const handle = qs('#gme-drag-handle', panel);
    let ox, oy, mx, my, dragging = false;

    function onDown(e) {
      if (e.target.closest('.gme-header-actions')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      mx = e.clientX; my = e.clientY;
      panel.classList.add('dragging');
      // 清除 transform 居中定位，改用 left/top
      panel.style.left = ox + 'px';
      panel.style.top = oy + 'px';
      panel.style.transform = 'none';
    }

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - mx, dy = e.clientY - my;
      panel.style.left = (ox + dx) + 'px';
      panel.style.top = (oy + dy) + 'px';
    }

    function onUp() {
      dragging = false;
      panel.classList.remove('dragging');
    }

    handle.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);

    // 双击标题重置到居中
    handle.addEventListener('dblclick', () => {
      panel.style.left = '50%';
      panel.style.top = '50%';
      panel.style.transform = 'translate(-50%, -50%)';
    });
  }

  // ══════════════════════════════════════════════════════
  //  事件绑定
  // ══════════════════════════════════════════════════════

  function bindEvents(panel) {
    // 主 Tab 切换
    qsa('.gme-tab', panel).forEach(tab => {
      tab.addEventListener('click', () => {
        qsa('.gme-tab', panel).forEach(t => t.classList.remove('gme-tab--active'));
        qsa('.gme-tab-content').forEach(c => c.classList.remove('gme-tab-content--active'));
        tab.classList.add('gme-tab--active');
        const ct = qs(`#gme-tab-${tab.dataset.tab}`);
        if (ct) {
          ct.classList.add('gme-tab-content--active');
          if (tab.dataset.tab === 'settings') updateSettings();
          if (tab.dataset.tab === 'stats' && STATE.stats) renderStats();
          if (tab.dataset.tab === 'history' && STATE.history.length) { renderHistory(); updateStatsBar(); }
        }
      });
    });

    // 子 Tab 切换
    panel.addEventListener('click', (e) => {
      const subTab = e.target.closest('.gme-sub-tab');
      if (subTab) {
        qsa('.gme-sub-tab', panel).forEach(t => t.classList.remove('gme-sub-tab--active'));
        qsa('.gme-sub-panel', panel).forEach(p => p.classList.remove('gme-sub-panel--active'));
        subTab.classList.add('gme-sub-tab--active');
        const sp = qs(`#gme-sub-${subTab.dataset.sub}`);
        if (sp) sp.classList.add('gme-sub-panel--active');
      }
    });

    // 按钮事件
    qs('#gme-close', panel).addEventListener('click', () => panel.classList.remove('gme-panel--visible'));
    qs('#gme-refresh', panel).addEventListener('click', loadHistory);
    qs('#gme-load-history', panel).addEventListener('click', loadHistory);
    qs('#gme-search-btn', panel).addEventListener('click', searchItems);
    // 搜索输入 Enter 触发，处理中文输入法组合输入
    let imeComposing = false;
    const searchInput = qs('#gme-search-input', panel);
    searchInput.addEventListener('compositionstart', () => { imeComposing = true; });
    searchInput.addEventListener('compositionend', () => { imeComposing = false; });
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !imeComposing) searchItems(); });
    qs('#gme-page-size', panel).addEventListener('change', e => { STATE.pageSize = parseInt(e.target.value); STATE.page = 0; renderHistory(); });
    qs('#gme-filter-input', panel).addEventListener('input', () => { STATE.page = 0; renderHistory(); });

    // Token
    qs('#gme-save-token', panel).addEventListener('click', saveTokenHandler);
    qs('#gme-retry-auto', panel).addEventListener('click', retryAutoToken);
    qs('#gme-clear-token', panel).addEventListener('click', clearTokenHandler);

    // 缓存
    qs('#gme-clear-cache', panel).addEventListener('click', async () => {
      const r = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (r?.ok) { STATE.history = []; STATE.deals = []; STATE.pending = []; renderHistory(); renderStats(); updateStatsBar(); updateSettings(); }
    });

    // 表头排序
    panel.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-sort]');
      if (th) {
        const col = th.dataset.sort;
        const table = th.closest('.gme-table');
        if (!table) return;
        if (STATE.sortCol === col) STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
        else { STATE.sortCol = col; STATE.sortDir = 'asc'; }
        renderHistory();
      }
      // 详情按钮事件委托
      const detailBtn = e.target.closest('.gme-detail-btn');
      if (detailBtn) {
        const raw = detailBtn.getAttribute('data-detail');
        if (raw) {
          try {
            const event = JSON.parse(decodeURIComponent(raw));
            showModal(event);
          } catch (err) { console.error('[GME] detail parse error', err); }
        }
      }
    });

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === 'R') { e.preventDefault(); loadHistory(); }
      if (e.ctrlKey && e.shiftKey && e.key === 'G') { e.preventDefault(); togglePanel(); }
      if (e.key === 'Escape') panel.classList.remove('gme-panel--visible');
    });
  }

  // ══════════════════════════════════════════════════════
  //  渲染函数
  // ══════════════════════════════════════════════════════

  function updateStatsBar(msg) {
    const bar = qs('#gme-stats-bar');
    if (!bar) return;
    if (msg) { bar.innerHTML = `<span>${msg}</span>`; return; }
    if (!STATE.stats) { bar.innerHTML = '<span>等待加载...</span>'; return; }
    const s = STATE.stats;
    bar.innerHTML = `
      <span>共 ${s.total} 条事件</span>
      <span class="badge badge-deal">成交 ${s.deals}</span>
      <span class="badge badge-new">挂单 ${s.pending}</span>
      <span>买入 ${s.totalBuy.toFixed(2)} GJN</span>
      <span>卖出 ${s.totalSell.toFixed(2)} GJN</span>
      <span>手续费 ${s.fee.toFixed(2)} GJN</span>
      <span class="${s.profit >= 0 ? 'gme-profit' : 'gme-loss'}">净盈亏 ${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(2)} GJN</span>
    `;
  }

  function renderHistory() {
    // 更新计数
    const dc = qs('#gme-deal-count');
    const pc = qs('#gme-pending-count');
    if (dc) dc.textContent = STATE.deals.length;
    if (pc) pc.textContent = STATE.pending.length;

    renderDealTable();
    renderPendingTable();
    attachImageFallbacks(qs('#gme-sub-deals'));
    attachImageFallbacks(qs('#gme-sub-pending'));
  }

  function renderDealTable() {
    const body = qs('#gme-deal-body');
    const pag = qs('#gme-deal-pagination');
    if (!body) return;

    const filter = (qs('#gme-filter-input')?.value || '').toLowerCase();
    let data = STATE.deals;
    if (filter) {
      data = data.filter(e =>
        (e.orderId || '').toLowerCase().includes(filter) ||
        (e.market_name || e.hashname || '').toLowerCase().includes(filter)
      );
    }

    // 排序
    data = [...data].sort((a, b) => {
      let va, vb;
      switch (STATE.sortCol) {
        case 'type': va = a.type; vb = b.type; break;
        case 'item': va = (a.market_name || ''); vb = (b.market_name || ''); break;
        case 'price': va = a.price; vb = b.price; break;
        case 'count': va = a.count; vb = b.count; break;
        case 'total': va = (a.price||0) * (a.count||1); vb = (b.price||0) * (b.count||1); break;
        case 'expected': va = a.type === 'SELL' ? (a.price||0) * (a.count||1) * (1 - FEE_RATE) : (a.price||0) * (a.count||1); vb = b.type === 'SELL' ? (b.price||0) * (b.count||1) * (1 - FEE_RATE) : (b.price||0) * (b.count||1); break;
        case 'orderId': va = a.orderId || ''; vb = b.orderId || ''; break;
        default: va = a.ts || 0; vb = b.ts || 0;
      }
      if (typeof va === 'string') return STATE.sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      return STATE.sortDir === 'asc' ? (va - vb) : (vb - va);
    });

    const ps = STATE.pageSize;
    const tp = Math.max(1, Math.ceil(data.length / ps));
    STATE.page = Math.min(STATE.page, tp - 1);
    const start = STATE.page * ps;
    const page = data.slice(start, start + ps);

    if (!page.length) {
      body.innerHTML = '<tr><td colspan="9" class="gme-empty">' + (filter ? '无匹配数据' : '暂无数据，点击加载') + '</td></tr>';
    } else {
      body.innerHTML = page.map(e => {
        const price = (e.price || 0) / 10000;
        const qty = e.count || 1;
        const total = price * qty;
        const isSell = e.type === 'SELL';
        const expected = isSell ? total * (1 - FEE_RATE) : total / (1 - FEE_RATE);
        const time = e.ts ? new Date(e.ts * 1000).toLocaleString('zh-CN') : '-';
        const sellClass = isSell ? 'badge-sell' : 'badge-buy';
        const sellLabel = isSell ? '出售' : '购买';
        // 序列化事件数据到 data-detail 属性
        const detailData = encodeURIComponent(JSON.stringify(e));
        return `<tr>
          <td><span class="badge ${sellClass}">${sellLabel}</span></td>
          <td>${renderItemCell(e)}</td>
          <td class="${isSell ? 'price-sell' : 'price-buy'}">${price.toFixed(2)}</td>
          <td><span class="mono">${qty}</span></td>
          <td>${total.toFixed(2)}</td>
          <td><span style="font-size:10px;color:var(--gme-text-2)">${isSell ? '到手' : '保本'}</span> ${expected.toFixed(2)}</td>
          <td><span class="mono" style="font-size:10px;">${(e.orderId || '').substring(0, 12)}</span></td>
          <td style="color:var(--gme-text-2);font-size:11px;">${time}</td>
          <td><button class="gme-btn gme-btn-sm gme-detail-btn" data-detail="${detailData}" style="padding:2px 8px;">详情</button></td>
        </tr>`;
      }).join('');
    }

    // 分页
    pag.innerHTML = '';
    if (tp <= 1) return;
    const prevBtn = el('button', { className: 'gme-btn gme-btn-sm', disabled: STATE.page <= 0 }, ['‹ 上一页']);
    prevBtn.addEventListener('click', () => { STATE.page--; renderHistory(); });
    pag.appendChild(prevBtn);
    pag.appendChild(el('span', { className: 'gme-page-info' }, [`第 ${STATE.page + 1} 页 / 共 ${tp} 页`]));
    const nextBtn = el('button', { className: 'gme-btn gme-btn-sm', disabled: STATE.page >= tp - 1 }, ['下一页 ›']);
    nextBtn.addEventListener('click', () => { STATE.page++; renderHistory(); });
    pag.appendChild(nextBtn);
  }

  function renderPendingTable() {
    const body = qs('#gme-pending-body');
    if (!body) return;

    if (!STATE.pending.length) {
      body.innerHTML = '<tr><td colspan="7" class="gme-empty">暂无活跃挂单</td></tr>';
      return;
    }

    body.innerHTML = STATE.pending.map(e => {
      const price = (e.price || 0) / 10000;
      const qty = e.count || 1;
      const isSell = e.type === 'SELL';
      const expected = isSell ? price * (1 - FEE_RATE) : price;
      const expectedLabel = isSell ? '到手' : '全额';
      const time = e.ts ? new Date(e.ts * 1000).toLocaleString('zh-CN') : '-';
      return `<tr>
        <td><span class="badge badge-new">挂单</span> <span class="badge ${isSell ? 'badge-sell' : 'badge-buy'}">${isSell ? '出售' : '购买'}</span></td>
        <td>${renderItemCell(e)}</td>
        <td class="${isSell ? 'price-sell' : 'price-buy'}">${price.toFixed(2)} <span style="color:var(--gme-text-2);font-size:10px;">GJN</span></td>
        <td><span class="mono">${qty}</span></td>
        <td><span style="font-size:10px;color:var(--gme-text-2)">${expectedLabel}</span> ${expected.toFixed(2)} <span style="color:var(--gme-text-2);font-size:10px;">GJN</span></td>
        <td><span class="mono" style="font-size:10px;">${(e.orderId || '').substring(0, 12)}</span></td>
        <td style="color:var(--gme-text-2);font-size:11px;">${time}</td>
      </tr>`;
    }).join('');
  }

  function renderStats() {
    const cards = qs('#gme-stats-cards');
    const sellBody = qs('#gme-sell-body');
    const buyBody = qs('#gme-buy-body');
    const profitBody = qs('#gme-profit-body');
    if (!cards || !sellBody || !buyBody || !profitBody) return;

    if (!STATE.stats) {
      cards.innerHTML = '<p class="gme-empty">请先加载交易数据</p>';
      sellBody.innerHTML = ''; buyBody.innerHTML = ''; profitBody.innerHTML = '';
      return;
    }

    const s = STATE.stats;
    const cls = s.profit >= 0 ? 'gme-profit' : 'gme-loss';
    cards.innerHTML = `
      <div class="gme-card"><div class="gme-card-label">总成交笔数</div><div class="gme-card-value">${s.deals}</div></div>
      <div class="gme-card"><div class="gme-card-label">买入笔数</div><div class="gme-card-value">${s.buyCnt}</div></div>
      <div class="gme-card"><div class="gme-card-label">卖出笔数</div><div class="gme-card-value">${s.sellCnt}</div></div>
      <div class="gme-card"><div class="gme-card-label">买入总额</div><div class="gme-card-value">${s.totalBuy.toFixed(2)}</div></div>
      <div class="gme-card"><div class="gme-card-label">卖出总额</div><div class="gme-card-value">${s.totalSell.toFixed(2)}</div></div>
      <div class="gme-card"><div class="gme-card-label">手续费</div><div class="gme-card-value">${s.fee.toFixed(2)}</div></div>
      <div class="gme-card"><div class="gme-card-label">实际到手</div><div class="gme-card-value">${s.net.toFixed(2)}</div></div>
      <div class="gme-card ${cls}"><div class="gme-card-label">净利润</div><div class="gme-card-value">${s.profit >= 0 ? '+' : ''}${s.profit.toFixed(2)}</div></div>
      <div class="gme-card"><div class="gme-card-label">利润率</div><div class="gme-card-value ${cls}">${s.margin.toFixed(1)}%</div></div>
    `;

    // 出售记录
    const sells = STATE.deals.filter(e => e.type === 'SELL').sort((a, b) => (b.ts || 0) - (a.ts || 0));
    sellBody.innerHTML = sells.length
      ? sells.map(e => {
          const price = (e.price || 0) / 10000;
          const qty = e.count || 1;
          const total = price * qty;
          const net = total * (1 - FEE_RATE);
          const time = e.ts ? new Date(e.ts * 1000).toLocaleString('zh-CN') : '-';
          return `<tr>
            <td>${renderItemCell(e)}</td>
            <td class="price-sell">${price.toFixed(2)}</td>
            <td><span class="mono">${qty}</span></td>
            <td>${total.toFixed(2)}</td>
            <td class="gme-profit">${net.toFixed(2)}</td>
            <td style="color:var(--gme-text-2);font-size:11px;">${time}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6" class="gme-empty">暂无出售记录</td></tr>';

    // 购买记录（含保本价格）
    const buys = STATE.deals.filter(e => e.type === 'BUY').sort((a, b) => (b.ts || 0) - (a.ts || 0));
    buyBody.innerHTML = buys.length
      ? buys.map(e => {
          const price = (e.price || 0) / 10000;
          const qty = e.count || 1;
          const total = price * qty;
          const breakEven = total / qty / (1 - FEE_RATE); // 保本单价 = 买入价 / 0.85
          const time = e.ts ? new Date(e.ts * 1000).toLocaleString('zh-CN') : '-';
          return `<tr>
            <td>${renderItemCell(e)}</td>
            <td class="price-buy">${price.toFixed(2)}</td>
            <td><span class="mono">${qty}</span></td>
            <td>${total.toFixed(2)}</td>
            <td class="gme-amber">${breakEven.toFixed(2)}</td>
            <td style="color:var(--gme-text-2);font-size:11px;">${time}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="6" class="gme-empty">暂无购买记录</td></tr>';

    // 物品盈亏（按物品维度聚合）
    profitBody.innerHTML = s.items.map(item => {
      const profit = item.sellNet - item.buyTotal;
      const inventory = item.buyQty - item.sellQty;
      const avgBuyPrice = item.buyQty > 0 ? item.buyTotal / item.buyQty : 0;
      const breakEvenSell = avgBuyPrice > 0 ? avgBuyPrice / (1 - FEE_RATE) : 0;
      // 扭亏为盈目标价：需要从剩余库存中赚回亏损额
      // 公式 = |亏损| / (库存 × (1-手续费率))
      const breakEvenTarget = (profit < 0 && inventory > 0)
        ? Math.abs(profit) / (inventory * (1 - FEE_RATE))
        : null;
      const pClass = profit >= 0 ? 'gme-profit' : 'gme-loss';
      return `<tr>
        <td>${item.name}</td>
        <td>${item.buyQty > 0 ? item.buyQty : '-'}</td>
        <td>${item.buyTotal > 0 ? item.buyTotal.toFixed(2) : '-'}</td>
        <td>${item.sellQty > 0 ? item.sellQty : '-'}</td>
        <td>${item.sellTotal > 0 ? item.sellTotal.toFixed(2) : '-'}</td>
        <td>${item.sellNet > 0 ? item.sellNet.toFixed(2) : '-'}</td>
        <td class="${pClass}">${profit >= 0 ? '+' : ''}${profit.toFixed(2)}</td>
        <td>${inventory > 0 ? inventory : '-'}</td>
        <td class="mono">${breakEvenSell > 0 ? breakEvenSell.toFixed(2) : '-'}</td>
        <td class="mono">${breakEvenTarget !== null ? breakEvenTarget.toFixed(2) : (profit >= 0 ? '已盈利' : '无库存')}</td>
      </tr>`;
    }).join('');
  }

  // ══════════════════════════════════════════════════════
  //  市场搜索 & 详情
  // ══════════════════════════════════════════════════════

  async function searchItems() {
    const input = qs('#gme-search-input');
    const results = qs('#gme-search-results');
    const detail = qs('#gme-item-detail');
    if (!input || !results) return;
    const text = input.value.trim();
    if (!text) return;

    results.innerHTML = '<div class="gme-loading">搜索中...</div>';
    if (detail) detail.style.display = 'none';

    try {
      const data = await authFetch('/web', 'cln_market_search', {
        text, skip: '0', count: '30', options: 'any_sell_orders;include_marketpairs', appid_filter: '1067'
      });
      // 尝试多种响应路径：API 返回 response.assets（不是 items）
      let items = data?.response?.assets || data?.assets || [];
      // 如果是对象字典而非数组，转成数组
      if (items && typeof items === 'object' && !Array.isArray(items)) {
        items = Object.values(items);
      }
      if (!items.length) { results.innerHTML = '<div class="gme-empty">无搜索结果</div>'; return; }

      // 异步加载物品名称和图标
      const hashnames = items.map(i => i.hash_name || i.market_name).filter(Boolean);
      await Promise.allSettled(hashnames.map(h => resolveAssetInfo(h)));

      results.innerHTML = '<div class="gme-search-grid"></div>';
      const grid = qs('.gme-search-grid', results);
      items.forEach(item => {
        const marketName = item.hash_name || item.market_name;
        const cached = STATE.assetCache.get(marketName) || STATE.assetCache.get(extractItemdefid(marketName));
        const displayName = cached?.name || item.name || marketName || '-';
        const tags = cached?.tags || [];
        const tagsHtml = tags.filter(t => t.category === 'quality' || t.category === 'country')
          .map(t => `<span class="tag" style="background:${t.color?.startsWith('#') ? t.color : '#' + (t.color || '888')}">${t.name}</span>`)
          .join('');
        const iconUrl = cached?.icon_url;
        const iconHtml = iconUrl
          ? `<img class="item-icon" src="${iconUrl}" alt="${displayName}" data-fl="${displayName.charAt(0)}" data-fn="${displayName}" loading="lazy" style="width:32px;height:32px;" />`
          : `<div class="item-icon-placeholder" style="width:32px;height:32px;font-size:12px;">${displayName.charAt(0)}</div>`;

        const card = el('div', { className: 'gme-search-card' });
        card.addEventListener('click', () => showItemDetail(marketName));
        card.innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
          ${iconHtml}
          <div>
            <div class="gme-search-card-name">${displayName}</div>
            ${tagsHtml ? `<div style="margin-top:2px;">${tagsHtml}</div>` : ''}
            <div class="gme-search-card-price">最低价: ${item.price ? (item.price / 100000000).toFixed(2) : '-'} GJN</div>
          </div>
        </div>`;
        grid.appendChild(card);
      });
      attachImageFallbacks(grid);
    } catch (err) {
      results.innerHTML = err.message === 'TokenNotFound'
        ? '<div class="gme-error">❌ 未找到 Token</div>'
        : `<div class="gme-error">❌ ${err.message}</div>`;
    }
  }

  function drawMiniChart(containerId, points) {
    const container = document.getElementById(containerId);
    if (!container || !points.length) return;

    // 清除旧内容
    container.innerHTML = '';

    const canvas = document.createElement('canvas');
    canvas.width = container.offsetWidth || 260;
    canvas.height = 100;
    canvas.style.width = '100%';
    canvas.style.height = '100px';
    canvas.style.display = 'block';
    container.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const pad = { top: 8, right: 8, bottom: 16, left: 8 };
    const pw = W - pad.left - pad.right;
    const ph = H - pad.top - pad.bottom;

    // 计算范围
    let yMin = Infinity, yMax = -Infinity;
    points.forEach(p => {
      if (p.price < yMin) yMin = p.price;
      if (p.price > yMax) yMax = p.price;
    });
    if (yMin === yMax) { yMin -= 0.01; yMax += 0.01; }
    const yRange = yMax - yMin;

    // 绘制网格
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + ph * i / 4;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(pad.left + pw, y); ctx.stroke();
    }

    // 绘制 Y 轴标签
    ctx.fillStyle = getComputedStyle(container).getPropertyValue('--gme-text-2') || '#888';
    ctx.font = '9px monospace';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const val = yMax - yRange * i / 4;
      ctx.fillText(val.toFixed(2), pad.left - 2, pad.top + ph * i / 4 + 3);
    }

    // 绘制折线
    ctx.beginPath();
    ctx.strokeStyle = '#60a5fa';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    points.forEach((p, i) => {
      const x = pad.left + pw * i / (points.length - 1);
      const y = pad.top + ph * (1 - (p.price - yMin) / yRange);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // 填充渐变
    const lastX = pad.left + pw * (points.length - 1) / (points.length - 1);
    const firstX = pad.left;
    const firstY = pad.top + ph * (1 - (points[0].price - yMin) / yRange);
    ctx.lineTo(lastX, pad.top + ph);
    ctx.lineTo(firstX, pad.top + ph);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ph);
    grad.addColorStop(0, 'rgba(96,165,250,0.25)');
    grad.addColorStop(1, 'rgba(96,165,250,0.02)');
    ctx.fillStyle = grad;
    ctx.fill();

    // 最后一点标记
    const lastPt = points[points.length - 1];
    const lx = pad.left + pw;
    const ly = pad.top + ph * (1 - (lastPt.price - yMin) / yRange);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#60a5fa';
    ctx.fill();
  }

  async function showItemDetail(marketName) {
    const detail = qs('#gme-item-detail');
    if (!detail || !marketName) return;
    detail.style.display = 'block';
    detail.innerHTML = '<div class="gme-loading">加载详情...</div>';

    try {
      // 并行：获取物品名称、行情统计、订单簿
      const assetInfo = await resolveAssetInfo(marketName);
      const displayName = assetInfo?.name || marketName;
      const [statData, bookData] = await Promise.all([
        authFetch('/web', 'cln_get_pair_stat', { market_name: marketName, currencyid: 'gjn' }),
        authFetch('/web', 'cln_books_brief', { market_name: marketName, currencyid: 'gjn' })
      ]);
      const stat = statData?.response || statData;
      const book = bookData?.response || bookData;

      // 盘口数据：API 返回 { BUY: [[price_raw, count], ...], SELL: [[price_raw, count], ...] }
      const buyArr = Array.isArray(book?.BUY) ? book.BUY : [];
      const sellArr = Array.isArray(book?.SELL) ? book.SELL : [];
      const bidsRaw = buyArr.slice(0, 8).map(([p, c]) => ({ price: (p || 0) / 10000, count: c || 0 }));
      const asksRaw = sellArr.slice(0, 8).map(([p, c]) => ({ price: (p || 0) / 10000, count: c || 0 }));

      // 解析时间序列数据：API 返回 { "1d": [[ts, price_raw, vol], ...], "1h": [...], ... }
      // price_raw 需 /10000 转换为 GJN
      function parseSeries(arr) {
        if (!Array.isArray(arr) || !arr.length) return null;
        const pts = arr.map(pt => ({
          ts: pt[0],
          price: (pt[1] || 0) / 10000,
          vol: pt[2] || 0
        })).filter(p => p.price > 0);
        if (!pts.length) return null;
        let min = Infinity, max = -Infinity, sum = 0;
        pts.forEach(p => {
          if (p.price < min) min = p.price;
          if (p.price > max) max = p.price;
          sum += p.price;
        });
        return { pts, min, max, avg: sum / pts.length };
      }

      const d24 = parseSeries(stat['1d']);

      // 半年数据：尝试 180d → 6m → 1y → all → full，不存在则合并所有可用周期
      const halfYearKeys = [stat['180d'], stat['6m'], stat['1y'], stat['all'], stat['full']].find(s => Array.isArray(s) && s.length);
      let dHalf = parseSeries(halfYearKeys);
      if (!dHalf) {
        // 合并 1d + 1m + 3m 作为近似半年范围
        const merged = [];
        ['1d', '1m', '3m'].forEach(k => {
          if (Array.isArray(stat[k])) merged.push(...stat[k]);
        });
        dHalf = parseSeries(merged.length ? merged : null);
      }

      const currentMarketPrice = d24 ? d24.pts[d24.pts.length - 1].price : 0;

      // 从用户交易记录中匹配该物品
      const userTrades = STATE.deals.filter(e =>
        (e.hashname && marketName.includes(e.hashname)) ||
        (e.market_name && e.market_name === marketName)
      );
      const userBuys = userTrades.filter(e => e.type === 'BUY');
      const userSells = userTrades.filter(e => e.type === 'SELL');
      const avgBuyPrice = userBuys.length > 0
        ? userBuys.reduce((sum, e) => sum + (e.price || 0) / 10000 * (e.count || 1), 0) / userBuys.reduce((sum, e) => sum + (e.count || 1), 0)
        : 0;
      const avgSellPrice = userSells.length > 0
        ? userSells.reduce((sum, e) => sum + (e.price || 0) / 10000 * (e.count || 1), 0) / userSells.reduce((sum, e) => sum + (e.count || 1), 0)
        : 0;

      // 盈亏估算
      let profitEstimate = null, profitClass = '';
      if (avgBuyPrice > 0 && currentMarketPrice > 0) {
        const profit = (currentMarketPrice * (1 - FEE_RATE) - avgBuyPrice) / avgBuyPrice * 100;
        profitEstimate = profit;
        profitClass = profit >= 0 ? 'gme-profit' : 'gme-loss';
      }

      detail.innerHTML = `
        <div class="gme-detail-header">
          <span><strong>${displayName}</strong></span>
          <button class="gme-btn gme-btn-sm" onclick="this.parentElement.parentElement.style.display='none'">✕</button>
        </div>
        <div class="gme-detail-grid">
          <div class="gme-detail-col">
            <h4>📈 市场行情</h4>
            <p>当前价: <strong>${currentMarketPrice.toFixed(2)}</strong> GJN</p>
            ${d24 ? `<p>24h 最高: ${d24.max.toFixed(2)} GJN | 最低: ${d24.min.toFixed(2)} GJN | 均价: ${d24.avg.toFixed(2)} GJN</p>` : '<p style="color:var(--gme-text-2)">24h: 暂无数据</p>'}
            ${dHalf ? `<p>历史最高: ${dHalf.max.toFixed(2)} GJN | 最低: ${dHalf.min.toFixed(2)} GJN <span style="font-size:10px;color:var(--gme-text-2)">(${dHalf.pts.length}点)</span></p>` : '<p style="color:var(--gme-text-2)">历史区间: 暂无足够数据</p>'}
            <div id="gme-price-chart" style="width:100%;height:100px;margin-top:8px;border-radius:4px;overflow:hidden;"></div>
          </div>
          <div class="gme-detail-col">
            <h4>🧾 我的交易</h4>
            <p>买入 ${userBuys.length} 笔 | 均价: <span class="price-buy">${avgBuyPrice.toFixed(2)}</span> GJN</p>
            <p>卖出 ${userSells.length} 笔 | 均价: <span class="price-sell">${avgSellPrice.toFixed(2)}</span> GJN</p>
            <p>库存: ${userBuys.reduce((s, e) => s + (e.count || 1), 0) - userSells.reduce((s, e) => s + (e.count || 1), 0)} 件</p>
            ${profitEstimate !== null ? `<p>当前价盈亏: <span class="${profitClass}">${profitEstimate >= 0 ? '+' : ''}${profitEstimate.toFixed(1)}%</span></p>` : ''}
            ${avgBuyPrice > 0 ? `<p>保本售价: <span class="gme-amber">${(avgBuyPrice / (1 - FEE_RATE)).toFixed(2)}</span> GJN</p>` : ''}
          </div>
          <div class="gme-detail-col">
            <h4>💰 买盘 (Bids)</h4>
            ${bidsRaw.map(b => `<p>${b.price.toFixed(2)} GJN × ${b.count}</p>`).join('') || '<p class="gme-empty">无数据</p>'}
            <hr class="gme-divider">
            <h4>📊 卖盘 (Asks)</h4>
            ${asksRaw.map(s => `<p>${s.price.toFixed(2)} GJN × ${s.count}</p>`).join('') || '<p class="gme-empty">无数据</p>'}
          </div>
        </div>`;

      // 绘制 mini 价格走势图
      if (d24 && d24.pts.length > 0) {
        setTimeout(() => drawMiniChart('gme-price-chart', d24.pts), 50);
      }
    } catch (err) {
      detail.innerHTML = err.message === 'TokenNotFound'
        ? '<div class="gme-error">❌ 未找到 Token</div>'
        : `<div class="gme-error">❌ ${err.message}</div>`;
    }
  }

  // ══════════════════════════════════════════════════════
  //  Token 处理函数
  // ══════════════════════════════════════════════════════

  async function saveTokenHandler() {
    const input = qs('#gme-token-input');
    const fb = qs('#gme-token-feedback');
    const raw = input.value.trim();
    if (!raw) { fb.textContent = '⚠️ 请输入 Token'; fb.style.color = 'var(--gme-red)'; return; }
    let token = raw;
    try { const p = JSON.parse(raw); token = p.token || p.access_token || raw; } catch { /* plain */ }
    await saveManualToken(token);
    fb.textContent = '✅ Token 已保存！'; fb.style.color = 'var(--gme-green)';
    updateSettings();
  }

  async function retryAutoToken() {
    const fb = qs('#gme-token-feedback');
    const token = await getAutoToken();
    if (token) { fb.textContent = '✅ 已自动获取到 Token！'; fb.style.color = 'var(--gme-green)'; }
    else { fb.textContent = '❌ 自动获取失败，请手动输入'; fb.style.color = 'var(--gme-red)'; }
    updateSettings();
  }

  async function clearTokenHandler() {
    await clearManualToken();
    qs('#gme-token-input').value = '';
    const fb = qs('#gme-token-feedback');
    fb.textContent = '已清除手动 Token'; fb.style.color = 'var(--gme-text-2)';
    updateSettings();
  }

  async function updateSettings() {
    const ts = qs('#gme-token-status');
    const src = qs('#gme-token-source');
    const ci = qs('#gme-cache-info');
    const ti = qs('#gme-token-input');

    const auto = await getAutoToken();
    const manual = await getManualToken();

    if (auto) {
      ts.textContent = `✅ Token 已自动获取: ${auto.substring(0, 20)}...`;
      ts.className = 'gme-status-ok';
      src.textContent = '来源: 页面 localStorage';
      if (ti) ti.value = auto;
    } else if (manual) {
      ts.textContent = `✅ 手动 Token: ${manual.substring(0, 20)}...`;
      ts.className = 'gme-status-ok';
      src.textContent = '来源: 手动输入';
      if (ti) ti.value = manual;
    } else {
      ts.textContent = '❌ 未找到 Token';
      ts.className = 'gme-status-error';
      src.textContent = '请手动输入或登录后重试';
    }

    if (ci) {
      try {
        const r = await chrome.runtime.sendMessage({ type: 'GET_META' });
        if (r?.meta) {
          const sync = r.meta.find(m => m.key === 'lastSync');
          ci.textContent = sync ? `最后同步: ${new Date(sync.time).toLocaleString('zh-CN')} | ${sync.total} 条` : '暂无缓存';
        }
      } catch { ci.textContent = '查询失败'; }
    }
  }

  // ══════════════════════════════════════════════════════
  //  消息监听
  // ══════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      switch (msg.type) {
        case 'PING': sendResponse({ ok: !!(await getToken()), source: STATE.tokenSource }); break;
        case 'RETRY_AUTO_TOKEN': { const t = await getAutoToken(); sendResponse({ ok: !!t }); if (t) updateSettings(); break; }
        case 'TOKEN_SAVED': updateSettings(); sendResponse({ ok: true }); break;
        default: sendResponse({ error: 'unknown' });
      }
    })();
    return true;
  });

  // ══════════════════════════════════════════════════════
  //  启动
  // ══════════════════════════════════════════════════════

  function init() {
    const boot = () => {
      createPanel();
      updateSettings();
      // 后台自动加载数据，不影响原界面
      loadHistory();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  init();
})();

/**
 * Popup 逻辑
 * 显示扩展状态、手动 Token 管理、快速操作
 */

const MANUAL_TOKEN_KEY = 'gme_manual_token';

document.addEventListener('DOMContentLoaded', async () => {
  const tokenStatus = document.querySelector('#token-status');
  const pageStatus = document.querySelector('#page-status');
  const cacheInfo = document.querySelector('#cache-info');
  const fb = document.querySelector('#popup-token-feedback');
  const input = document.querySelector('#popup-token-input');

  // ── 检查 Token 状态 ──────────────────────────────

  async function checkTokenStatus() {
    // 尝试从 content script 获取
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('trade.gaijin.net')) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
        if (resp?.ok) {
          tokenStatus.innerHTML = `
            <span class="status-dot status-dot--ok"></span>
            <span>扩展已注入，Token 有效</span>
          `;
          return;
        }
      } catch { /* fall through */ }
    }

    // 检查本地存储的手动 Token
    chrome.storage.local.get(MANUAL_TOKEN_KEY, (result) => {
      const manual = result[MANUAL_TOKEN_KEY];
      if (manual) {
        const preview = manual.substring(0, 24) + '...';
        tokenStatus.innerHTML = `
          <span class="status-dot status-dot--ok"></span>
          <span>手动 Token 已保存: ${preview}</span>
        `;
        if (input) input.value = manual;
        if (fb) { fb.textContent = '✅ 手动 Token 已加载'; fb.style.color = 'var(--green)'; }
      } else {
        tokenStatus.innerHTML = `
          <span class="status-dot status-dot--pending"></span>
          <span>等待配置 Token...</span>
        `;
      }
    });
  }

  // ── 初始化状态 ─────────────────────────────────────

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isGaijin = tab?.url?.includes('trade.gaijin.net');

    if (isGaijin) {
      pageStatus.textContent = '✅ 已连接';
      pageStatus.style.color = 'var(--green)';
      checkTokenStatus();

      // 检查缓存状态
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'GET_META' });
        if (resp?.meta) {
          const sync = resp.meta.find(m => m.key === 'lastSync');
          const installed = resp.meta.find(m => m.key === 'installed');
          if (sync) {
            cacheInfo.innerHTML = `
              <span class="popup-info-label">最后同步:</span>
              <span>${new Date(sync.time).toLocaleString('zh-CN')}</span>
            `;
          } else if (installed) {
            cacheInfo.innerHTML = `
              <span class="popup-info-label">状态:</span>
              <span>已安装，暂无数据</span>
            `;
          }
        }
      } catch {
        cacheInfo.innerHTML = `<span class="popup-info-label">缓存:</span><span>查询失败</span>`;
      }
    } else {
      pageStatus.textContent = '❌ 未在交易页面';
      pageStatus.style.color = 'var(--red)';
      tokenStatus.innerHTML = `
        <span class="status-dot status-dot--error"></span>
        <span>请在 trade.gaijin.net 页面使用</span>
      `;
      // 仍检查是否有手动 Token
      checkTokenStatus();
    }
  } catch (err) {
    console.error('[GME Popup]', err);
    tokenStatus.innerHTML = `
      <span class="status-dot status-dot--error"></span>
      <span>初始化失败</span>
    `;
  }

  // ── 保存手动 Token ─────────────────────────────────

  document.querySelector('#btn-save-token')?.addEventListener('click', () => {
    const raw = input.value.trim();
    if (!raw) {
      if (fb) { fb.textContent = '⚠️ 请输入 Token'; fb.style.color = 'var(--red)'; }
      return;
    }

    // 尝试解析 JSON（用户可能复制了整个 localStorage 值）
    let token = raw;
    try {
      const parsed = JSON.parse(raw);
      token = parsed.token || parsed.access_token || raw;
    } catch { /* 纯文本 */ }

    chrome.storage.local.set({ [MANUAL_TOKEN_KEY]: token }, async () => {
      if (fb) { fb.textContent = '✅ Token 已保存！立即生效'; fb.style.color = 'var(--green)'; }
      checkTokenStatus();
      // 通知 content script 立即更新
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url?.includes('trade.gaijin.net')) {
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'TOKEN_SAVED' });
        } catch { /* content script 可能未就绪 */ }
      }
    });
  });

  // ── 重新自动获取 ───────────────────────────────────

  document.querySelector('#btn-retry-token')?.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('trade.gaijin.net')) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'RETRY_AUTO_TOKEN' });
        if (resp?.ok) {
          if (fb) { fb.textContent = '✅ 已通知页面重新获取'; fb.style.color = 'var(--green)'; }
        } else {
          if (fb) { fb.textContent = '⚠️ 页面未响应'; fb.style.color = 'var(--red)'; }
        }
      } catch {
        if (fb) { fb.textContent = '⚠️ 页面未就绪，请刷新'; fb.style.color = 'var(--red)'; }
      }
    } else {
      if (fb) { fb.textContent = '⚠️ 请先在 trade.gaijin.net 页面操作'; fb.style.color = 'var(--red)'; }
    }
  });

  // ── 按钮事件 ───────────────────────────────────────

  document.querySelector('#btn-open-page')?.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://trade.gaijin.net/market/sell' });
  });

  document.querySelector('#btn-clear-cache')?.addEventListener('click', async () => {
    const btn = document.querySelector('#btn-clear-cache');
    btn.disabled = true;
    btn.textContent = '正在清除...';
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'CLEAR_CACHE' });
      if (resp?.ok) {
        cacheInfo.innerHTML = `<span class="popup-info-label">缓存:</span><span>已清除 ✅</span>`;
      }
    } catch {
      cacheInfo.innerHTML = `<span class="popup-info-label">缓存:</span><span>清除失败</span>`;
    }
    btn.disabled = false;
    btn.textContent = '清除缓存';
  });
});

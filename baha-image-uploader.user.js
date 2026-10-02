// ==UserScript==
// @name         巴哈圖片快速上傳
// @namespace    http://tampermonkey.net/
// @version      1.0.3
// @author       udeyubi
// @description  在巴哈哈啦區任何地方貼上或拖曳圖片，自動上傳到巴哈圖床並插入編輯框；支援多張、網路圖片與上傳紀錄。
// @match        https://forum.gamer.com.tw/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @connect      fbcdn.net
// @connect      cdninstagram.com
// @connect      twimg.com
// @connect      i.imgur.com
// @connect      pximg.net
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
  const MAX_WIDTH = 1920; // 與巴哈內建上傳相同：寬度超過 1920 先在瀏覽器縮圖
  const UPLOAD_INTERVAL = 1500; // 多張上傳時，每張之間的間隔
  const RETRY_DELAY = 3000; // 上傳失敗時，等這麼久再重試一次
  const REQUEST_TIMEOUT = 30000;
  const HISTORY_KEY = 'upload_history_v1';
  const HISTORY_LIMIT = 1000;
  const HISTORY_PAGE_SIZE = 60;
  const COPIED_RESET_DELAY = 2000; // 「已複製」顯示多久後改回「複製網址」
  // 方框右上角帶箭頭的「在新分頁開啟」圖示
  const OPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
  const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i;
  const IMAGE_HOSTS = /(?:^|\.)(?:fbcdn\.net|cdninstagram\.com|twimg\.com|i\.imgur\.com|pximg\.net|truth\.bahamut\.com\.tw)$/i;

  const API = {
    forumToken: (bsn) => `https://api.gamer.com.tw/forum/v1/image_token.php?bsn=${bsn}`,
    forumDone: (token, bsn) => `https://api.gamer.com.tw/forum/v1/image_upload.php?token=${encodeURIComponent(token)}&bsn=${bsn}`,
    commonToken: () => 'https://api.gamer.com.tw/ajax/common/truth_image_token.php',
    commonDone: (token) => `https://api.gamer.com.tw/ajax/common/truth_image_realupload.php?token=${encodeURIComponent(token)}`,
    upload: 'https://picc.gamer.com.tw/ajax/truth_image_upload.php',
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const formatTime = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const formatSize = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

  const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- 上傳紀錄（存在 Tampermonkey 的 GM storage，跨分頁共用，清除網站資料也不會消失） ----------

  const history = {
    load() {
      const list = GM_getValue(HISTORY_KEY, []);
      return Array.isArray(list) ? list : [];
    },
    add(entry) {
      const list = history.load().filter((item) => item.url !== entry.url);
      list.unshift(entry);
      GM_setValue(HISTORY_KEY, list.slice(0, HISTORY_LIMIT));
    },
    remove(url) {
      GM_setValue(HISTORY_KEY, history.load().filter((item) => item.url !== url));
    },
    clear() {
      GM_setValue(HISTORY_KEY, []);
    },
  };

  // ---------- 從剪貼簿 / 拖曳資料找出圖片 ----------

  const safeGetData = (dt, type) => {
    try {
      return dt.getData(type) || '';
    } catch {
      return '';
    }
  };

  function isImageUrl(value) {
    if (/^data:image\//i.test(value)) return true;
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) && (IMAGE_EXT.test(url.pathname) || IMAGE_HOSTS.test(url.hostname));
    } catch {
      return false;
    }
  }

  // 回傳 [{ file }] 或 [{ url }]；沒有圖片時回傳空陣列，交給原本的貼上行為
  function extractImageSources(dt) {
    if (!dt) return [];
    const plainText = safeGetData(dt, 'text/plain').trim();
    const hasRealText = Boolean(plainText) && !(/^\S+$/.test(plainText) && isImageUrl(plainText));

    const files = [...(dt.files || [])].filter((file) => file.type.startsWith('image/'));
    if (!files.length) {
      [...(dt.items || [])].forEach((item) => {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) return;
        const file = item.getAsFile();
        if (file) files.push(file);
      });
    }
    // 從 Excel / Word 複製時剪貼簿也會附一張預覽圖，有實際文字就當成文字貼上
    if (files.length && !hasRealText) return files.map((file) => ({ file }));

    const urls = [];
    const html = safeGetData(dt, 'text/html');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const srcs = [...doc.images].map((img) => img.getAttribute('src') || '').filter((src) => /^(?:https?:|data:image\/)/i.test(src));
      if (srcs.length && !doc.body.textContent.trim()) urls.push(...srcs);
    }
    if (!urls.length) {
      const uriList = safeGetData(dt, 'text/uri-list').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
      const candidates = uriList.length ? uriList : /^\S+$/.test(plainText) ? [plainText] : [];
      urls.push(...candidates.filter(isImageUrl));
    }
    return [...new Set(urls)].map((url) => ({ url }));
  }

  // ---------- 下載、轉檔、上傳 ----------

  function downloadImage(url) {
    if (/^data:/i.test(url)) return fetch(url).then((res) => res.blob());
    return new Promise((resolve, reject) => {
      const headers = /(?:^|\.)pximg\.net$/i.test(new URL(url).hostname) ? { Referer: 'https://www.pixiv.net/' } : {};
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        headers,
        responseType: 'blob',
        timeout: 30000,
        onload: (res) => {
          const type = ((res.responseHeaders || '').match(/^content-type:\s*([^;\r\n]+)/im) || [])[1] || '';
          const blob = res.response;
          if (res.status < 200 || res.status >= 300 || !blob) return reject(new Error(`無法下載圖片（HTTP ${res.status}）`));
          if (blob.type.startsWith('image/')) return resolve(blob);
          if (type.startsWith('image/')) return resolve(new Blob([blob], { type }));
          reject(new Error('網址不是圖片'));
        },
        onerror: () => reject(new Error('無法下載圖片')),
        ontimeout: () => reject(new Error('下載圖片逾時')),
      });
    });
  }

  async function prepareImage(blob) {
    const type = blob.type.toLowerCase();
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      if (ACCEPTED_TYPES.includes(type)) return { blob, width: 0, height: 0 };
      throw new Error('不支援的圖片格式');
    }
    const { width, height } = bitmap;
    const needConvert = !ACCEPTED_TYPES.includes(type);
    const needResize = width > MAX_WIDTH && type !== 'image/gif';
    if (!needConvert && !needResize) {
      bitmap.close();
      return { blob, width, height };
    }

    const scale = needResize ? MAX_WIDTH / width : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const output = await new Promise((resolve) => canvas.toBlob(resolve, needConvert ? 'image/png' : type, 0.92));
    if (!output) throw new Error('圖片轉檔失敗');
    // 與巴哈內建上傳相同：縮圖後反而比較大就上傳原檔（伺服器會再自動壓縮）
    if (!needConvert && output.size >= blob.size) return { blob, width, height };
    return { blob: output, width: canvas.width, height: canvas.height };
  }

  const apiError = (json) => json?.error?.message || (json?.code !== undefined && json?.message) || '';

  async function fetchJson(url, options = {}) {
    // 巴哈偶爾會讓請求卡很久才回錯誤，逾時就直接中斷改走重試
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch(url, { credentials: 'include', signal: controller.signal, ...options });
      if (!res.ok) throw new Error(`伺服器回應 HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('伺服器回應逾時');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function uploadToBaha(blob, bsn) {
    const tokenJson = await fetchJson(bsn ? API.forumToken(bsn) : API.commonToken());
    const token = tokenJson.token || tokenJson.data?.token;
    if (!token) throw new Error(apiError(tokenJson) === 'ERR_NOLOGIN' ? '請先登入巴哈姆特' : apiError(tokenJson) || '取得上傳權杖失敗');

    const ext = { 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[blob.type] || 'jpg';
    const form = new FormData();
    form.append('token', token);
    form.append('dzfile', blob, `image.${ext}`);
    const uploadJson = await fetchJson(API.upload, { method: 'POST', body: form });
    if (!uploadJson.token) throw new Error(apiError(uploadJson) || '上傳失敗');

    const doneJson = await fetchJson(bsn ? API.forumDone(uploadJson.token, bsn) : API.commonDone(uploadJson.token));
    const list = doneJson.data?.list || (Array.isArray(doneJson) ? doneJson : null);
    if (!list?.[0]) throw new Error(apiError(doneJson) || '上傳失敗');
    return list[0];
  }

  // ---------- 插入目標：主編輯框（bahaRte）或留言等 textarea ----------

  let lastTarget = null;

  const getRte = () => (document.getElementById('editor') && pageWindow.bahaRte?.doc ? pageWindow.bahaRte : null);

  function targetFromElement(element) {
    if (!(element instanceof HTMLTextAreaElement) || element.readOnly || element.disabled) return null;
    if (element.id === 'source' && getRte()) return { kind: 'rte' };
    return { kind: 'textarea', el: element };
  }

  function resolveTarget() {
    if (lastTarget?.kind === 'textarea' && lastTarget.el.isConnected) return lastTarget;
    if (getRte()) return { kind: 'rte' };
    const comment = document.querySelector('.reply-input textarea');
    return comment ? { kind: 'textarea', el: comment } : null;
  }

  function describeTarget(target) {
    if (!target) return '沒有編輯框，上傳後會複製網址';
    if (target.kind === 'rte') return '插入到文章編輯框';
    return target.el.closest('.reply-input') ? '插入到留言框' : '插入到目前的輸入框';
  }

  function bsnForTarget(target) {
    const fromTarget = target?.kind === 'textarea' ? target.el.dataset.bsn : '';
    const bsn = fromTarget || new URLSearchParams(location.search).get('bsn') || '';
    return /^\d+$/.test(bsn) ? bsn : '';
  }

  function insertText(textarea, text) {
    textarea.focus();
    textarea.setRangeText(text, textarea.selectionStart, textarea.selectionEnd, 'end');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function insertImage(target, url) {
    const rte = target?.kind === 'rte' ? getRte() : null;
    if (rte) {
      if (rte.isPlainText) {
        insertText(rte.source, `[img=${url}]\n`);
      } else {
        rte.win.focus();
        const selection = rte.win.getSelection();
        if (!selection.rangeCount) {
          const range = rte.doc.createRange();
          range.selectNodeContents(rte.doc.body);
          range.collapse(false);
          selection.addRange(range);
        }
        rte.doc.execCommand('insertHTML', false, `<img src="${escapeHtml(url)}"><br>`);
      }
      pageWindow.Forum?.Editor?.detectThumbnail?.();
      return true;
    }
    if (target?.kind === 'textarea' && target.el.isConnected) {
      insertText(target.el, target.el.closest('.reply-input') ? `${url} ` : `${url}\n`);
      return true;
    }
    return false;
  }

  // ---------- 上傳佇列（一次一張，每張間隔 UPLOAD_INTERVAL） ----------

  const queue = [];
  let queueRunning = false;
  let batch = null;

  function enqueue(sources, target, via) {
    if (!batch) batch = { total: 0, done: 0, failed: 0, errors: [], copied: [] };
    sources.forEach((source) => queue.push({ ...source, target, via }));
    batch.total += sources.length;
    showProgress();
    if (!queueRunning) void runQueue();
  }

  async function runQueue() {
    queueRunning = true;
    let first = true;
    while (queue.length) {
      const job = queue.shift();
      if (!first) await sleep(UPLOAD_INTERVAL);
      first = false;
      showProgress();
      try {
        // 已經是巴哈圖床的圖片就直接插入，不重複上傳
        if (job.url && /^https:\/\/truth\.bahamut\.com\.tw\//i.test(job.url)) {
          if (!insertImage(job.target, job.url)) batch.copied.push(job.url);
          batch.done++;
          continue;
        }
        const source = job.file || await downloadImage(job.url);
        const { blob, width, height } = await prepareImage(source);
        const bsn = bsnForTarget(job.target);
        let url;
        try {
          url = await uploadToBaha(blob, bsn);
        } catch (error) {
          if (/請先登入/.test(error?.message)) throw error;
          await sleep(RETRY_DELAY);
          url = await uploadToBaha(blob, bsn);
        }
        if (!insertImage(job.target, url)) batch.copied.push(url);
        history.add({
          url,
          time: Date.now(),
          size: blob.size,
          width,
          height,
          bsn,
          page: location.href,
          via: job.via,
          from: job.url && !/^data:/i.test(job.url) ? job.url : '',
        });
        batch.done++;
      } catch (error) {
        batch.failed++;
        batch.errors.push(error?.message || String(error));
      }
    }
    queueRunning = false;
    finishBatch();
  }

  // ---------- 畫面：進度提示 ----------

  let toast = null;
  let toastTimer = null;

  function showToast(html, { error = false, duration = 0 } = {}) {
    injectStyles();
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'bimg-toast';
      document.body.appendChild(toast);
    }
    clearTimeout(toastTimer);
    toast.classList.toggle('bimg-toast--error', error);
    toast.innerHTML = html;
    toast.hidden = false;
    toast.querySelector('[data-bimg-history]')?.addEventListener('click', openHistory);
    if (duration) toastTimer = setTimeout(() => (toast.hidden = true), duration);
  }

  function showProgress() {
    const current = Math.min(batch.done + batch.failed + 1, batch.total);
    showToast(`<span class="bimg-spinner"></span>圖片上傳中 ${current} / ${batch.total}`);
  }

  function finishBatch() {
    const { done, failed, errors, copied } = batch;
    batch = null;
    if (copied.length) GM_setClipboard(copied.join('\n'));
    const parts = [];
    if (done) parts.push(`已上傳 ${done} 張`);
    if (copied.length) parts.push('找不到編輯框，網址已複製');
    if (failed) parts.push(`失敗 ${failed} 張：${escapeHtml([...new Set(errors)].join('、'))}`);
    showToast(`${parts.join('，')} <button type="button" data-bimg-history>上傳紀錄</button>`, { error: failed > 0, duration: failed ? 10000 : 5000 });
  }

  // ---------- 畫面：拖曳遮罩 ----------

  let overlay = null;
  let lastDragOver = 0;
  let overlayWatchdog = null;

  const isFileDrag = (dt) => Boolean(dt) && [...dt.types].includes('Files');

  function showOverlay() {
    injectStyles();
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'bimg-overlay';
      overlay.innerHTML = '<div class="bimg-overlay__box"><div class="bimg-overlay__title">把圖片拉進來以上傳</div><div class="bimg-overlay__sub"></div></div>';
      overlay.addEventListener('dragover', (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        lastDragOver = Date.now();
      });
      overlay.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        hideOverlay();
        const sources = extractImageSources(event.dataTransfer);
        if (!sources.length) return showToast('沒有可以上傳的圖片', { error: true, duration: 4000 });
        enqueue(sources, resolveTarget(), 'drop');
      });
      document.body.appendChild(overlay);
    }
    overlay.querySelector('.bimg-overlay__sub').textContent = `可一次拖曳多張・${describeTarget(resolveTarget())}`;
    overlay.hidden = false;
    lastDragOver = Date.now();
    // 拖曳期間 dragover 會持續觸發；停止觸發代表已拖離視窗或取消
    clearInterval(overlayWatchdog);
    overlayWatchdog = setInterval(() => Date.now() - lastDragOver > 400 && hideOverlay(), 150);
  }

  function hideOverlay() {
    clearInterval(overlayWatchdog);
    if (overlay) overlay.hidden = true;
  }

  // ---------- 畫面：上傳紀錄 ----------

  function openHistory() {
    injectStyles();
    document.querySelector('.bimg-modal-backdrop')?.remove();
    const backdrop = document.createElement('div');
    backdrop.className = 'bimg-modal-backdrop';
    backdrop.innerHTML = `
      <div class="bimg-modal" role="dialog" aria-labelledby="bimg-modal-title">
        <div class="bimg-modal__header">
          <h2 id="bimg-modal-title">上傳紀錄</h2>
          <span class="bimg-modal__count"></span>
          <button type="button" data-action="export">匯出 JSON</button>
          <button type="button" data-action="clear">清除全部</button>
          <button type="button" class="bimg-modal__close" aria-label="關閉">&times;</button>
        </div>
        <div class="bimg-modal__body"><div class="bimg-grid"></div><button type="button" class="bimg-more" data-action="more">載入更多</button></div>
      </div>`;
    document.body.appendChild(backdrop);

    const grid = backdrop.querySelector('.bimg-grid');
    const moreButton = backdrop.querySelector('.bimg-more');
    let list = history.load();
    let shown = 0;

    const renderCount = () => {
      backdrop.querySelector('.bimg-modal__count').textContent = `${list.length} 張`;
    };

    const renderMore = () => {
      list.slice(shown, shown + HISTORY_PAGE_SIZE).forEach((item) => {
        const card = document.createElement('div');
        card.className = 'bimg-card';
        const thumb = document.createElement('div');
        thumb.className = 'bimg-card__thumb';
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = item.url;
        img.alt = '';
        img.title = '點擊放大預覽';
        img.addEventListener('click', () => openLightbox(item.url));
        const openLink = document.createElement('a');
        openLink.className = 'bimg-card__open';
        openLink.href = item.url;
        openLink.target = '_blank';
        openLink.rel = 'noopener';
        openLink.title = '在新分頁開啟';
        openLink.setAttribute('aria-label', '在新分頁開啟');
        openLink.innerHTML = OPEN_ICON;
        thumb.append(img, openLink);
        const meta = document.createElement('div');
        meta.className = 'bimg-card__meta';
        const dims = item.width ? `${item.width}×${item.height}・` : '';
        meta.textContent = `${formatTime(item.time)}・${dims}${formatSize(item.size || 0)}${item.via === 'drop' ? '・拖曳' : '・貼上'}`;
        if (item.from) meta.title = `來源：${item.from}`;
        const actions = document.createElement('div');
        actions.className = 'bimg-card__actions';
        let copiedTimer = null;
        [['insert', '插入'], ['copy', '複製網址'], ['delete', '刪除']].forEach(([action, label]) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          if (action === 'delete') button.className = 'bimg-btn--danger';
          button.addEventListener('click', () => {
            if (action === 'insert') {
              const target = resolveTarget();
              if (insertImage(target, item.url)) backdrop.remove();
              else {
                GM_setClipboard(item.url);
                showToast('找不到編輯框，網址已複製', { duration: 3000 });
              }
            } else if (action === 'copy') {
              GM_setClipboard(item.url);
              button.textContent = '✓ 已複製';
              button.classList.add('bimg-btn--done');
              clearTimeout(copiedTimer);
              copiedTimer = setTimeout(() => {
                button.textContent = label;
                button.classList.remove('bimg-btn--done');
              }, COPIED_RESET_DELAY);
            } else {
              if (!confirm('確定要從上傳紀錄中刪除這張圖片嗎？\n\n只會從紀錄中移除，不會刪除巴哈圖床上的圖片本身，已經發表的文章與留言也不受影響。')) return;
              history.remove(item.url);
              list = list.filter((entry) => entry.url !== item.url);
              shown--;
              card.remove();
              renderCount();
              if (!list.length) renderMore();
            }
          });
          actions.appendChild(button);
        });
        card.append(thumb, meta, actions);
        grid.appendChild(card);
      });
      shown = Math.min(shown + HISTORY_PAGE_SIZE, list.length);
      moreButton.hidden = shown >= list.length;
      if (!list.length) grid.innerHTML = '<p class="bimg-empty">還沒有上傳紀錄。在巴哈任何地方貼上或拖曳圖片就會自動上傳。</p>';
    };

    const close = () => backdrop.remove();
    backdrop.querySelector('.bimg-modal__close').addEventListener('click', close);
    backdrop.addEventListener('click', (event) => event.target === backdrop && close());
    moreButton.addEventListener('click', renderMore);
    backdrop.querySelector('[data-action="export"]').addEventListener('click', () => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([JSON.stringify(history.load(), null, 2)], { type: 'application/json' }));
      link.download = `baha-upload-history-${Date.now()}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    backdrop.querySelector('[data-action="clear"]').addEventListener('click', () => {
      if (!confirm('確定要清除全部上傳紀錄？圖片本身不會被刪除。')) return;
      history.clear();
      list = [];
      shown = 0;
      grid.innerHTML = '';
      renderMore();
      renderCount();
    });

    renderCount();
    renderMore();
  }

  // 燈箱疊在上傳紀錄上方，點圖片以外的地方關閉燈箱、回到上傳紀錄
  function openLightbox(url) {
    closeLightbox();
    const lightbox = document.createElement('div');
    lightbox.className = 'bimg-lightbox';
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    lightbox.appendChild(img);
    lightbox.addEventListener('click', (event) => event.target === lightbox && closeLightbox());
    document.body.appendChild(lightbox);
  }

  const closeLightbox = () => document.querySelector('.bimg-lightbox')?.remove();

  // 與「巴哈黑名單偵測」相同：加在文章頁的「更多」選單裡；
  // 頁首導覽列與往下捲後出現的固定標題列各有一個，兩個都要加
  function installMenuItem() {
    document.querySelectorAll('.BH-menu-forumA-right.dropList > dl').forEach((list) => {
      if (list.querySelector('[data-bimg-history]')) return;
      const item = document.createElement('dd');
      const link = document.createElement('a');
      link.href = 'javascript:void(0)';
      link.dataset.bimgHistory = '1';
      link.textContent = ' 上傳紀錄';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        openHistory();
      });
      item.appendChild(link);
      list.appendChild(item);
    });
  }

  // ---------- 樣式 ----------

  function injectStyles() {
    if (document.getElementById('bimg-style')) return;
    const style = document.createElement('style');
    style.id = 'bimg-style';
    style.textContent = `
      .bimg-toast { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; align-items: center; gap: 10px; max-width: min(460px, calc(100vw - 40px)); padding: 11px 15px; border-radius: 8px; background: #1f2933; color: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.3); font-size: 14px; line-height: 1.5; }
      .bimg-toast[hidden], .bimg-overlay[hidden], .bimg-more[hidden] { display: none !important; }
      .bimg-toast--error { background: #8f2424; }
      .bimg-toast button { flex: none; padding: 3px 9px; border: 1px solid rgba(255,255,255,.6); border-radius: 5px; background: transparent; color: #fff; cursor: pointer; }
      .bimg-spinner { flex: none; width: 14px; height: 14px; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; border-radius: 50%; animation: bimg-spin .8s linear infinite; }
      @keyframes bimg-spin { to { transform: rotate(360deg); } }
      .bimg-overlay { position: fixed; inset: 0; z-index: 2147483001; display: grid; place-items: center; padding: 24px; background: rgba(17,126,150,.28); backdrop-filter: blur(2px); }
      .bimg-overlay__box { display: grid; gap: 10px; place-content: center; justify-items: center; box-sizing: border-box; width: min(640px, 100%); min-height: 260px; padding: 48px 24px; border: 3px dashed #117e96; border-radius: 16px; background: rgba(255,255,255,.94); color: #0c5f72; text-align: center; pointer-events: none; }
      .bimg-overlay__title { font-size: 30px; font-weight: 700; }
      .bimg-overlay__sub { color: #4b6670; font-size: 15px; }
      .bimg-modal-backdrop { position: fixed; inset: 0; z-index: 2147483002; display: grid; place-items: center; padding: 16px; background: rgba(0,0,0,.55); }
      .bimg-modal { display: flex; flex-direction: column; width: min(980px, 100%); max-height: calc(100vh - 32px); overflow: hidden; border-radius: 10px; background: #fff; color: #333; box-shadow: 0 16px 48px rgba(0,0,0,.35); font-size: 14px; }
      .bimg-modal__header { display: flex; align-items: center; gap: 10px; padding: 14px 18px; border-bottom: 1px solid #ddd; }
      .bimg-modal__header h2 { margin: 0; font-size: 19px; }
      .bimg-modal__count { flex: 1; color: #777; }
      .bimg-modal button { padding: 5px 11px; border: 1px solid #bbb; border-radius: 5px; background: transparent; color: inherit; cursor: pointer; }
      .bimg-modal .bimg-modal__close { border: 0; color: #777; font-size: 24px; line-height: 1; }
      .bimg-modal__body { overflow-y: auto; padding: 16px 18px; }
      .bimg-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
      .bimg-card { display: grid; gap: 6px; min-width: 0; padding: 8px; border: 1px solid #ddd; border-radius: 8px; }
      .bimg-card__thumb { position: relative; }
      .bimg-card img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; border-radius: 4px; background: #f2f2f2; cursor: zoom-in; }
      .bimg-card__open { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 6px; background: rgba(0,0,0,.55); color: #fff !important; opacity: .85; transition: opacity .15s, background .15s; }
      .bimg-card__open:hover { background: rgba(0,0,0,.8); opacity: 1; }
      .bimg-modal .bimg-btn--danger { border-color: #d94848; color: #c52f2f; }
      .bimg-modal .bimg-btn--danger:hover { background: #d94848; color: #fff; }
      .bimg-modal .bimg-btn--done { border-color: #2e9e5b; background: #2e9e5b; color: #fff; }
      .bimg-lightbox { position: fixed; inset: 0; z-index: 2147483003; display: grid; place-items: center; padding: 24px; background: rgba(0,0,0,.86); cursor: zoom-out; }
      .bimg-lightbox img { max-width: 100%; max-height: calc(100vh - 48px); object-fit: contain; border-radius: 4px; box-shadow: 0 12px 40px rgba(0,0,0,.5); cursor: default; }
      .bimg-card__meta { overflow: hidden; color: #777; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
      .bimg-card__actions { display: flex; flex-wrap: wrap; gap: 4px; }
      .bimg-modal .bimg-card__actions button { padding: 2px 7px; font-size: 12px; }
      .bimg-more { display: block; margin: 14px auto 0; }
      .bimg-empty { margin: 30px 0; color: #777; text-align: center; }
      @media (prefers-color-scheme: dark) {
        .bimg-overlay__box { background: rgba(30,30,30,.94); color: #7fd3e6; }
        .bimg-overlay__sub { color: #aac; }
        .bimg-modal { background: #252525; color: #eee; }
        .bimg-modal__header, .bimg-card { border-color: #444; }
        .bimg-modal button { border-color: #666; }
        .bimg-card img { background: #1a1a1a; }
        .bimg-modal .bimg-btn--danger { border-color: #d65a5a; color: #ff9a9a; }
      }
    `;
    document.head.appendChild(style);
  }

  // ---------- 事件 ----------

  function handlePaste(event, frameTarget) {
    const sources = extractImageSources(event.clipboardData);
    if (!sources.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = frameTarget || targetFromElement(event.target) || resolveTarget();
    enqueue(sources, target, 'paste');
  }

  function handleDragEnter(event) {
    if (isFileDrag(event.dataTransfer)) showOverlay();
  }

  function handleKeydown(event) {
    if (event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey && event.code === 'KeyU') {
      event.preventDefault();
      openHistory();
    } else if (event.key === 'Escape') {
      if (document.querySelector('.bimg-lightbox')) closeLightbox();
      else document.querySelector('.bimg-modal-backdrop')?.remove();
    }
  }

  window.addEventListener('paste', (event) => handlePaste(event, null), true);
  window.addEventListener('dragenter', handleDragEnter, true);
  window.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('focusin', (event) => {
    const target = targetFromElement(event.target);
    if (target) lastTarget = target;
  }, true);

  // 文章編輯框是 iframe，事件不會傳到外層，要另外掛上
  function hookEditorFrames() {
    document.querySelectorAll('iframe#editor').forEach((frame) => {
      let doc;
      try {
        doc = frame.contentDocument;
      } catch {
        return;
      }
      if (!doc?.documentElement || doc.documentElement.dataset.bimgHooked) return;
      doc.documentElement.dataset.bimgHooked = '1';
      const win = frame.contentWindow;
      // capture 階段先於巴哈掛在 body 上的貼上處理；stopImmediatePropagation 也避免重複掛載時上傳兩次
      win.addEventListener('paste', (event) => handlePaste(event, { kind: 'rte' }), true);
      win.addEventListener('dragenter', handleDragEnter, true);
      win.addEventListener('keydown', handleKeydown, true);
      win.addEventListener('focus', () => {
        lastTarget = { kind: 'rte' };
      });
    });
  }

  hookEditorFrames();
  setInterval(hookEditorFrames, 1000);

  installMenuItem();
  new MutationObserver(installMenuItem).observe(document.body, { childList: true, subtree: true });
})();

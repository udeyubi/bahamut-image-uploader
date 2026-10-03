const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Minimal DOM/GM harness: exercises script handlers without network or real storage.
// isTrusted values model browser events; this is not a browser isolation test.
function setup({ captureUploads = false, history = null, fetch = null } = {}) {
  const nodes = [];
  const uploads = [], revoked = [], windowEvents = {}, documentEvents = {};
  const effects = { reads: 0, writes: 0, copies: 0, confirms: 0, downloads: 0 };
  function element(tag) {
    const queries = new Map();
    const el = {
      tag, children: [], handlers: {}, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} },
      appendChild(child) { this.children.push(child); return child; },
      append(...children) { this.children.push(...children); },
      querySelector(selector) {
        if (!queries.has(selector)) queries.set(selector, element(selector));
        return queries.get(selector);
      },
      addEventListener(type, callback) { this.handlers[type] = callback; },
      setAttribute() {}, remove() {}, focus() {}, click() { effects.downloads++; },
    };
    nodes.push(el);
    return el;
  }
  let entries = history || Array.from({ length: 61 }, (_, i) => ({
    url: `https://truth.bahamut.com.tw/test-${i}.png`, time: 1, size: 1,
  }));
  const menu = element('menu');
  menu.querySelector = () => null;
  const context = {
    window: { addEventListener(type, fn) { windowEvents[type] = fn; } },
    HTMLTextAreaElement: class { closest() { return null; } },
    document: {
      body: element('body'), head: element('head'), createElement: element,
      getElementById() { return null; }, querySelector() { return null; },
      querySelectorAll(selector) { return selector.includes('dropList') ? [menu] : []; },
      addEventListener(type, fn) { documentEvents[type] = fn; },
    },
    GM_getValue() { effects.reads++; return entries; },
    GM_setValue(key, value) { effects.writes++; entries = value; },
    GM_setClipboard() { effects.copies++; },
    confirm() { effects.confirms++; return true; },
    MutationObserver: class { observe() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    URL: class extends URL { static createObjectURL() { return `blob:test-${nodes.length}`; } static revokeObjectURL(url) { revoked.push(url); } }, Blob,
    recordUpload(sources, target, via) { uploads.push({ sources, target, via }); },
    fetch, AbortController, FormData, location: { search: '', href: 'https://forum.gamer.com.tw/' },
  };
  vm.createContext(context);
  const source = fs.readFileSync(require.resolve('../baha-image-uploader.user.js'), 'utf8');
  const capture = captureUploads ? 'enqueue = recordUpload; globalThis.testPaste = handlePaste;' : '';
  const internals = 'globalThis.testUpload = uploadToBaha; globalThis.testSafeUrl = isSafeImageUrl;';
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, `globalThis.testToast = showToast; ${capture} ${internals} })();`), context);
  const click = (node, trusted) => node.handlers.click({ isTrusted: trusted, preventDefault() {} });
  return { nodes, effects, context, click, uploads, revoked, windowEvents, documentEvents, menuLink: menu.children[0].children[0] };
}

test('menu and toast refuse synthetic opening before reading history', () => {
  const h = setup();
  h.click(h.menuLink, false);
  h.context.testToast('<button data-bimg-history>History</button>');
  const toastLink = h.nodes.find(n => n.tag === '[data-bimg-history]');
  h.click(toastLink, false);
  assert.equal(h.effects.reads, 0);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 0);
  h.click(toastLink, true);
  assert.equal(h.effects.reads, 1);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 60);
});

test('history actions reject synthetic events and allow trusted actions', () => {
  const h = setup();
  h.click(h.menuLink, true);
  const more = h.nodes.find(n => n.tag === '.bimg-more');
  const exp = h.nodes.find(n => n.tag === '[data-action="export"]');
  const clear = h.nodes.find(n => n.tag === '[data-action="clear"]');
  const buttons = ['插入', '複製網址', '刪除'].map(label => h.nodes.find(n => n.textContent === label));
  const img = h.nodes.find(n => n.tag === 'img');
  const before = { ...h.effects };
  for (const node of [more, exp, clear, img, ...buttons]) h.click(node, false);
  assert.deepEqual(h.effects, before);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 60);
  h.click(more, true);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 61);
  h.click(img, true);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 62);
  h.click(buttons[0], true); // No editor: falls back to clipboard.
  h.click(buttons[1], true);
  assert.equal(h.effects.copies, 2);
  h.click(exp, true);
  assert.equal(h.effects.downloads, 1);
  h.click(buttons[2], true);
  h.click(clear, true);
  assert.equal(h.effects.writes, 2);
  assert.equal(h.effects.confirms, 2);
});

function paste(h, target = {}, frameTarget = null, text = '', files = [new Blob(['image'], { type: 'image/png' })], isTrusted = true) {
  const event = {
    isTrusted, target, clipboardData: { files, getData: () => text }, prevented: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() {},
  };
  h.context.testPaste(event, frameTarget);
  return event;
}

test('global paste previews, appends, removes and requires trusted confirmation', () => {
  const h = setup({ captureUploads: true });
  const textarea = new h.context.HTMLTextAreaElement();
  textarea.isConnected = true;
  h.documentEvents.focusin({ target: textarea });
  assert.equal(paste(h).prevented, true);
  paste(h);
  assert.equal(h.uploads.length, 0);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 2);
  const upload = h.nodes.find(n => n.tag === '[data-action="upload"]');
  h.click(upload, false);
  assert.equal(h.uploads.length, 0);
  h.click(h.nodes.find(n => n.textContent === '移除'), true);
  h.click(upload, true);
  assert.equal(h.uploads.length, 1);
  assert.equal(h.uploads[0].sources.length, 1);
  assert.equal(h.uploads[0].target.el, textarea);
  assert.equal(h.revoked.length, 2);
  h.click(upload, true);
  assert.equal(h.uploads.length, 1);
});

test('cancel, Escape and removing all images release previews without uploading', () => {
  for (const action of ['cancel', 'escape', 'remove']) {
    const h = setup({ captureUploads: true });
    paste(h);
    if (action === 'cancel') h.click(h.nodes.find(n => n.tag === '[data-action="cancel"]'), true);
    if (action === 'escape') h.windowEvents.keydown({ key: 'Escape' });
    if (action === 'remove') h.click(h.nodes.find(n => n.textContent === '移除'), true);
    h.click(h.nodes.find(n => n.tag === '[data-action="upload"]'), true);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.revoked.length, 1);
  }
});

test('direct textarea and iframe paste bypass preview; text and URLs remain untouched', () => {
  const h = setup({ captureUploads: true });
  const textarea = new h.context.HTMLTextAreaElement();
  paste(h, textarea);
  paste(h, {}, { kind: 'rte' });
  assert.equal(h.uploads.length, 2);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 0);
  assert.equal(paste(h, {}, null, 'ordinary text').prevented, false);
  assert.equal(paste(h, {}, null, 'https://example.com/image.png', []).prevented, false);
  textarea.readOnly = true;
  paste(h, textarea);
  assert.equal(h.uploads.length, 2);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 1);
});

test('synthetic paste is ignored and left to the page', () => {
  const h = setup({ captureUploads: true });
  const textarea = new h.context.HTMLTextAreaElement();
  for (const [target, frame] of [[{}, null], [textarea, null], [{}, { kind: 'rte' }]]) {
    assert.equal(paste(h, target, frame, '', undefined, false).prevented, false);
  }
  assert.equal(h.uploads.length, 0);
  assert.equal(h.nodes.filter(n => n.tag === 'img').length, 0);
});

test('only https Bahamut image URLs are accepted', () => {
  const { context } = setup();
  for (const url of [
    'https://truth.bahamut.com.tw/s01/202610/abc.PNG',
    'https://im.bahamut.com.tw/a.jpg',
    'https://p2.bahamut.com.tw/B/2KU/a.webp',
  ]) assert.equal(context.testSafeUrl(url), true, url);
  for (const url of [
    'javascript:alert(1)', 'http://truth.bahamut.com.tw/a.png', 'https://evil.com/a.png',
    'https://truth.bahamut.com.tw.evil.com/a.png', 'https://evilbahamut.com.tw/a.png',
    'https://truth.bahamut.com.tw/a.png]x[/img]', 'https://truth.bahamut.com.tw/a b.png',
    'https://truth.bahamut.com.tw/a".png', 'https://u:p@truth.bahamut.com.tw/a.png',
    'data:image/png;base64,AAAA', '', null, { toString: () => 'https://truth.bahamut.com.tw/a.png' },
  ]) assert.equal(context.testSafeUrl(url), false, String(url));
});

test('history skips stored entries with unsafe URLs', () => {
  const h = setup({ history: [
    { url: 'https://truth.bahamut.com.tw/ok.png', time: 1, size: 1 },
    { url: 'javascript:alert(1)', time: 1, size: 1 },
    { url: 'https://evil.com/a.png', time: 1, size: 1 },
    null, 'https://truth.bahamut.com.tw/not-an-object.png',
  ] });
  h.click(h.menuLink, true);
  const imgs = h.nodes.filter(n => n.tag === 'img');
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].src, 'https://truth.bahamut.com.tw/ok.png');
  assert.equal(h.nodes.find(n => n.tag === 'a' && n.className === 'bimg-card__open').href, 'https://truth.bahamut.com.tw/ok.png');
});

test('upload rejects a non-Bahamut URL returned by the server', async () => {
  const replies = (url) => [{ token: 't1' }, { token: 't2' }, { data: { list: [url] } }];
  const fakeFetch = (queue) => async () => ({ ok: true, json: async () => queue.shift() });
  const bad = setup({ fetch: fakeFetch(replies('javascript:alert(1)')) });
  await assert.rejects(bad.context.testUpload(new Blob(['x'], { type: 'image/png' }), '60076'), /網址不正確/);
  const good = setup({ fetch: fakeFetch(replies('https://truth.bahamut.com.tw/s01/a.png')) });
  assert.equal(await good.context.testUpload(new Blob(['x'], { type: 'image/png' }), '60076'), 'https://truth.bahamut.com.tw/s01/a.png');
});

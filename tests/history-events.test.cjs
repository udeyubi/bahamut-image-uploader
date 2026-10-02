const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

// Minimal DOM/GM harness: exercises script handlers without network or real storage.
// isTrusted values model browser events; this is not a browser isolation test.
function setup() {
  const nodes = [];
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
      setAttribute() {}, remove() {}, click() { effects.downloads++; },
    };
    nodes.push(el);
    return el;
  }
  let entries = Array.from({ length: 61 }, (_, i) => ({
    url: `https://truth.bahamut.com.tw/test-${i}.png`, time: 1, size: 1,
  }));
  const menu = element('menu');
  menu.querySelector = () => null;
  const context = {
    window: { addEventListener() {} },
    document: {
      body: element('body'), head: element('head'), createElement: element,
      getElementById() { return null; }, querySelector() { return null; },
      querySelectorAll(selector) { return selector.includes('dropList') ? [menu] : []; },
      addEventListener() {},
    },
    GM_getValue() { effects.reads++; return entries; },
    GM_setValue(key, value) { effects.writes++; entries = value; },
    GM_setClipboard() { effects.copies++; },
    confirm() { effects.confirms++; return true; },
    MutationObserver: class { observe() {} },
    setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
    URL: { createObjectURL() { return 'blob:test'; }, revokeObjectURL() {} }, Blob,
  };
  vm.createContext(context);
  const source = fs.readFileSync(require.resolve('../baha-image-uploader.user.js'), 'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.testToast = showToast; })();'), context);
  const click = (node, trusted) => node.handlers.click({ isTrusted: trusted, preventDefault() {} });
  return { nodes, effects, context, click, menuLink: menu.children[0].children[0] };
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

// dsh-file-viewer 客户端行为测试（node:test + jsdom + react/react-dom devDeps）。
// 缺 devDeps 时整组用例标记 skip，不影响 `node --test tests/` 在最小环境下通过。
//
// 覆盖 v7.5 下载功能的关键行为：
//   1. 文件列表每个文件行尾渲染「⬇」下载徽章（目录行没有）；
//   2. 点徽章 → 走 viewer.download RPC + <a download> 保存，且**不**触发行「打开」；
//   3. 点行/标题 → 仍是打开预览（viewer.list → viewer.range），meta 栏出现「⬇ 下载」；
//   4. 超过下载上限（64MB）的文件：徽章点击不发请求，直接给出明确错误。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKIP_REASON = 'jsdom/react devDeps 未安装（npm install 后可运行客户端测试）';
let skipReason = SKIP_REASON;

let ready = false;
let JSDOM;
let dom;
let container;
let props;
let router;
let calls;
let anchorCapture;
let badges;
let flush;
let clickEl;
let openPathInViewer;
// 固定的修改时间（2026-03-05 06:07 UTC，本地渲染随测试机时区，断言用同一函数口径）
const MTIME = Date.UTC(2026, 2, 5, 6, 7, 0);
const MTIME_TEXT = (() => {
  const d = new Date(MTIME);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
})();

before(async () => {
  let React;
  let act;
  let ReactDOMClient;
  try {
    ({ JSDOM } = await import('jsdom'));
    // jsdom 全局必须先于 react 导入建立（react-dom 在导入期探测 DOM 环境）。
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.HTMLElement = dom.window.HTMLElement;
    globalThis.HTMLAnchorElement = dom.window.HTMLAnchorElement;
    globalThis.MouseEvent = dom.window.MouseEvent;
    try { if (typeof globalThis.navigator === "undefined") globalThis.navigator = dom.window.navigator; } catch { /* Node>=21 自带只读 navigator，无需覆盖 */ } // react-dom 18 在 Node<21 依赖全局 navigator
    globalThis.IS_REACT_ACT_ENVIRONMENT = true; // react-dom act() 环境标记
    // jsdom 没有 createObjectURL/revokeObjectURL
    dom.window.URL.createObjectURL = () => 'blob:mock-' + Math.random();
    dom.window.URL.revokeObjectURL = () => {};
    globalThis.URL = dom.window.URL;
    React = (await import('react')).default;
    ({ act } = await import('react'));
    ReactDOMClient = await import('react-dom/client');
  } catch (error) {
    ready = false; // devDeps 缺失或环境异常：测试全部 skip（原因留在 skipReason）
    skipReason = error && error.message ? error.message : String(error);
    return;
  }

  const root = dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(join(root, '..', 'client', 'client.src.js'), 'utf8');

  // 捕获 <a download> 触发（jsdom 的 click 不导航）
  anchorCapture = null;
  dom.window.HTMLAnchorElement.prototype.click = function click() {
    anchorCapture = { href: this.href, download: this.download };
  };

  // ---- 加载客户端半边（__ModuleLoader__ 经典脚本约定） ----
  const captured = {};
  dom.window.__ModuleLoader__ = { load(def) { captured.def = def; } };
  new Function('window', SRC)(dom.window);
  assert.ok(captured.def, '客户端脚本应注册进 __ModuleLoader__');
  const exported = captured.def.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require: ' + name);
  });
  assert.equal(exported.name, 'dsh-file-viewer');

  // ---- fake 插件 ctx + RPC 路由 ----
  const DIR = '/srv/dir';
  const FILE = '/srv/dir/note.txt';
  const fileBytes = new TextEncoder().encode('hello download\n');
  const b64 = (bytes) => Buffer.from(bytes).toString('base64');
  calls = [];
  router = (endpoint, payload = {}) => {
    calls.push({ endpoint, payload });
    if (endpoint === 'viewer.list') {
      if (payload.path === DIR) {
        return Promise.resolve({ ok: true, value: {
          kind: 'dir', path: DIR, truncated: false,
          entries: [
            { name: 'sub', kind: 'dir', path: DIR + '/sub', mtime: MTIME },
            { name: 'note.txt', kind: 'file', path: FILE, size: fileBytes.length, mtime: MTIME },
            { name: 'huge.bin', kind: 'file', path: DIR + '/huge.bin', size: 70 * 1024 * 1024, mtime: MTIME },
          ],
        } });
      }
      return Promise.resolve({ ok: true, value: { kind: 'file', path: payload.path } });
    }
    if (endpoint === 'viewer.range') {
      return Promise.resolve({ ok: true, value: {
        total: fileBytes.length, offset: 0, chunk: b64(fileBytes), done: true,
        kind: 'text', mime: 'text/plain', name: 'note.txt', path: FILE,
      } });
    }
    if (endpoint === 'viewer.download') {
      return Promise.resolve({ ok: true, value: {
        total: fileBytes.length, offset: 0, chunk: b64(fileBytes), done: true,
        name: 'note.txt', mime: 'text/plain', path: FILE,
      } });
    }
    return Promise.reject(new Error('unexpected endpoint ' + endpoint));
  };

  const registered = {};
  const ctx = {
    slots: {
      inject(name, fn) { registered[name] = fn; },
      register(def, Comp) { return { def, Comp }; },
    },
    locale: { bind: () => (k) => k, register: () => () => {} },
    connection: { rpc: { call: (_channel, endpoint, payload) => router(endpoint, payload) } },
    effect: (fn) => fn(),
  };
  exported.apply(ctx);
  const view = registered['conversation.view']();
  const Comp = view.Comp;
  props = Object.assign({}, view.def.inject(), { t: (k) => k, sessionId: 'sess-1' });

  container = dom.window.document.getElementById('root');
  const r = ReactDOMClient.createRoot(container);
  await act(async () => { r.render(React.createElement(Comp, props)); });

  flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
  openPathInViewer = (p) => act(async () => { props.store.open(p); await flush(); });
  clickEl = (el) => act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
  });
  badges = () => Array.from(container.querySelectorAll('span[role="button"]'))
    .filter((el) => (el.textContent || '').indexOf('⬇') === 0);
  ready = true;
  await openPathInViewer('/srv/dir');
});

let afterHookRestore = null;

test('client: dir list renders a download badge after each file entry (not dirs)', async (t) => {
  if (!ready) { t.skip(skipReason); return; }
  assert.ok(ready);
  const text = container.textContent;
  assert.ok(text.includes('note.txt'), '文件行应出现');
  assert.ok(text.includes('huge.bin'), '超限文件行也应出现');
  assert.ok(text.includes('sub'), '子目录行应出现');
  // 徽章数量 = 文件数（note.txt + huge.bin），目录行没有徽章
  const titles = badges().map((el) => el.getAttribute('title'));
  assert.equal(badges().length, 2, '徽章数应等于文件数，实际 titles=' + JSON.stringify(titles));
  assert.ok(titles.some((x) => (x || '').includes('note.txt')));
  assert.ok(titles.some((x) => (x || '').includes('huge.bin')));
  // 文件和目录行都显示修改时间（YYYY-MM-DD HH:mm）
  const timeCells = Array.from(container.querySelectorAll('span')).filter((el) => el.textContent === MTIME_TEXT);
  assert.ok(timeCells.length >= 3, '三个条目行都应显示修改时间 ' + MTIME_TEXT + '，实际=' + container.textContent.slice(0, 160));
  assert.ok(container.textContent.includes(MTIME_TEXT), '列表应包含格式化后的修改时间');
});

test('client: clicking the badge downloads the file without opening it', async (t) => {
  if (!ready) { t.skip(skipReason); return; }
  const badge = badges().find((el) => (el.getAttribute('title') || '').includes('note.txt'));
  assert.ok(badge, 'note.txt 的下载徽章应存在');
  calls.length = 0;
  anchorCapture = null;
  await clickEl(badge);
  const endpoints = calls.map((c) => c.endpoint);
  assert.ok(endpoints.includes('viewer.download'), '徽章点击应走 viewer.download：' + endpoints.join(','));
  assert.equal(endpoints.filter((x) => x === 'viewer.list').length, 0, '徽章点击不应触发「打开」（viewer.list）');
  assert.ok(anchorCapture, '应触发 <a download> 保存');
  assert.equal(anchorCapture.download, 'note.txt', '保存文件名应为原始文件名');
  assert.ok(String(anchorCapture.href).startsWith('blob:'), 'href 应是 object URL');
});

test('client: clicking the row title still opens the file, meta bar gains a download button', async (t) => {
  if (!ready) { t.skip(skipReason); return; }
  const row = Array.from(container.querySelectorAll('div[role="button"]'))
    .find((el) => (el.getAttribute('title') || '') === '/srv/dir/note.txt');
  assert.ok(row, 'note.txt 行应存在');
  calls.length = 0;
  await clickEl(row);
  const endpoints = calls.map((c) => c.endpoint);
  assert.ok(endpoints.includes('viewer.list'), '点行应先走 viewer.list 判断目录/文件');
  assert.equal(endpoints.filter((x) => x === 'viewer.download').length, 0, '点行不应触发下载');
  // 打开后 meta 栏应有带文字的下载按钮
  const metaBadge = badges().find((el) => (el.textContent || '').includes('download'));
  assert.ok(metaBadge, '文件视图 meta 栏应有「⬇ 下载」按钮');
});

test('client: oversize file badge click → clear error, no download RPC', async (t) => {
  if (!ready) { t.skip(skipReason); return; }
  // 上个用例切到了文件视图：点「⬅ 所在目录」链接返回目录视图（同 store.open 同路径会被去重守卫挡住）
  const parentLink = Array.from(container.querySelectorAll('span[role="button"]'))
    .find((el) => (el.getAttribute('title') || '') === '/srv/dir' && (el.textContent || '').includes('⬅'));
  assert.ok(parentLink, '文件视图应有「所在目录」返回链接');
  await clickEl(parentLink);
  await flush();
  const badge = badges().find((el) => (el.getAttribute('title') || '').includes('huge.bin'));
  assert.ok(badge, 'huge.bin 的下载徽章应存在');
  calls.length = 0;
  await clickEl(badge);
  assert.equal(calls.filter((c) => c.endpoint === 'viewer.download').length, 0, '超限文件不应发下载请求');
  assert.ok(container.textContent.includes('downloadTooLarge'), '应出现明确的超限错误提示');
});

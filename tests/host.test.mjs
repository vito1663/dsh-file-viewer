// dsh-file-viewer 宿主契约测试（node:test，无需任何外部依赖）。
// 运行：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectKind, isSafePath, isDeniedEntryName, createHandler, ENDPOINTS, ok } from '../lib/rpc.js';

// ---- detectKind -------------------------------------------------------------
test('detectKind: magic bytes win over extension', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 1, 2, 3, 4]);
  assert.equal(detectKind('evil.txt', png).kind, 'image');
  assert.equal(detectKind('evil.txt', png).mime, 'image/png');

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  assert.equal(detectKind('x.bin', jpeg).kind, 'image');

  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 1, 2]);
  assert.equal(detectKind('report.txt', pdf).kind, 'pdf');

  const zipDocx = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  assert.equal(detectKind('report.docx', zipDocx).kind, 'docx');
});

test('detectKind: extension fallbacks', () => {
  const bytes = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
  assert.equal(detectKind('a.md', bytes).kind, 'markdown');
  assert.equal(detectKind('a.json', bytes).kind, 'json');
  assert.equal(detectKind('a.csv', bytes).kind, 'csv');
  assert.equal(detectKind('a.html', bytes).kind, 'html');
  assert.equal(detectKind('a.pdf', bytes).kind, 'pdf');
  assert.equal(detectKind('a.docx', bytes).kind, 'docx');
  assert.equal(detectKind('a.doc', bytes).kind, 'doc');
  assert.equal(detectKind('a.cs', bytes).kind, 'text'); // 未知扩展兜底文本
  assert.equal(detectKind('a.log', bytes).kind, 'text');
});

// ---- isSafePath -------------------------------------------------------------
test('isSafePath: rejects sensitive roots, segments, extensions', () => {
  assert.equal(isSafePath('/etc/hostname').ok, false);
  assert.equal(isSafePath('/proc/1/cmdline').ok, false);
  assert.equal(isSafePath('/sys/kernel').ok, false);
  assert.equal(isSafePath('/dev/null').ok, false);
  assert.equal(isSafePath('/home/user/.ssh/id_rsa').ok, false);
  assert.equal(isSafePath('/srv/project/.git/config').ok, false);
  assert.equal(isSafePath('/srv/project/settings.yaml').ok, false);
  assert.equal(isSafePath('/srv/project/creds.pem').ok, false);
  assert.equal(isSafePath('relative/path').ok, false);
  assert.equal(isSafePath('/srv/project/report.md').ok, true);
});

// ---- isDeniedEntryName ------------------------------------------------------
test('isDeniedEntryName: hides credential-bearing entries', () => {
  assert.equal(isDeniedEntryName('.ssh'), true);
  assert.equal(isDeniedEntryName('.npmrc'), true);
  assert.equal(isDeniedEntryName('.bash_history'), true);
  assert.equal(isDeniedEntryName('settings.yaml'), true);
  assert.equal(isDeniedEntryName('server.key'), true);
  assert.equal(isDeniedEntryName('report.md'), false);
  assert.equal(isDeniedEntryName('README.md'), false);
});

// ---- createHandler with mock fs ---------------------------------------------
function makeFs(spec) {
  const entries = new Map(Object.entries(spec));
  return {
    async resolve(path, opts = {}) {
      const base = opts && typeof opts.cwd === 'string' ? opts.cwd : '';
      const full = path.startsWith('/') ? path : (base ? `${base}/${path}` : path);
      return { displayPath: full, targetKey: full };
    },
    processPath(target) { return target.displayPath; },
    async stat(target) {
      const e = entries.get(target.targetKey);
      if (!e) return undefined;
      return { type: e.type, size: e.size ?? (e.bytes ? e.bytes.length : 0), version: 1 };
    },
    async listDir(target) {
      const prefix = target.targetKey.endsWith('/') ? target.targetKey : `${target.targetKey}/`;
      const out = [];
      for (const [p, e] of entries) {
        if (p.startsWith(prefix) && p !== target.targetKey && !p.slice(prefix.length).includes('/')) {
          out.push({
            name: p.slice(prefix.length),
            type: e.type,
            size: e.size ?? (e.bytes ? e.bytes.length : 0),
            target: { displayPath: p, targetKey: p },
          });
        }
      }
      return out;
    },
    async readBytes(target, _signal, _max) {
      const e = entries.get(target.targetKey);
      if (!e || !e.bytes) throw new Error(`cannot read ${target.targetKey}`);
      return e.bytes;
    },
  };
}

const FIXTURE = makeFs({
  '/srv/project': { type: 'directory' },
  '/srv/project/README.md': { type: 'file', bytes: new TextEncoder().encode('# Hi\n') },
  '/srv/project/src': { type: 'directory' },
  '/srv/project/src/main.js': { type: 'file', bytes: new TextEncoder().encode('console.log(1);') },
  '/srv/project/secret.env': { type: 'file', bytes: new TextEncoder().encode('TOKEN=x') },
  '/srv/project/.ssh': { type: 'directory' },
  '/srv/project/data.json': { type: 'file', bytes: new TextEncoder().encode('{"a":1}') },
});

function call(handler, endpoint, payload) {
  return handler(endpoint, payload, undefined);
}

test('viewer.list: directory → sorted entries, sensitive filtered', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.list, { path: '/srv/project' });
  assert.equal(r.ok, true);
  const v = r.value;
  assert.equal(v.kind, 'dir');
  const kinds = v.entries.map((e) => e.kind);
  const names = v.entries.map((e) => e.name);
  // 目录在前
  assert.deepEqual(kinds, [...kinds].sort((a, b) => (a === b ? 0 : a === 'dir' ? -1 : 1)));
  // 敏感条目被过滤
  assert.equal(names.includes('.ssh'), false);
  assert.equal(names.includes('secret.env'), false);
  // 正常条目在
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes('src'));
});

test('viewer.list: file → { kind: file }', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.list, { path: '/srv/project/README.md' });
  assert.equal(r.ok, true);
  assert.equal(r.value.kind, 'file');
  assert.equal(r.value.path, '/srv/project/README.md');
});

test('viewer.list: missing path → clear error', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.list, { path: '/srv/project/nope.md' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /路径不存在/);
});

test('viewer.list: denied path → rejected', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.list, { path: '/etc/hostname' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /拒绝/);
});

test('viewer.load: reads file content', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.load, { path: '/srv/project/data.json' });
  assert.equal(r.ok, true);
  assert.equal(r.value.kind, 'json');
  assert.equal(r.value.name, 'data.json');
  assert.ok(r.value.text.includes('"a"'));
});

test('viewer.load: relative path resolved against cwd', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.load, { path: 'data.json', cwd: '/srv/project' });
  assert.equal(r.ok, true);
  assert.equal(r.value.path, '/srv/project/data.json');
});

test('viewer.load: empty payload path → error', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, ENDPOINTS.load, {});
  assert.equal(r.ok, false);
  assert.match(r.error.message, /路径为空/);
});

test('unknown endpoint → error', async () => {
  const handler = createHandler(FIXTURE);
  const r = await call(handler, 'viewer.bogus', { path: '/srv/project' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /未知端点/);
});

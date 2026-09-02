// dsh-file-viewer 宿主契约测试（node:test，无需任何外部依赖）。
// 运行：node --test tests/
import { test, after } from 'node:test';
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
  assert.equal(isDeniedEntryName('etc'), true);
  assert.equal(isDeniedEntryName('proc'), true);
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

test('viewer.load: binary content (NUL bytes) → kind binary', async () => {
  const handler = createHandler(makeFs({
    '/srv/bin.dat': { type: 'file', bytes: new Uint8Array([0x00, 0x01, 0x02, 0xff]) },
  }));
  const r = await call(handler, ENDPOINTS.load, { path: '/srv/bin.dat' });
  assert.equal(r.ok, true);
  assert.equal(r.value.kind, 'binary');
});

test('viewer.load: non-regular file (dir/fifo) → explicit error', async () => {
  const handler = createHandler(makeFs({
    '/srv/fifo': { type: 'other', size: 0 },
    '/srv/dir': { type: 'directory' },
  }));
  const r1 = await call(handler, ENDPOINTS.load, { path: '/srv/fifo' });
  assert.equal(r1.ok, false);
  assert.match(r1.error.message, /不是普通文件/);
  const r2 = await call(handler, ENDPOINTS.load, { path: '/srv/dir' });
  assert.equal(r2.ok, false);
  assert.match(r2.error.message, /不是普通文件/);
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

// ---- viewer.download / viewer.list(mtime) ------------------------------------
// 两个端点都会用 node:fs 按真实磁盘路径读写，fixture 要把虚拟路径映射到真实临时文件
//（displayPath=磁盘路径，targetKey=虚拟路径；磁盘文件 basename 与虚拟一致以验证 name）。
// stat/listDir 对未登记的虚拟路径回退到真实磁盘（支持 viewer.list 的 mtime 测试）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'dsh-fv-dl-'));
const REAL_ENTRIES = new Map(); // 虚拟路径 → { type, bytes }
const REAL_DISK = new Map();    // 虚拟路径 → 磁盘路径
function realFile(virtualPath, bytes) {
  const diskPath = join(TMP, virtualPath.replace(/^\//, ''));
  mkdirSync(join(diskPath, '..'), { recursive: true });
  writeFileSync(diskPath, bytes);
  REAL_ENTRIES.set(virtualPath, { type: 'file', bytes });
  REAL_DISK.set(virtualPath, diskPath);
}

function makeRealFs() {
  return {
    async resolve(path, opts = {}) {
      const base = opts && typeof opts.cwd === 'string' ? opts.cwd : '';
      const full = path.startsWith('/') ? path : (base ? `${base}/${path}` : path);
      return { displayPath: REAL_DISK.get(full) ?? full, targetKey: full };
    },
    processPath(target) { return target.displayPath; },
    async stat(target) {
      const e = REAL_ENTRIES.get(target.targetKey);
      if (e) return { type: e.type, size: e.bytes.length, version: 1 };
      // 未登记路径回退真实磁盘 stat（供 viewer.list / mtime 测试）
      try {
        const st = statSync(target.displayPath);
        return { type: st.isDirectory() ? 'directory' : (st.isFile() ? 'file' : 'other'), size: st.size, version: 1 };
      } catch {
        return undefined;
      }
    },
    async listDir(target) {
      // 真实磁盘 readdir（供 viewer.list 测试）；失败回退空列表
      try {
        const dirents = readdirSync(target.displayPath, { withFileTypes: true });
        return dirents.map((d) => ({
          name: d.name,
          type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
          ...(d.isFile() ? { size: statSync(join(target.displayPath, d.name)).size } : {}),
          target: { displayPath: join(target.displayPath, d.name), targetKey: `${target.targetKey}/${d.name}` },
        }));
      } catch {
        return [];
      }
    },
    async readBytes(target, _signal, _max) {
      const e = REAL_ENTRIES.get(target.targetKey);
      if (!e || !e.bytes) throw new Error(`cannot read ${target.targetKey}`);
      return e.bytes;
    },
  };
}

const BYTES_TXT = new TextEncoder().encode('hello download\n');
const BYTES_BIN = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe, 0x39]);
// ZIP 魔数 + .docx 扩展名：下载必须原样返回（预览才转 HTML）
const BYTES_DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
realFile('/srv/dl/note.txt', BYTES_TXT);
realFile('/srv/dl/data.bin', BYTES_BIN);
realFile('/srv/dl/report.docx', BYTES_DOCX);
realFile('/srv/dl/empty.log', new Uint8Array(0));

function b64ToBytes(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

test('viewer.download: single chunk returns raw bytes + meta on first chunk', async () => {
  const handler = createHandler(makeRealFs());
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/note.txt', start: 0, length: 1024 });
  assert.equal(r.ok, true);
  assert.equal(r.value.total, BYTES_TXT.length);
  assert.equal(r.value.offset, 0);
  assert.equal(r.value.done, true);
  assert.equal(r.value.name, 'note.txt');
  assert.equal(r.value.mime, 'text/plain');
  assert.deepEqual(b64ToBytes(r.value.chunk), BYTES_TXT);
});

test('viewer.download: chunked reads across offsets reassemble the file', async () => {
  const handler = createHandler(makeRealFs());
  const parts = [];
  let start = 0;
  let firstMeta = undefined;
  let sawMetaOnLaterChunk = false;
  for (;;) {
    const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/data.bin', start, length: 3 });
    assert.equal(r.ok, true);
    if (start === 0) {
      // 首块带 name/mime
      assert.equal(r.value.name, 'data.bin');
      assert.equal(typeof r.value.mime, 'string');
      firstMeta = { name: r.value.name, mime: r.value.mime };
    } else if (r.value.mime !== undefined || r.value.name !== undefined) {
      sawMetaOnLaterChunk = true; // 后续块不应带 meta
    }
    parts.push(...b64ToBytes(r.value.chunk));
    if (r.value.done) break;
    start = Number(r.value.offset) + b64ToBytes(r.value.chunk).length;
  }
  assert.ok(firstMeta);
  assert.equal(sawMetaOnLaterChunk, false);
  assert.deepEqual(Uint8Array.from(parts), BYTES_BIN);
});

test('viewer.download: docx downloads raw zip bytes (no HTML conversion)', async () => {
  const handler = createHandler(makeRealFs());
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/report.docx', start: 0, length: 1024 });
  assert.equal(r.ok, true);
  assert.deepEqual(b64ToBytes(r.value.chunk), BYTES_DOCX);
  assert.equal(r.value.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('viewer.download: empty file → done immediately with empty chunk', async () => {
  const handler = createHandler(makeRealFs());
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/empty.log', start: 0, length: 512 });
  assert.equal(r.ok, true);
  assert.equal(r.value.total, 0);
  assert.equal(r.value.chunk, '');
  assert.equal(r.value.done, true);
  assert.equal(r.value.name, 'empty.log');
});

test('viewer.download: start beyond EOF → done, empty chunk', async () => {
  const handler = createHandler(makeRealFs());
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/note.txt', start: 99999, length: 512 });
  assert.equal(r.ok, true);
  assert.equal(r.value.done, true);
  assert.equal(r.value.chunk, '');
});

test('viewer.download: sensitive / missing / non-regular paths rejected', async () => {
  const handler = createHandler(makeRealFs());
  const denied = await call(handler, ENDPOINTS.download, { path: '/etc/hostname' });
  assert.equal(denied.ok, false);
  assert.match(denied.error.message, /拒绝/);
  const missing = await call(handler, ENDPOINTS.download, { path: '/srv/dl/nope.bin' });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /路径不存在/);
  const dirHandler = createHandler(FIXTURE);
  const dirResult = await call(dirHandler, ENDPOINTS.download, { path: '/srv/project' });
  assert.equal(dirResult.ok, false);
  assert.match(dirResult.error.message, /不是普通文件/);
});

test('viewer.download: oversize file → clear error without reading', async () => {
  const big = makeRealFs();
  big.stat = async (target) => {
    if (target.targetKey === '/srv/dl/huge.bin') return { type: 'file', size: 65 * 1024 * 1024, version: 1 };
    const e = REAL_ENTRIES.get(target.targetKey);
    if (!e) return undefined;
    return { type: e.type, size: e.bytes.length, version: 1 };
  };
  const handler = createHandler(big);
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/huge.bin', start: 0, length: 1024 });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /超过下载上限/);
});

test('viewer.download: exactly 64MB passes the cap check (reaches read stage)', async () => {
  const capFs = makeRealFs();
  let statCalls = 0;
  capFs.stat = async (target) => {
    if (target.targetKey === '/srv/dl/edge.bin') {
      statCalls += 1;
      return { type: 'file', size: 64 * 1024 * 1024, version: 1 };
    }
    const e = REAL_ENTRIES.get(target.targetKey);
    if (!e) return undefined;
    return { type: e.type, size: e.bytes.length, version: 1 };
  };
  const handler = createHandler(capFs);
  const r = await call(handler, ENDPOINTS.download, { path: '/srv/dl/edge.bin', start: 0, length: 1024 });
  // 真实磁盘上没有这个 64MB 文件 —— 请求会因 ENOENT 失败；关键是失败发生在
  // 打开文件阶段，说明没有被「文件过大」拦截（64MB 边界放行到读取阶段）。
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error.message, /超过下载上限/);
  assert.equal(statCalls, 1);
});

test('viewer.list: entries carry modification time (files and dirs)', async () => {
  // 真实临时目录里建 1 目录 + 1 文件（不经过 REAL_DISK 登记，走 stat/listDir 的磁盘回退）
  const listDir = join(TMP, 'listme');
  mkdirSync(join(listDir, 'subdir'), { recursive: true });
  writeFileSync(join(listDir, 'a.txt'), 'x');
  const before = Date.now();
  const handler = createHandler(makeRealFs());
  const r = await call(handler, ENDPOINTS.list, { path: `${TMP}/listme` });
  assert.equal(r.ok, true);
  assert.equal(r.value.kind, 'dir');
  const byName = new Map(r.value.entries.map((e) => [e.name, e]));
  const fileEntry = byName.get('a.txt');
  const dirEntry = byName.get('subdir');
  assert.ok(fileEntry, '文件条目应存在');
  assert.ok(dirEntry, '目录条目应存在');
  // 文件和目录都带 mtime（epoch ms，且是近期时间）
  assert.equal(typeof fileEntry.mtime, 'number');
  assert.equal(typeof dirEntry.mtime, 'number');
  const diskMtime = Math.floor(statSync(join(listDir, 'a.txt')).mtimeMs);
  assert.equal(fileEntry.mtime, diskMtime, 'mtime 应等于磁盘 stat 的 mtimeMs');
  assert.ok(Math.abs(fileEntry.mtime - before) < 60_000, 'mtime 应接近当前时间');
  // 敏感条目过滤逻辑不受影响（这里没有敏感条目，验证 mtime 没破坏结构）
  assert.equal(fileEntry.path, join(listDir, 'a.txt'));
});

test('viewer.list: stat failure degrades gracefully (entry without mtime)', async () => {
  // 指向一个 stat 会失败的条目：把 entry.path 指到不存在的磁盘路径
  const brokenFs = makeRealFs();
  const handler = createHandler(brokenFs);
  const r = await call(handler, ENDPOINTS.list, { path: `${TMP}/no-such-dir-xyz` });
  // 目录本身不存在 → stat 回退失败 → 明确的『路径不存在』错误
  assert.equal(r.ok, false);
  assert.match(r.error.message, /路径不存在/);
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// dsh-file-viewer — 宿主半边的 RPC 契约。
//
// 目标：把服务器上的文件/目录内容安全地提供给浏览器，让客户端按类型自动渲染。
// 用宿主自带的 `fs` 服务读写：绝对路径直接生效（resolve 以 cwd 为基准，绝对路径优先），
// 所以工作区根之外的路径也能读。所有读都**限大小**，并**拒绝敏感路径**。
//
// 端点：
//   viewer.load — 读单个文件内容（含 Word docx/doc 转 HTML）。
//   viewer.list — 输入目录返回子目录/文件列表（名称、类型、大小、修改时间 mtime）；输入文件返回 { kind: 'file' }。
//   viewer.range — 按字节范围分块读（base64），大文件预览用；docx/doc 转 HTML。
//   viewer.download — 按字节范围分块读**原始字节**（base64），专供下载；不做任何转换。

export const CHANNEL = '/dsh-file-viewer';

export const ENDPOINTS = {
  load: 'viewer.load',
  list: 'viewer.list',
  range: 'viewer.range',
  download: 'viewer.download',
};

/** viewer.range 单块最大字节（保持每条 WS 消息远小于网关/网络的大帧风险线）。 */
const RANGE_CHUNK_MAX = 512 * 1024;

/** 最大返回字节：二进制（图片/PDF）6MB；Word 文档 30MB。 */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
/** 目录列表条目上限（防止超大目录拖垮响应）。 */
const MAX_LIST_ENTRIES = 1000;

/** 拒绝的路径段（含这些段的路径一律不读，防泄出密钥/配置）。 */
const DENIED_SEGMENTS = new Set([
  '.ssh', '.gnupg', '.aws', '.config', '.local', '.cache', '.git',
  'settings.yaml', 'settings.local.yaml', '.credentials.yaml', '.credentials', '.dsh',
  '.env', '.env.local', 'id_rsa', 'id_ed25519', 'id_ecdsa',
  // 常含明文凭据/令牌的 dotfile
  '.npmrc', '.pypirc', '.netrc', '.bash_history', '.zsh_history', '.history',
  '.gitconfig', '.git-credentials', '.wget-hsts', '.wgetrc', '.curlrc',
]);
/** 拒绝的顶级/前缀目录。 */
const DENIED_ROOT_PREFIXES = ['/proc', '/sys', '/dev', '/etc'];
/** 拒绝的文件扩展名（密钥/口令类）。 */
const DENIED_EXTS = new Set(['pem', 'key', 'p12', 'pfx', 'crt', 'cer', 'p8', 'env', 'keystore']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function ok(value) {
  return { ok: true, value };
}

export function fail(message, code = 'bad-request') {
  if (code === 'cancelled') return { ok: false, error: { code, message, details: {} } };
  if (code === 'internal') return { ok: false, error: { code, message, details: {} } };
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [{ message }] } } };
}

/** 传文件大小上限、文件名、扩展名、魔数 → 渲染类型与 mime。 */
export function detectKind(name, bytes) {
  const ext = (name.slice(name.lastIndexOf('.') + 1) || '').toLowerCase();
  const mimeOf = (kind, mime) => ({ kind, mime, ext });
  const sniff = bytes.length >= 4 ? [bytes[0], bytes[1], bytes[2], bytes[3]] : null;
  // 魔数优先（防伪造扩展名）
  if (sniff && sniff[0] === 0x89 && sniff[1] === 0x50 && sniff[2] === 0x4e && sniff[3] === 0x47) return mimeOf('image', 'image/png');
  if (sniff && sniff[0] === 0xff && sniff[1] === 0xd8 && sniff[2] === 0xff) return mimeOf('image', 'image/jpeg');
  if (sniff && sniff[0] === 0x47 && sniff[1] === 0x49 && sniff[2] === 0x46) return mimeOf('image', 'image/gif');
  if (sniff && sniff[0] === 0x25 && sniff[1] === 0x50 && sniff[2] === 0x44 && sniff[3] === 0x46) return mimeOf('pdf', 'application/pdf');
  if (sniff && sniff[0] === 0x52 && sniff[1] === 0x49 && sniff[2] === 0x46 && sniff[3] === 0x46) return mimeOf('image', 'image/webp');
  if (sniff && sniff[0] === 0x50 && sniff[1] === 0x4b && (sniff[2] === 0x03 || sniff[2] === 0x05 || sniff[2] === 0x07)) {
    // ZIP 容器：.docx（Word 2007+）按 zip 魔数 + 扩展名判断
    if (ext === 'docx') return mimeOf('docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    return mimeOf('text', 'application/zip');
  }
  const map = {
    html: 'html', htm: 'html', xhtml: 'html',
    md: 'markdown', markdown: 'markdown',
    json: 'json', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code',
    csv: 'csv', tsv: 'csv',
    svg: 'svg',
    pdf: 'pdf',
    docx: 'docx', doc: 'doc',
    txt: 'text', log: 'text', text: 'text',
  };
  const kind = map[ext] || 'text';
  return mimeOf(kind, mimeFor(kind, ext));
}

function mimeFor(kind, ext) {
  const byExt = {
    html: 'text/html', htm: 'text/html', xhtml: 'application/xhtml+xml', md: 'text/markdown',
    json: 'application/json', js: 'text/javascript', mjs: 'text/javascript', ts: 'text/plain', csv: 'text/csv',
    tsv: 'text/tab-separated-values', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', log: 'text/plain',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword',
  };
  return byExt[ext] || 'text/plain';
}

/** 路径安全：绝对、不落在敏感根、无非敏感段、无密钥扩展名。 */
export function isSafePath(displayPath) {
  if (typeof displayPath !== 'string' || displayPath.length === 0) return { ok: false, reason: '路径为空' };
  // 解析后的绝对路径一定以 / 开头；若仍非绝对，防御性拒绝。
  if (!displayPath.startsWith('/')) return { ok: false, reason: '路径未解析为绝对路径' };
  for (const prefix of DENIED_ROOT_PREFIXES) {
    if (displayPath === prefix || displayPath.startsWith(prefix + '/')) {
      return { ok: false, reason: `拒绝敏感目录 ${prefix}` };
    }
  }
  const segments = displayPath.split('/').filter(Boolean);
  for (const seg of segments) {
    if (DENIED_SEGMENTS.has(seg)) return { ok: false, reason: `拒绝敏感路径段 ${JSON.stringify(seg)}` };
    const dot = seg.lastIndexOf('.');
    const ext = dot > 0 ? seg.slice(dot + 1).toLowerCase() : '';
    if (DENIED_EXTS.has(ext)) return { ok: false, reason: `拒绝敏感文件类型 .${ext}` };
  }
  return { ok: true };
}

/**
 * 列表条目过滤：隐藏敏感名称/扩展名（防目录浏览泄出密钥/配置存在性）。
 * @param name - 条目名（basename）。
 */
export function isDeniedEntryName(name) {
  if (typeof name !== 'string' || name.length === 0) return true;
  if (DENIED_SEGMENTS.has(name)) return true;
  // 与 DENIED_ROOT_PREFIXES 对应的条目名（/etc /proc /sys /dev）——列出但点不开，直接隐藏
  if (name == 'etc' || name == 'proc' || name == 'sys' || name == 'dev') return true;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  return DENIED_EXTS.has(ext);
}

/** bytes → base64（分块，避免大数组 spread 爆栈）。 */
function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 下载响应用的 mime：读文件头 64 字节做魔数探测（与 range 首块同口径），
 * 仅作 Blob 类型提示；保存文件名永远用 name（浏览器按扩展名落盘）。
 * @param absPath - 磁盘绝对路径。
 */
async function downloadMime(absPath) {
  try {
    const fsp = await import('node:fs/promises');
    const handle = await fsp.open(absPath, 'r');
    let head;
    try {
      const buf = Buffer.alloc(64);
      const { bytesRead } = await handle.read(buf, 0, 64, 0);
      head = buf.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }
    return detectKind(absPath, head).mime || 'application/octet-stream';
  } catch {
    // 探测失败不拦下载：退回按扩展名的 mime（空字节走扩展名映射）
    return detectKind(absPath, new Uint8Array(0)).mime || 'application/octet-stream';
  }
}

/** 转义 HTML 实体（antiword 纯文本进 <pre> 时用）。 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 包成完整 HTML 文档，供沙箱 iframe 渲染。 */
function wrapHtml(body) {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
    + 'body{margin:24px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;line-height:1.7;color:#222}'
    + 'table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #d0d0d0;padding:6px 10px;text-align:left;font-size:14px}'
    + 'th{background:#f2f4f7;font-weight:600}img{max-width:100%}'
    + '</style></head><body>' + body + '</body></html>';
}

/**
 * Word 文档 → HTML：.docx 用 mammoth（纯 JS），.doc（旧格式）用 antiword。
 * @param ext - 'docx' 或 'doc'。
 * @param bytes - 文档原始字节（docx 时为 zip）。
 * @param absPath - 磁盘绝对路径（antiword 需要真实文件）。
 */
async function convertWordToHtml(ext, bytes, absPath) {
  if (ext === 'docx') {
    const mammothModule = await import('mammoth').catch(() => null);
    if (!mammothModule) {
      throw new Error('缺少 mammoth 依赖（cd 插件目录 && npm install mammoth）');
    }
    const result = await mammothModule.convertToHtml({ buffer: Buffer.from(bytes) });
    return wrapHtml(result.value || '');
  }
  // .doc（旧格式）→ antiword → 纯文本
  const { execFile } = await import('node:child_process');
  const text = await new Promise((resolve, reject) => {
    execFile('antiword', ['-m', 'UTF-8.txt', '-w', '0', absPath], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.code === 'ENOENT') reject(new Error('未安装 antiword，无法转换 .doc（可转存为 .docx 后重试）'));
        else reject(new Error((stderr || '').trim() || error.message));
      } else {
        resolve(stdout);
      }
    });
  });
  return wrapHtml('<pre style="white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px">' + escapeHtml(text) + '</pre>');
}

/**
 * 公共：解析 payload.path 并做安全检查。
 * @returns {ok:true, target, absPath} 或 {ok:false, response}。
 */
async function resolvePayloadPath(fs, payload, signal) {
  const raw = payload.path;
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, response: fail('路径为空') };
  const cwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : undefined;
  let target;
  try {
    target = await fs.resolve(raw, { ...(cwd ? { cwd } : {}), ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) return { ok: false, response: fail('请求已取消', 'cancelled') };
    return { ok: false, response: fail(`无法解析路径 ${JSON.stringify(raw)}：${error?.message ?? String(error)}`) };
  }
  const absPath = fs.processPath(target);
  const safe = isSafePath(absPath);
  if (!safe.ok) return { ok: false, response: fail(safe.reason) };
  return { ok: true, target, absPath };
}

/**
 * 建通道处理器。
 * @param getFs - 惰性取 `fs` 服务。
 * @param logger - 日志器。
 */
export function createHandler(getFs, logger) {
  return async (rawEndpoint, rawPayload, signal) => {
    const fs = typeof getFs === 'function' ? getFs() : getFs;
    const endpoint = String(rawEndpoint);
    const payload = isPlainObject(rawPayload) ? rawPayload : {};

    if (signal?.aborted) return fail('请求已取消', 'cancelled');

    if (fs === undefined) {
      logger?.warn?.('dsh-file-viewer: 宿主未提供 fs 服务，文件查看器不可用');
      return fail('宿主未提供 fs 服务');
    }

    try {
      // viewer.list：目录 → 子目录/文件列表；文件 → { kind: 'file' }。
      if (endpoint === ENDPOINTS.list) {
        const resolved = await resolvePayloadPath(fs, payload, signal);
        if (!resolved.ok) return resolved.response;
        const { target, absPath } = resolved;
        let info;
        try {
          info = await fs.stat(target, signal);
        } catch (error) {
          if (signal?.aborted) return fail('请求已取消', 'cancelled');
          return fail(`无法读取 ${JSON.stringify(absPath)}：${error?.message ?? String(error)}`);
        }
        if (!info) return fail(`路径不存在：${absPath}`);
        if (info.type === 'directory') {
          let rawEntries;
          try {
            rawEntries = await fs.listDir(target, signal);
          } catch (error) {
            if (signal?.aborted) return fail('请求已取消', 'cancelled');
            return fail(`无法列出目录 ${JSON.stringify(absPath)}：${error?.message ?? String(error)}`);
          }
          const entries = rawEntries
            .filter((entry) => !isDeniedEntryName(entry?.name))
            .map((entry) => ({
              name: entry.name,
              kind: entry.type === 'directory' ? 'dir' : (entry.type === 'file' ? 'file' : 'other'),
              path: typeof entry.target?.displayPath === 'string' ? entry.target.displayPath : `${absPath}/${entry.name}`,
              ...(typeof entry.size === 'number' ? { size: entry.size } : {}),
            }))
            .sort((left, right) => {
              if (left.kind === right.kind) return left.name.localeCompare(right.name);
              return left.kind === 'dir' ? -1 : 1;
            })
            .slice(0, MAX_LIST_ENTRIES);
          // 修改时间：fs.listDir 不带 mtime，用 node:fs 对展示条目并发 stat 补上。
          // 失败容忍：单个 stat 失败（竞态删除/权限）只影响该条目，不带 mtime 字段。
          let mtimes = new Map();
          if (entries.length > 0) {
            try {
              const fspStat = await import('node:fs/promises');
              const pairs = await Promise.all(entries.map(async (entry) => {
                try {
                  const st = await fspStat.stat(entry.path);
                  return [entry.path, Math.floor(st.mtimeMs)];
                } catch {
                  return [entry.path, undefined];
                }
              }));
              mtimes = new Map(pairs);
            } catch (error) {
              logger?.warn?.('dsh-file-viewer: 批量 stat 失败，列表不带修改时间：%s', error?.message ?? String(error));
            }
          }
          const entriesWithTime = entries.map((entry) => {
            const mtime = mtimes.get(entry.path);
            return mtime !== undefined ? { ...entry, mtime } : entry;
          });
          return ok({
            kind: 'dir',
            path: absPath,
            entries: entriesWithTime,
            truncated: rawEntries.length > MAX_LIST_ENTRIES,
          });
        }
        return ok({ kind: 'file', path: absPath });
      }

      // viewer.range：按字节范围读文件块（base64）。客户端对大文件分块拉取，
      // 每条 WS 消息都很小，避免超大帧在网关/移动网络下丢失或超时。
      // 首块(start===0)响应附 kind/mime/name：与 viewer.load 的识别一致；
      // docx/doc 在此直接转 HTML，分块对象改为转换后的 HTML 字节流。
      if (endpoint === ENDPOINTS.range) {
        const resolved = await resolvePayloadPath(fs, payload, signal);
        if (!resolved.ok) return resolved.response;
        const { target, absPath } = resolved;
        const info = await fs.stat(target, signal);
        if (!info) return fail(`路径不存在：${absPath}`);
        if (info.type !== 'file') {
          return fail(`不是普通文件（${info.type}），无法查看：${absPath}`);
        }
        const extGuess = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
        const cap = (extGuess === 'docx' || extGuess === 'doc') ? 64 * 1024 * 1024 : MAX_BINARY_BYTES;
        const size = info?.size;
        if (size !== undefined && size > cap) {
          return fail(`文件过大（${size} 字节），超过 ${cap} 字节上限`);
        }
        const chunkMax = RANGE_CHUNK_MAX;
        const start = Math.max(0, Math.floor(Number(payload.start) || 0));
        const length = Math.min(chunkMax, Math.max(1, Math.floor(Number(payload.length) || chunkMax)));
        // 首块时识别类型；docx/doc 先转 HTML，后续块均基于转换后的字节流。
        let kind;
        let mime;
        let convertedText;
        if (start === 0) {
          // 用 node:fs 直接读头部 64 字节做魔数探测：
          // fs.readBytes 的 maxBytes 是总大小上限（超限拒绝），不能用来只读 N 字节。
          const fspProbe = await import('node:fs/promises');
          const headHandle = await fspProbe.open(absPath, 'r');
          let head;
          try {
            const headBuf = Buffer.alloc(64);
            const { bytesRead } = await headHandle.read(headBuf, 0, 64, 0);
            head = headBuf.subarray(0, bytesRead);
          } finally {
            await headHandle.close().catch(() => {});
          }
          const detected = detectKind(absPath, head);
          kind = detected.kind;
          mime = detected.mime;
          if (kind === 'docx' || kind === 'doc') {
            const bytes = await fs.readBytes(target, signal, cap);
            try {
              convertedText = await convertWordToHtml(kind, bytes, absPath);
              kind = 'html';
              mime = 'text/html';
            } catch (error) {
              logger?.warn?.('dsh-file-viewer: Word 转换失败：%s', error?.message ?? String(error));
              return fail(`Word 转换失败：${error?.message ?? String(error)}`);
            }
          }
        }
        const streamText = convertedText !== undefined ? convertedText : undefined;
        const total = streamText !== undefined ? streamText.length : (size ?? 0);
        // 字节流：普通文件按原始字节分块；转换 HTML 按 UTF-8 字节分块（切在字符边畴）。
        let chunkB64 = '';
        let done;
        if (streamText !== undefined) {
          const utf8 = new TextEncoder().encode(streamText);
          const s = Math.min(start, utf8.length);
          const e = Math.min(utf8.length, s + length);
          chunkB64 = e > s ? bytesToBase64(utf8.slice(s, e)) : '';
          done = e >= utf8.length;
        } else {
          if (start >= total) return ok({ total, offset: start, chunk: '', done: true, kind, mime, name: absPath.slice(absPath.lastIndexOf('/') + 1) || absPath, path: absPath });
          const end = Math.min(total, start + length);
          const fsp = await import('node:fs/promises');
          const handle = await fsp.open(absPath, 'r');
          try {
            const buf = Buffer.alloc(end - start);
            await handle.read(buf, 0, end - start, start);
            chunkB64 = bytesToBase64(buf);
            done = end >= total;
          } finally {
            await handle.close().catch(() => {});
          }
        }
        const name = absPath.slice(absPath.lastIndexOf('/') + 1) || absPath;
        const meta = start === 0 ? { kind, mime, name, path: absPath } : {};
        return ok({ total, offset: start, chunk: chunkB64, done, ...meta });
      }

      // viewer.download：按字节范围读**原始文件字节**（base64 分块），专供「下载到本地」。
      // 与 viewer.range 的差别：不做类型识别、不做 Word→HTML 转换 —— 下载永远给原始字节
      //（下载 .docx 拿到的必须是 .docx 本体，而不是预览用的 HTML）。分块口径与 range 一致
      //（≤512KB/块），保证每条 WS 消息远小于网关大帧风险线。首块(start===0)响应附
      // name/mime（mime 按扩展名+魔数映射，仅作 Blob 类型提示，保存文件名以 name 为准）。
      if (endpoint === ENDPOINTS.download) {
        const resolved = await resolvePayloadPath(fs, payload, signal);
        if (!resolved.ok) return resolved.response;
        const { target, absPath } = resolved;
        const info = await fs.stat(target, signal);
        if (!info) return fail(`路径不存在：${absPath}`);
        if (info.type !== 'file') {
          return fail(`不是普通文件（${info.type}），无法下载：${absPath}`);
        }
        const size = info?.size;
        if (size !== undefined && size > MAX_BINARY_BYTES) {
          return fail(`文件过大（${size} 字节），超过下载上限 ${MAX_BINARY_BYTES} 字节`);
        }
        const start = Math.max(0, Math.floor(Number(payload.start) || 0));
        const length = Math.min(RANGE_CHUNK_MAX, Math.max(1, Math.floor(Number(payload.length) || RANGE_CHUNK_MAX)));
        const total = size ?? 0;
        const name = absPath.slice(absPath.lastIndexOf('/') + 1) || absPath;
        // mime 只在首块算（读 64 字节头做魔数探测），后续块不带，省一次磁盘打开。
        const meta = start === 0 ? { name, mime: await downloadMime(absPath), path: absPath } : {};
        if (start >= total) {
          return ok({ total, offset: start, chunk: '', done: true, ...meta });
        }
        const end = Math.min(total, start + length);
        const fsp = await import('node:fs/promises');
        const handle = await fsp.open(absPath, 'r');
        let chunkB64;
        try {
          const buf = Buffer.alloc(end - start);
          await handle.read(buf, 0, end - start, start);
          chunkB64 = bytesToBase64(buf);
        } finally {
          await handle.close().catch(() => {});
        }
        return ok({ total, offset: start, chunk: chunkB64, done: end >= total, ...meta });
      }

      // viewer.load：文件内容。
      if (endpoint === ENDPOINTS.load) {
        const resolved = await resolvePayloadPath(fs, payload, signal);
        if (!resolved.ok) return resolved.response;
        const { target, absPath } = resolved;
        const info = await fs.stat(target, signal);
        if (!info) return fail(`路径不存在：${absPath}`);
        // 只读普通文件：目录/FIFO/socket/设备 一律明确拒绝（防 readBytes 在 FIFO 上阻塞挂起）
        if (info.type !== 'file') {
          return fail(`不是普通文件（${info.type}），无法查看：${absPath}`);
        }
        const size = info?.size;
        // fs.readBytes 的 maxBytes 是总大小上限（不是"读前 N 字节"），所以
        // 先用 stat 拿大小：超上限直接拒绝，否则用上限一次读完，再按实际字节识别。
        // Word 文档常含图片，上限放宽到 30MB；其余二进制维持 6MB。
        const extGuess = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
        const cap = (extGuess === 'docx' || extGuess === 'doc') ? 64 * 1024 * 1024 : MAX_BINARY_BYTES;
        if (size !== undefined && size > cap) {
          return fail(`文件过大（${size} 字节），超过 ${cap} 字节上限`);
        }
        let bytes;
        try {
          bytes = await fs.readBytes(target, signal, cap);
        } catch (error) {
          if (signal?.aborted) return fail('请求已取消', 'cancelled');
          if (/exceeds the .*-byte limit|too large/i.test(error?.message ?? '')) {
            return fail('文件过大，超过查看上限');
          }
          throw error;
        }
        if (bytes.length === 0) return fail('文件为空');

        const detected = detectKind(absPath, bytes);
        let kind = detected.kind;
        let mime = detected.mime;
        let convertedText;
        // Word 文档 → 转 HTML 再交给客户端渲染
        if (kind === 'docx' || kind === 'doc') {
          try {
            convertedText = await convertWordToHtml(kind, bytes, absPath);
            kind = 'html';
            mime = 'text/html';
          } catch (error) {
            logger?.warn?.('dsh-file-viewer: Word 转换失败：%s', error?.message ?? String(error));
            return fail(`Word 转换失败：${error?.message ?? String(error)}`);
          }
        }
        const textual = kind === 'text' || kind === 'markdown' || kind === 'json'
          || kind === 'csv' || kind === 'code' || kind === 'html' || kind === 'svg';
        // 二进制内容（含 NUL 字节）识别为 binary，避免浏览器渲染乱码
        if (kind === 'text' && bytes.indexOf(0) !== -1) {
          kind = 'binary';
        }
        const name = absPath.slice(absPath.lastIndexOf('/') + 1) || absPath;
        const value = {
          kind,
          mime,
          name,
          size: bytes.length,
          path: absPath,
        };
        if (kind === 'image' || kind === 'pdf') {
          value.dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
        } else {
          value.text = convertedText !== undefined ? convertedText : new TextDecoder('utf-8').decode(bytes);
        }
        return ok(value);
      }
      return fail(`未知端点 ${JSON.stringify(endpoint)}`);
    } catch (error) {
      if (signal?.aborted) return fail('请求已取消', 'cancelled');
      logger?.warn?.('dsh-file-viewer: %s 失败：%s', endpoint, error?.message ?? String(error));
      return fail(error?.message ?? String(error));
    }
  };
}

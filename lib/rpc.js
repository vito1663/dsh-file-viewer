// dsh-file-viewer — 宿主半边的 RPC 契约。
//
// 目标：把服务器上的文件/目录内容安全地提供给浏览器，让客户端按类型自动渲染。
// 用宿主自带的 `fs` 服务读写：绝对路径直接生效（resolve 以 cwd 为基准，绝对路径优先），
// 所以工作区根之外的路径也能读。所有读都**限大小**，并**拒绝敏感路径**。
//
// 端点：
//   viewer.load — 读单个文件内容（含 Word docx/doc 转 HTML）。
//   viewer.list — 输入目录返回子目录/文件列表；输入文件返回 { kind: 'file' }。

export const CHANNEL = '/dsh-file-viewer';

export const ENDPOINTS = {
  load: 'viewer.load',
  list: 'viewer.list',
};

/** 最大返回字节：文本 8MB，二进制（图片/PDF）6MB。 */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_BINARY_BYTES = 6 * 1024 * 1024;
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
    target = await fs.resolve(raw, cwd ? { cwd } : {});
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
          return ok({
            kind: 'dir',
            path: absPath,
            entries,
            truncated: rawEntries.length > MAX_LIST_ENTRIES,
          });
        }
        return ok({ kind: 'file', path: absPath });
      }

      // viewer.load：文件内容。
      if (endpoint === ENDPOINTS.load) {
        const resolved = await resolvePayloadPath(fs, payload, signal);
        if (!resolved.ok) return resolved.response;
        const { target, absPath } = resolved;
        const info = await fs.stat(target, signal);
        const size = info?.size;
        // fs.readBytes 的 maxBytes 是总大小上限（不是"读前 N 字节"），所以
        // 先用 stat 拿大小：超上限直接拒绝，否则用上限一次读完，再按实际字节识别。
        // Word 文档常含图片，上限放宽到 30MB；其余二进制维持 6MB。
        const extGuess = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
        const cap = (extGuess === 'docx' || extGuess === 'doc') ? 30 * 1024 * 1024 : MAX_BINARY_BYTES;
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
          value.base64 = bytesToBase64(bytes);
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

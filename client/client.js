// dsh-file-viewer 客户端半边（源码）。
//
// 在 dsh web 里加一个「文件查看」标签页（conversation.view 视图，位于 对话/轨迹 之后）：
// 输入服务器上的**文件**即自动识别类型并渲染；输入**目录**则展示该目录下的子目录与文件
// 列表，可点击进入子目录、点击文件直接加载渲染 —— 相当于一个服务器文件浏览器。
// 内容经插件自有的 trusted-host 通道从服务器加载，任何设备登录即可查看。
//
// 渲染类型：HTML/HTM/XHTML(沙箱 iframe)、PNG/JPEG/GIF/WEBP(图片)、SVG(沙箱)、
// Markdown(增强渲染，含表格)、JSON(美化)、CSV/TSV(表格)、PDF(iframe+新窗口)、
// Word(docx/doc 宿主端转 HTML)、文本/代码。
//
// 目录浏览：viewer.list 端点 —— 输入目录 → 面包屑 + 子目录/文件列表（含修改时间、大小）；
// 点子目录进入，点文件加载渲染，支持「上一级」与面包屑跳转；文件视图带「所在目录」返回。
//
// 下载（v7.5）：文件列表每行尾部有「⬇」下载徽章，文件视图 meta 栏有「⬇ 下载」按钮；
// 点标题/行 = 打开预览（原行为不变），点徽章/按钮 = 通过 viewer.download 分块拉原始字节
//（512KB/块，≤64MB）存为 Blob 后触发浏览器保存，带进度与失败提示。
//
// 注意：客户端产物是 __ModuleLoader__ 经典脚本，只能用 require，无 JSX/TS/import。

window.__ModuleLoader__.load({
  id: "dsh-file-viewer",
  factory: function (require) {
    var module = { exports: {} };

    var React = require("react");
    var h = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useSyncExternalStore = React.useSyncExternalStore;

    var CHANNEL = "/dsh-file-viewer";
    var NS = "dsh-file-viewer";
    var TIMEOUT_MS = 120000;
    // 下载上限：与宿主 viewer.download 的 64MB 上限一致（预览 range 同上限）。
    var DOWNLOAD_CAP = 64 * 1024 * 1024;

    var ENDPOINTS = { load: "viewer.load", list: "viewer.list", range: "viewer.range", download: "viewer.download" };

    // 全内联样式：不依赖宿主 CSS，规避 slot 注入环境里的样式隔离/覆盖。
    var S = {
      viewRoot: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "14px 16px", boxSizing: "border-box", background: "var(--dsw-alias-bg-base, #fff)" },
      viewHead: { display: "flex", alignItems: "center", gap: 8, paddingBottom: 12, borderBottom: "1px solid var(--dsw-alias-border-l2, #ddd)", flex: "none" },
      title: { marginRight: 8, fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" },
      input: { flex: 1, minWidth: 0, height: 34, padding: "0 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "var(--dsw-alias-bg-layer-1, #fff)", color: "var(--dsw-alias-label-primary, #222)", font: "inherit", fontSize: 13, boxSizing: "border-box" },
      btn: { height: 32, padding: "0 12px", borderRadius: 16, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "transparent", color: "var(--dsw-alias-label-primary, #222)", font: "inherit", fontSize: 13, flex: "none" },
      btnPrimary: { background: "var(--dsw-alias-button-primary-fill, #2563eb)", color: "var(--dsw-alias-label-primary-foreground, #fff)", borderColor: "transparent" },
      body: { flex: 1, overflow: "hidden", paddingTop: 12, minHeight: 0, display: "flex", flexDirection: "column" },
      fileWrap: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" },
      renderArea: { flex: 1, minHeight: 0, position: "relative", overflow: "auto" },
      iframeFill: { position: "absolute", inset: 0, width: "100%", height: "100%", border: 0, background: "#fff" },
      imageCenter: { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", overflow: "auto" },
      meta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", marginBottom: 8, flex: "none", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
      parentLink: { cursor: "pointer", color: "var(--dsw-alias-interactive-accent, #2563eb)", textDecoration: "underline" },
      error: { color: "var(--dsw-alias-state-error-primary, #dc2626)", fontSize: 13 },
      img: { maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
      pre: { margin: 0, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12.5, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--dsw-alias-label-primary, #222)" },
      table: { borderCollapse: "collapse", width: "100%", fontSize: 13, margin: "8px 0" },
      th: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", padding: "6px 10px", textAlign: "left", background: "rgba(0,0,0,.04)", fontWeight: 600 },
      td: { border: "1px solid var(--dsw-alias-border-l2, #ddd)", padding: "6px 10px", textAlign: "left" },
      // v7.4: 目录浏览器样式
      dirRoot: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 },

      dirPath: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4, fontSize: 13, padding: "8px 10px", background: "rgba(0,0,0,.03)", borderRadius: 8, flex: "none" },
      crumb: { cursor: "pointer", padding: "2px 4px", borderRadius: 4, color: "var(--dsw-alias-label-primary, #222)", fontWeight: 500 },
      crumbSep: { color: "var(--dsw-alias-label-tertiary, #888)" },
      upBtn: { cursor: "pointer", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "transparent", color: "var(--dsw-alias-label-secondary, #555)", fontSize: 12.5, flex: "none" },
      entryList: { display: "flex", flexDirection: "column", overflow: "auto", flex: 1, minHeight: 0 },
      entryRow: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: "7px 10px", borderRadius: 6, fontSize: 13.5, color: "var(--dsw-alias-label-primary, #222)" },
      entryName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      entrySize: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", flex: "none" },
      entryTime: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", flex: "none", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" },
      // v7.5: 下载徽章（列表行尾 + 文件视图 meta 栏共用）
      dlBadge: { flex: "none", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: "4px 9px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l2, #ddd)", background: "transparent", color: "var(--dsw-alias-label-secondary, #555)", whiteSpace: "nowrap", userSelect: "none" },
      dlBadgeBusy: { color: "var(--dsw-alias-interactive-accent, #2563eb)", borderColor: "var(--dsw-alias-interactive-accent, #2563eb)" },
      dlBadgeDim: { opacity: 0.45 },
      dirMeta: { fontSize: 12, color: "var(--dsw-alias-label-tertiary, #888)", flex: "none" },
      tailList: { display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "6px 0", fontSize: 12.5 },
      tailLabel: { color: "var(--dsw-alias-label-tertiary, #888)", marginRight: 2 },
      chip: { cursor: "pointer", padding: "2px 8px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l2, #ddd)", color: "var(--dsw-alias-label-primary, #222)", whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" },
      h3: { margin: "10px 0 4px", fontSize: 16, fontWeight: 600 },
      h4: { margin: "8px 0 4px", fontSize: 14, fontWeight: 600 },
      p: { margin: "4px 0", lineHeight: 1.6 },
      hr: { border: "none", borderTop: "1px solid var(--dsw-alias-border-l2, #ddd)", margin: "12px 0" },
      quote: { borderLeft: "3px solid var(--dsw-alias-border-l3, #ccc)", margin: "6px 0", padding: "2px 10px", color: "var(--dsw-alias-label-secondary, #555)" },
      inlineCode: { background: "rgba(0,0,0,.06)", padding: "0 3px", borderRadius: 4, fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: "0.92em" },
      codeBlock: { margin: "8px 0", fontFamily: "var(--ds-font-family-code, ui-monospace, monospace)", fontSize: 12.5, lineHeight: 1.5, whiteSpace: "pre", overflow: "auto", background: "rgba(0,0,0,.05)", padding: "10px 12px", borderRadius: 8, color: "var(--dsw-alias-label-primary, #222)" },
      link: { color: "var(--dsw-alias-interactive-accent, #2563eb)", textDecoration: "underline" },
      list: { margin: "4px 0", paddingLeft: 22 },
      li: { margin: "2px 0", lineHeight: 1.5 }
    };

    var zh = {
      view: "文件",
      title: "文件查看",
      placeholder: "输入服务器上的文件或目录路径，例如 /path/to/file.md",
      load: "打开",
      close: "关闭",
      pdfOpen: "新窗口打开",
      up: "上一级",
      parentDir: "所在目录",
      emptyDir: "（空目录）",
      truncated: "（条目过多，仅显示前 1000 个）",
      failed: "加载失败：",
      binary: "二进制文件，无法预览",
      auto: "已自动识别并渲染：",
      produced: "产物：",
      download: "下载",
      downloadFail: "下载失败：",
      downloadTooLarge: "文件超过下载上限（64MB）",
      downloadHostStale: "查看器宿主未包含下载端点，请重启 dsh web 后再试",
      mtime: "修改时间",
    };
    var en = {
      view: "Files",
      title: "File viewer",
      placeholder: "Absolute file or directory path, e.g. /path/to/file.md",
      load: "Open",
      close: "Close",
      pdfOpen: "Open in new tab",
      up: "Up",
      parentDir: "Parent dir",
      emptyDir: "(empty)",
      truncated: "(too many entries, showing first 1000)",
      failed: "Failed to load: ",
      binary: "Binary file, cannot preview",
      auto: "Auto-detected & rendered: ",
      produced: "Produced: ",
      download: "Download",
      downloadFail: "Download failed: ",
      downloadTooLarge: "File exceeds the 64MB download cap",
      downloadHostStale: "Viewer host lacks the download endpoint; restart dsh web and retry",
      mtime: "Modified",
    };

    function callChannel(rpc, endpoint, payload) {
      if (!rpc || typeof rpc.call !== "function") {
        return Promise.reject(new Error("DSH Connection RPC 不可用"));
      }
      var controller = typeof AbortController === "function" ? new AbortController() : undefined;
      var timedOut = false;
      var timer = setTimeout(function () { timedOut = true; if (controller) controller.abort(); }, TIMEOUT_MS);
      return rpc.call(CHANNEL, endpoint, payload, controller ? controller.signal : undefined)
        .catch(function (error) {
          if (timedOut) throw new Error("请求超时（" + TIMEOUT_MS + "ms）：宿主没有在时限内响应");
          if (/HTTP 404/.test((error && error.message) || "")) {
            throw new Error("找不到 " + CHANNEL + " 通道。请确认 dsh-file-viewer 宿主已加载（dsh web 重启过）。");
          }
          throw error;
        })
        .then(function (r) { clearTimeout(timer); return r; }, function (e) { clearTimeout(timer); throw e; });
    }

    // 一个极简可订阅 store：给入口与「文件查看」视图共享「待打开路径」状态，
    // 并记录每个会话"上次查看"的路径（首次进入 tab 时展示）。
    function createStore() {
      var snapshot = { open: false, path: "", cwd: undefined, session: undefined };
      var lastBySession = {};
      var listeners = new Set();
      function emit() { var s = { open: snapshot.open, path: snapshot.path, cwd: snapshot.cwd, session: snapshot.session }; listeners.forEach(function (fn) { fn(s); }); }
      return {
        getSnapshot: function () { return snapshot; },
        subscribe: function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
        open: function (path, cwd, session) { snapshot = { open: true, path: typeof path === "string" ? path : "", cwd: typeof cwd === "string" ? cwd : undefined, session: typeof session === "string" ? session : undefined }; emit(); },
        setPath: function (path) { snapshot = { open: snapshot.open, path: path, cwd: snapshot.cwd, session: snapshot.session }; emit(); },
        remember: function (session, path) { if (typeof session === "string" && session.length > 0 && typeof path === "string" && path.length > 0) lastBySession[session] = path; },
        lastOf: function (session) { return typeof session === "string" && session.length > 0 ? lastBySession[session] : undefined; },
      };
    }

    // 模块级共享 store 与本地化（标签页 / 产物芯片共用，无法经 slot inject 传入）。
    var viewerStore = createStore();
    var __t = function (k) { return k; };

    // 安全：markdown 链接 href 白名单（防 javascript:/data:/vbscript: 注入）。
    function safeHref(href) {
      var h = String(href).trim();
      if (h === "") return undefined;
      // 无 scheme（相对路径 / 纯锚点）放行
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(h)) return h;
      // 只允许常见安全 scheme
      if (/^(https?|mailto):/i.test(h)) return h;
      return undefined;
    }

    function formatSize(n) {
      if (n === undefined) return "";
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
      if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
      return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }

    // 修改时间 → "YYYY-MM-DD HH:mm"（本地时区，tabular-nums 对齐）。
    function formatTime(ms) {
      var n = Number(ms);
      if (ms === undefined || ms === null || !Number.isFinite(n) || n <= 0) return "";
      var d = new Date(n);
      var p = function (x) { return (x < 10 ? "0" : "") + x; };
      return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    }

    // 增强版 Markdown 渲染（标题 1-6 / 围栏代码 / 列表 / 引用 / 分隔线 / 表格 / 行内样式）。
    function renderMarkdown(text) {
      var lines = String(text).split("\n");
      var nodes = [];
      var inCode = false;
      var codeLines = [];
      var inList = false;
      var listNodes = [];
      function flushList() {
        if (inList) {
          nodes.push(h("ul", { key: "list" + nodes.length, style: S.list }, listNodes));
          inList = false;
          listNodes = [];
        }
      }
      function isTableSeparator(line) {
        var t = String(line).trim();
        // GFM 表格分隔行必须含 |（纯 --- 是 setext 标题，不是表格）
        return t.indexOf("|") !== -1 && /^[\s:|-]+$/.test(t) && /-/.test(t);
      }
      function renderTable(lines, start) {
        var rows = [];
        var i = start;
        while (i < lines.length) {
          var t = String(lines[i]).trim();
          if (t === "" || t.indexOf("|") === -1) break;
          if (t.charAt(0) === "|") t = t.slice(1);
          if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
          rows.push(t.split("|").map(function (c) { return c.trim(); }));
          i++;
        }
        if (rows.length < 2) return null;
        var header = rows[0];
        var body = rows.slice(2);
        return {
          node: h("table", { style: S.table },
            h("thead", null, h("tr", null, header.map(function (c, ci) { return h("th", { key: ci, style: S.th }, inline(c)); }))),
            h("tbody", null, body.map(function (r, ri) {
              return h("tr", { key: ri }, r.map(function (c, ci) { return h("td", { key: ci, style: S.td }, inline(c)); }));
            }))
          ),
          nextIndex: i
        };
      }
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (/^```/.test(line)) {
          flushList();
          if (inCode) {
            nodes.push(h("pre", { key: i, style: S.codeBlock }, codeLines.join("\n")));
            inCode = false;
            codeLines = [];
          } else {
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        var trimmed = line.trim();
        if (trimmed === "") {
          flushList();
          nodes.push(h("div", { key: i, style: { height: 8 } }));
          continue;
        }
        // 表格：当前行含 | 且下一行是分隔线
        if (line.indexOf("|") !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
          var table = renderTable(lines, i);
          if (table) {
            flushList();
            nodes.push(table.node);
            i = table.nextIndex - 1;
            continue;
          }
        }
        var m;
        if ((m = /^######\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h6", { key: i, style: S.h4 }, inline(m[1]))); continue; }
        if ((m = /^#####\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h5", { key: i, style: S.h4 }, inline(m[1]))); continue; }
        if ((m = /^####\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h4", { key: i, style: S.h4 }, inline(m[1]))); continue; }
        if ((m = /^###\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h3", { key: i, style: S.h3 }, inline(m[1]))); continue; }
        if ((m = /^##\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h4", { key: i, style: S.h4 }, inline(m[1]))); continue; }
        if ((m = /^#\s+(.*)/.exec(trimmed))) { flushList(); nodes.push(h("h3", { key: i, style: S.h3 }, inline(m[1]))); continue; }
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushList(); nodes.push(h("hr", { key: i, style: S.hr })); continue; }
        if ((m = /^>\s?(.*)/.exec(trimmed))) { flushList(); nodes.push(h("blockquote", { key: i, style: S.quote }, inline(m[1]))); continue; }
        if ((m = /^[-*+]\s+(.*)/.exec(trimmed))) {
          inList = true;
          listNodes.push(h("li", { key: listNodes.length, style: S.li }, inline(m[1])));
          continue;
        }
        if ((m = /^\d+[.)]\s+(.*)/.exec(trimmed))) {
          inList = true;
          listNodes.push(h("li", { key: listNodes.length, style: S.li }, inline(m[1])));
          continue;
        }
        flushList();
        nodes.push(h("p", { key: i, style: S.p }, inline(line)));
      }
      if (inCode) nodes.push(h("pre", { key: "code-last", style: S.codeBlock }, codeLines.join("\n")));
      flushList();
      return h("div", null, nodes);
      function inline(s) {
        var parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
        var out = [];
        for (var j = 0; j < parts.length; j++) {
          var p = parts[j];
          if (!p) continue;
          if (p.startsWith("`") && p.endsWith("`")) out.push(h("code", { key: j, style: S.inlineCode }, p.slice(1, -1)));
          else if (p.startsWith("**") && p.endsWith("**")) out.push(h("strong", { key: j }, inline(p.slice(2, -2))));
          else if (p.startsWith("__") && p.endsWith("__")) out.push(h("strong", { key: j }, inline(p.slice(2, -2))));
          else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) out.push(h("em", { key: j }, inline(p.slice(1, -1))));
          else if (p.startsWith("[") && p.endsWith(")")) {
            var linkMatch = /^\[([^\]]+)\]\(([^)]+)\)/.exec(p);
            var safe = linkMatch ? safeHref(linkMatch[2]) : undefined;
            if (linkMatch && safe !== undefined) out.push(h("a", { key: j, href: safe, target: "_blank", rel: "noreferrer", style: S.link }, linkMatch[1]));
            else out.push(linkMatch ? linkMatch[0] : p);
          } else out.push(p);
        }
        return out;
      }
    }

    function renderCsv(text) {
      var rows = String(text).split("\n").filter(function (r) { return r.length > 0; })
        .map(function (r) { return r.split(","); });
      if (rows.length === 0) return h("p", null, "");
      var head = rows[0], body = rows.slice(1);
      return h("table", { style: S.table },
        h("thead", null, h("tr", null, head.map(function (c, i) { return h("th", { key: i }, c.trim()); }))),
        h("tbody", null, body.map(function (r, i) {
          return h("tr", { key: i }, r.map(function (c, j) { return h("td", { style: S.td, key: j }, c.trim()); }));
        }))
      );
    }

    function renderBody(file, t) {
      if (file.kind === "html" || file.kind === "svg") {
        return h("iframe", { style: S.iframeFill, sandbox: "", srcDoc: file.text || "", title: file.name });
      }
      if (file.kind === "image") {
        return h("div", { style: S.imageCenter }, h("img", { style: S.img, src: file.dataUrl, alt: file.name }));
      }
      if (file.kind === "pdf") {
        return h("iframe", { style: S.iframeFill, src: file.dataUrl, title: file.name });
      }
      if (file.kind === "binary") {
        return h("p", { style: S.meta }, t("binary") + " · " + formatSize(file.size));
      }
      if (file.kind === "markdown") return renderMarkdown(file.text);
      if (file.kind === "json") {
        var pretty = file.text;
        try { pretty = JSON.stringify(JSON.parse(file.text), null, 2); } catch (e) { /* keep raw */ }
        return h("pre", { style: S.pre }, pretty);
      }
      if (file.kind === "csv") return renderCsv(file.text);
      return h("pre", { style: S.pre }, file.text);
    }

    // v7.5: 下载徽章（文件列表行尾 / 文件视图 meta 栏共用）。
    // 点击/回车只触发下载（stopPropagation），行与标题的「打开预览」行为不受影响。
    // 超过 DOWNLOAD_CAP 的文件徽章置灰，点击后由 downloadFile 给出明确错误提示。
    function downloadBadge(opts) {
      var path = opts.path;
      var name = opts.name;
      var size = opts.size;
      var dl = opts.dl;
      var onDownload = opts.onDownload;
      var t = opts.t;
      var withLabel = opts.withLabel === true;
      var active = dl !== undefined && dl.path === path;
      var tooLarge = typeof size === "number" && size > DOWNLOAD_CAP;
      var style = Object.assign({}, S.dlBadge,
        active ? S.dlBadgeBusy : undefined,
        tooLarge && !active ? S.dlBadgeDim : undefined);
      var text = withLabel ? "⬇ " + t("download") : "⬇";
      if (active) text = dl.total > 0 ? "⬇ " + Math.min(100, Math.round((dl.received / dl.total) * 100)) + "%" : "⬇ …";
      var fire = function (ev) {
        if (ev) { ev.stopPropagation(); ev.preventDefault(); }
        onDownload(path, name, size);
      };
      return h("span", {
        role: "button", tabIndex: 0, style: style,
        title: (tooLarge ? t("downloadTooLarge") + " · " : t("download") + " ") + name,
        onClick: fire,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") fire(ev); }
      }, text);
    }

    // v7.4: 目录浏览器（面包屑 + 子目录/文件列表；文件行尾带下载徽章）。
    function renderDirBrowser(dir, open, t, dl, onDownload) {
      var segs = String(dir.path).split("/").filter(Boolean);
      var parentPath = dir.path === "/" ? null : (String(dir.path).slice(0, String(dir.path).lastIndexOf("/")) || "/");
      var dirCount = 0, fileCount = 0;
      for (var i = 0; i < dir.entries.length; i++) {
        if (dir.entries[i].kind === "dir") dirCount++;
        else fileCount++;
      }
      return h("div", { style: S.dirRoot },
        h("div", { style: S.dirPath },
          parentPath !== null
            ? h("button", { style: S.upBtn, type: "button", onClick: function () { open(parentPath); } }, "⬆ " + t("up"))
            : null,
          h("span", { style: S.crumbSep }, "/"),
          segs.map(function (seg, i) {
            var p = "/" + segs.slice(0, i + 1).join("/");
            var crumb = h("span", { key: i, style: S.crumb, onClick: function () { open(p); } }, seg);
            var sep = i < segs.length - 1 ? h("span", { key: "s" + i, style: S.crumbSep }, "/") : null;
            return [crumb, sep];
          }),
          h("span", { style: Object.assign({}, S.dirMeta, { marginLeft: "auto" }) },
            dirCount + " 个目录 · " + fileCount + " 个文件" + (dir.truncated ? t("truncated") : ""))
        ),
        dir.entries.length === 0
          ? h("p", { style: S.dirMeta }, t("emptyDir"))
          : h("div", { style: S.entryList },
            dir.entries.map(function (e) {
              var icon = e.kind === "dir" ? "📁 " : (e.kind === "file" ? "📄 " : "❔ ");
              return h("div", {
                key: e.path, role: "button", tabIndex: 0, title: e.path, style: S.entryRow,
                onClick: function () { open(e.path); },
                onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(e.path); } }
              },
                h("span", { style: S.entryName }, icon + e.name),
                e.mtime !== undefined ? h("span", { style: S.entryTime, title: t("mtime") }, formatTime(e.mtime)) : null,
                e.kind === "file" && e.size !== undefined ? h("span", { style: S.entrySize }, formatSize(e.size)) : null,
                e.kind === "file" ? downloadBadge({ path: e.path, name: e.name, size: e.size, dl: dl, onDownload: onDownload, t: t }) : null
              );
            })
          )
      );
    }

    // 回合产物芯片行：点击路径 → 走官方 openFile（切到「文件查看」tab 并渲染），
    // 兜底才直接用 viewerStore。
    function ProducedFilesTail(props) {
      var paths = props.matched || [];
      if (!Array.isArray(paths) || paths.length === 0) return null;
      var sess = typeof props.useSession === "function" ? props.useSession() : undefined;
      var sessionId = sess && typeof sess.sessionId === "string" ? sess.sessionId : undefined;
      var cwd;
      if (typeof props.useSessions === "function" && sessionId !== undefined) {
        cwd = props.useSessions(function (st) {
          return st && typeof st.byId === "object" && st.byId[sessionId] ? st.byId[sessionId].cwd : undefined;
        });
      }
      var openPath = function (p) {
        if (typeof props.openFile === "function") {
          props.openFile(p);
        } else {
          viewerStore.open(p, typeof cwd === "string" ? cwd : undefined, sessionId);
        }
      };
      return h("div", { style: S.tailList },
        h("span", { style: S.tailLabel }, __t("produced")),
        paths.map(function (p) {
          var name = String(p).split("/").pop() || p;
          return h("span", {
            key: p, role: "button", tabIndex: 0, title: p, style: S.chip,
            onClick: function () { openPath(p); },
            onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPath(p); } }
          }, name);
        })
      );
    }

    // 「文件查看」标签页视图：目录浏览器 + 文件渲染。
    function FileViewerView(props) {
      var t = props.t;
      var sessionId = typeof props.sessionId === "string" ? props.sessionId : undefined;
      var snapshot = useSyncExternalStore(props.store.subscribe, props.store.getSnapshot);
      var pendingOpen = snapshot.open;
      var initialPath = snapshot.path || "";
      var cwd = snapshot.cwd;
      // 会话级 cwd（首次进入 tab 时默认展示工作区目录）
      var sessionCwd;
      if (typeof props.useSessions === "function" && sessionId !== undefined) {
        sessionCwd = props.useSessions(function (st) {
          return st && typeof st.byId === "object" && st.byId[sessionId] ? st.byId[sessionId].cwd : undefined;
        });
      }
      var pathState = useState(initialPath);
      var path = pathState[0], setPath = pathState[1];
      var dirState = useState(undefined);
      var dir = dirState[0], setDir = dirState[1];
      var fileState = useState(undefined);
      var file = fileState[0], setFile = fileState[1];
      var errState = useState(undefined);
      var error = errState[0], setError = errState[1];
      var busyState = useState(false);
      var busy = busyState[0], setBusy = busyState[1];
      // 下载状态：{ path, received, total } —— 徽章显示进度；undefined = 空闲。
      var dlState = useState(undefined);
      var dl = dlState[0], setDl = dlState[1];
      // 下载序号：新下载会让旧下载链在各块返回后静默退出（防两个下载互相覆盖进度）。
      var dlSeqRef = React.useRef(0);
      var inputRef = React.useRef(null);
      // 请求序号：快速连续打开时丢弃过期响应（防慢响应覆盖新结果）。
      var reqIdRef = React.useRef(0);
      // 挂载首帧标记：首帧由 mount effect 决定展示内容，后续 store 变更才走 deps effect。
      var pendingOpenRef = React.useRef(null);
      var mountedRef = React.useRef(false);

      // 分块拉取：每条 WS 消息 ≤ ~700KB（512KB 原始字节 ≈ 683KB base64），
      // 避免超大帧在 Cloudflare/网关/移动网络下丢失导致 25s 请求超时。
      var CHUNK_BYTES = 512 * 1024;
      function loadFileChunked(absPath, myId) {
        var payload0 = { path: absPath, start: 0, length: CHUNK_BYTES };
        return props.rpcCall(ENDPOINTS.range, payload0).then(function (first) {
          if (!first.ok) { setError(t("failed") + first.error.message); return; }
          var v0 = first.value;
          var kind = v0.kind;
          var mime = v0.mime || "text/plain";
          var name = v0.name || absPath.slice(absPath.lastIndexOf("/") + 1) || absPath;
          var total = Number(v0.total) || 0;
          // 首块已含全部 → base64 一次解码
          // 每块独立 atob 解码为字节（各块 base64 自带 padding，不能先 join 后解码）。
          var b64ToBytes = function (b64) {
            var bin = atob(b64);
            var out = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
            return out;
          };
          var parts = [b64ToBytes(v0.chunk)];
          // 下一块偏移：用服务端回报的 offset + 实际字节数，不用 base64 长度估算（避免偏移错位）。
          var bytesOf = function (b64) { var pad = b64.length >= 2 && b64[b64.length - 1] === "=" ? (b64[b64.length - 2] === "=" ? 2 : 1) : 0; return b64.length * 3 / 4 - pad; };
          var nextStart = (Number(v0.offset) || 0) + bytesOf(v0.chunk);
          // 递归串行拉块：每块拿到响应后再发下一块（避免同步循环预调度造成重复请求）。
          var pull = function (start) {
            if (start >= total) return Promise.resolve();
            return props.rpcCall(ENDPOINTS.range, { path: absPath, start: start, length: CHUNK_BYTES }).then(function (r) {
              // 拉块中途不因 reqId 变化而中断（避免链被新 open 打断后前半段无声死）；
              // 最终 setFile 前再检查 reqId，只有最后一次 open 能上屏。
              if (!r.ok) { setError(t("failed") + r.error.message); return; }
              parts.push(b64ToBytes(r.value.chunk));
              if (r.value.done) return Promise.resolve();
              var adv = (Number(r.value.offset) || start) + bytesOf(r.value.chunk);
              if (adv <= start) return Promise.resolve(); // 防卡死：偏移不前进就停
              return pull(adv);
            });
          };
          var chain = pull(nextStart);
          return chain.then(function () {
            if (reqIdRef.current !== myId) return;
            // 合并各块字节为单一 Uint8Array
            var grand = 0;
            for (var gi = 0; gi < parts.length; gi += 1) grand += parts[gi].length;
            var bytes = new Uint8Array(grand);
            var off = 0;
            for (var pi = 0; pi < parts.length; pi += 1) { bytes.set(parts[pi], off); off += parts[pi].length; }
            var textual = kind === "text" || kind === "markdown" || kind === "json"
              || kind === "csv" || kind === "code" || kind === "html" || kind === "svg";
            var value = { kind: kind, mime: mime, name: name, size: total, path: v0.path || absPath };
            if (kind === "image" || kind === "pdf") {
              value.dataUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
            } else if (textual) {
              var text = new TextDecoder("utf-8").decode(bytes);
              if (kind === "text" && text.indexOf("\u0000") !== -1) { value.kind = "binary"; }
              else { value.text = text; }
              if (value.kind === "binary") { value.text = undefined; }
            } else {
              value.text = new TextDecoder("utf-8").decode(bytes);
            }
            setFile(value);
            props.store.remember(sessionId, absPath);
          }, function (e) {
            if (myId !== undefined && reqIdRef.current !== myId) return;
            setError(t("failed") + (e && e.message ? e.message : String(e)));
          });
        }, function (e) {
          if (myId !== undefined && reqIdRef.current !== myId) return;
          setError(t("failed") + (e && e.message ? e.message : String(e)));
        });
      }

      function loadFile(absPath, myId) {
        setFile(undefined); setDir(undefined);
        // 大文件改走分块拉取（先发一个首块请求拿 total/kind；首块数据也复用，不浪费）
        return props.rpcCall(ENDPOINTS.range, { path: absPath, start: 0, length: CHUNK_BYTES }).then(function (probe) {
          if (!probe.ok) {
            // 服务端无 range 端点（未重启）：回退单次 load。
            return props.rpcCall(ENDPOINTS.load, { path: absPath }).then(function (result) {
              if (myId !== undefined && reqIdRef.current !== myId) return;
              if (!result.ok) { setError(t("failed") + result.error.message); return; }
              setFile(result.value);
              props.store.remember(sessionId, absPath);
            }, function (e) {
              if (myId !== undefined && reqIdRef.current !== myId) return;
              setError(t("failed") + (e && e.message ? e.message : String(e)));
            });
          }
          var total = Number(probe.value.total) || 0;
          if (total > CHUNK_BYTES) {
            // 丢弃首块（loadFileChunked 会重新拉首块；为简洁牺牲一次重复传输）
            return loadFileChunked(absPath, myId);
          }
          if (total <= CHUNK_BYTES && probe.value.done) {
            // 首块即全量：直接构造渲染值，免去第二次 load 请求
            var v0 = probe.value;
            var bin = atob(v0.chunk);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var textual = v0.kind === "text" || v0.kind === "markdown" || v0.kind === "json"
              || v0.kind === "csv" || v0.kind === "code" || v0.kind === "html" || v0.kind === "svg";
            var value = { kind: v0.kind, mime: v0.mime || "text/plain", name: v0.name, size: total, path: v0.path || absPath };
            if (v0.kind === "image" || v0.kind === "pdf") {
              value.dataUrl = "data:" + (v0.mime || "application/octet-stream") + ";base64," + v0.chunk;
            } else if (textual) {
              var text = new TextDecoder("utf-8").decode(bytes);
              if (v0.kind === "text" && text.indexOf("\u0000") !== -1) { value.kind = "binary"; }
              else { value.text = text; }
            } else {
              value.text = new TextDecoder("utf-8").decode(bytes);
            }
            setFile(value);
            props.store.remember(sessionId, absPath);
            return;
          }
          return props.rpcCall(ENDPOINTS.load, { path: absPath }).then(function (result) {
            if (myId !== undefined && reqIdRef.current !== myId) return;
            if (!result.ok) { setError(t("failed") + result.error.message); return; }
            setFile(result.value);
            // 记录本会话上次查看的文件
            props.store.remember(sessionId, absPath);
          }, function (e) {
            if (myId !== undefined && reqIdRef.current !== myId) return;
            setError(t("failed") + (e && e.message ? e.message : String(e)));
          });
        }, function (e) {
          if (myId !== undefined && reqIdRef.current !== myId) return;
          setError(t("failed") + (e && e.message ? e.message : String(e)));
        });
      }

      // v7.5 下载：viewer.download 分块拉**原始字节** → Blob → <a download> 触发保存。
      // 列表标题/行点击仍是打开预览；只有下载徽章走这里（徽章已 stopPropagation）。
      // 进度经 dl state 回填到徽章（⬇ N%）；knownSize 超上限时直接给出提示不发请求。
      function downloadFile(absPath, fallbackName, knownSize) {
        if (!absPath) return;
        if (typeof knownSize === "number" && knownSize > DOWNLOAD_CAP) {
          setError(t("downloadTooLarge") + " · " + formatSize(knownSize));
          return;
        }
        var mySeq = ++dlSeqRef.current;
        var stale = function () { return dlSeqRef.current !== mySeq; };
        var failDl = function (msg) {
          if (stale()) return;
          setDl(undefined);
          setError(t("downloadFail") + msg);
        };
        setDl({ path: absPath, received: 0, total: 0 });
        var b64ToBytes = function (b64) {
          var bin = atob(b64);
          var out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
          return out;
        };
        var bytesOf = function (b64) { var pad = b64.length >= 2 && b64[b64.length - 1] === "=" ? (b64[b64.length - 2] === "=" ? 2 : 1) : 0; return b64.length * 3 / 4 - pad; };
        var parts = [];
        var received = 0;
        var finish = function (mime, name, total) {
          if (stale()) return;
          setDl({ path: absPath, received: total, total: total });
          try {
            var blob = new Blob(parts, { type: mime || "application/octet-stream" });
            var url = URL.createObjectURL(blob);
            var a = document.createElement("a");
            a.href = url;
            a.download = name || fallbackName || absPath.slice(absPath.lastIndexOf("/") + 1) || absPath;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
          } catch (e) {
            failDl(e && e.message ? e.message : String(e));
            return;
          }
          setDl(undefined);
        };
        var pull = function (start, total) {
          if (stale()) return;
          props.rpcCall(ENDPOINTS.download, { path: absPath, start: start, length: CHUNK_BYTES }).then(function (r) {
            if (stale()) return;
            if (!r.ok) { failDl(r.error && r.error.message ? r.error.message : String(r.error)); return; }
            var v = r.value;
            var tot = Number(v.total) || total;
            if (v.chunk) {
              parts.push(b64ToBytes(v.chunk));
              received += bytesOf(v.chunk);
              setDl({ path: absPath, received: received, total: tot });
            }
            if (v.done) { finish(v.mime, v.name, tot); return; }
            var adv = (Number(v.offset) || start) + (v.chunk ? bytesOf(v.chunk) : 0);
            if (adv <= start) { failDl("下载停滞（偏移未前进），已中止"); return; }
            pull(adv, tot);
          }, function (e) { failDl(e && e.message ? e.message : String(e)); });
        };
        props.rpcCall(ENDPOINTS.download, { path: absPath, start: 0, length: CHUNK_BYTES }).then(function (first) {
          if (stale()) return;
          if (!first.ok) {
            var msg = first.error && first.error.message ? first.error.message : String(first.error);
            // 旧宿主（未重启）没有 download 端点：给出可操作的提示
            if (/未知端点/.test(msg)) { failDl(t("downloadHostStale")); return; }
            failDl(msg);
            return;
          }
          var v0 = first.value;
          var total = Number(v0.total) || 0;
          if (v0.chunk) {
            parts.push(b64ToBytes(v0.chunk));
            received += bytesOf(v0.chunk);
            setDl({ path: absPath, received: received, total: total });
          }
          if (v0.done) { finish(v0.mime, v0.name, total); return; }
          pull((Number(v0.offset) || 0) + (v0.chunk ? bytesOf(v0.chunk) : 0), total);
        }, function (e) { failDl(e && e.message ? e.message : String(e)); });
      }

      // 统一打开：viewer.list 判断目录/文件。
      function open(target) {
        var tgt = (target !== undefined ? target : (inputRef.current ? String(inputRef.current.value || "").trim() : path.trim()));
        if (!tgt) return;
        var myId = ++reqIdRef.current;
        setBusy(true); setError(undefined);
        var reqPayload = { path: tgt };
        if (typeof cwd === "string" && cwd.length > 0) reqPayload.cwd = cwd;
        var settle = function () { if (reqIdRef.current === myId) setBusy(false); };
        props.rpcCall(ENDPOINTS.list, reqPayload).then(function (result) {
          if (reqIdRef.current !== myId) return;
          if (!result.ok) { setError(t("failed") + result.error.message); return; }
          var v = result.value;
          if (v.kind === "dir") {
            setDir(v);
            setFile(undefined);
            setPath(v.path);
            // 记录本会话上次查看的目录
            props.store.remember(sessionId, v.path);
          } else {
            // 文件 → 走 load 渲染（loadFile 的 promise 并入 busy 状态）
            setPath(v.path || tgt);
            return loadFile(v.path || tgt, myId);
          }
        }, function (e) {
          if (reqIdRef.current !== myId) return;
          setError(t("failed") + (e && e.message ? e.message : String(e)));
        }).then(settle, settle);
      }

      // 同步输入框：store 传入的待打开路径变化时更新。
      useEffect(function () {
        if (initialPath) setPath(initialPath);
      }, [initialPath]);
      // 有待打开路径（且属于本会话或未标记会话）时自动打开。
      // 跳过挂载首帧：首帧展示内容统一由 mount effect 决定（记忆 > 待打开 > 工作区）。
      useEffect(function () {
        if (!mountedRef.current) return;
        // 挂载首帧已由 mount effect 处理 pendingOpen，这里只响应【后续】新的点击：
        // 用一个已消费标记避免首帧重复 open（防双链拉块）。
        if (pendingOpenRef.current === initialPath + "\u0000" + (snapshot.session || "")) return;
        pendingOpenRef.current = initialPath + "\u0000" + (snapshot.session || "");
        if (pendingOpen && initialPath && (snapshot.session === undefined || snapshot.session === sessionId)) {
          open(initialPath);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pendingOpen, initialPath, snapshot.session]);
      // 挂载（点进 tab）时的展示优先级：
      //   1) 本会话上次查看的文件/目录（记忆）——避免陈旧 store 路径覆盖最近查看；
      //   2) 本会话待打开路径（芯片/文件链接刚触发，且无历史记忆）；
      //   3) 本会话工作区目录（首次进入）。
      useEffect(function () {
        if (mountedRef.current) return;
        mountedRef.current = true;
        var last = props.store.lastOf(sessionId);
        // 用户刚点的文件（pendingOpen）优先于历史记忆（lastOf），避免双 open 竞争：
        if (pendingOpen && initialPath && (snapshot.session === undefined || snapshot.session === sessionId)) {
          setPath(initialPath);
          open(initialPath);
        } else if (typeof last === "string" && last.length > 0) {
          setPath(last);
          open(last);
        } else if (typeof sessionCwd === "string" && sessionCwd.length > 0) {
          setPath(sessionCwd);
          open(sessionCwd);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      var fileParent = file && file.path ? (String(file.path).slice(0, String(file.path).lastIndexOf("/")) || "/") : undefined;

      return h("div", { style: S.viewRoot },
        h("div", { style: S.viewHead },
          h("strong", { style: S.title }, t("title")),
          h("input", {
            ref: inputRef, style: S.input, value: path, placeholder: t("placeholder"),
            autoFocus: true, spellCheck: false,
            onChange: function (e) { setPath(e.target.value); },
            onKeyDown: function (e) { if (e.key === "Enter") open(); }
          }),
          h("button", { style: Object.assign({}, S.btn, S.btnPrimary), disabled: busy, onClick: function () { open(); } },
            busy ? "…" : t("load")),
          file !== undefined && file.kind === "pdf"
            ? h("button", { style: S.btn, title: t("pdfOpen"), onClick: function () { if (file.dataUrl) window.open(file.dataUrl, "_blank"); } }, t("pdfOpen"))
            : null
        ),
        h("div", { style: S.body },
          error !== undefined ? h("p", { style: S.error }, error) : null,
          dir !== undefined
            ? renderDirBrowser(dir, open, t, dl, function (p, n, s) { downloadFile(p, n, s); })
            : (file !== undefined
              ? h("div", { style: S.fileWrap },
                h("div", { style: S.meta },
                  h("span", null, t("auto") + file.kind + " · " + file.name + " · " + formatSize(file.size)),
                  fileParent !== undefined
                    ? h("span", { style: S.parentLink, role: "button", tabIndex: 0, title: fileParent,
                        onClick: function () { open(fileParent); },
                        onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(fileParent); } } },
                      "⬅ " + t("parentDir"))
                    : null,
                  file.path !== undefined
                    ? downloadBadge({ path: file.path, name: file.name, size: file.size, dl: dl, onDownload: downloadFile, t: t, withLabel: true })
                    : null
                ),
                h("div", { style: S.renderArea }, renderBody(file, t)))
              : (!busy ? h("p", { style: S.meta }, t("placeholder")) : null))
        )
      );
    }

    var name = "dsh-file-viewer";
    var inject = ["slots", "connection", "locale"];

    function apply(ctx) {
      var rpcCall = function (endpoint, payload) { return callChannel(ctx.connection.rpc, endpoint, payload); };
      var translate = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-file-viewer: locale");
      __t = translate;
      // 注册「文件查看」标签页（conversation.view 视图，order 20 位于 对话/轨迹 之后）。
      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "file-viewer",
          order: 20,
          locale: NS,
          label: function () { return translate("view"); },
          inject: function () { return { store: viewerStore, rpcCall: rpcCall }; }
        }, FileViewerView);
      });
      // 回合产物核对：把产出文件渲染成可点击芯片（点击 → openFile → 切到文件查看 tab）。
      ctx.slots.inject("conversation.chat.turnTail", function () {
        return ctx.slots.register(
          {
            name: "conversation.chat.turnTail",
            priority: -10,
            select: function (owner) {
              var data = owner && owner.turn && owner.turn.data ? owner.turn.data.get("deliverables") : undefined;
              if (!data || !Array.isArray(data.produced)) return null;
              var paths = []; var seen = {};
              var seq = owner.seq;
              for (var i = 0; i < data.produced.length; i++) {
                var p = data.produced[i];
                if (!p || typeof p.path !== "string" || p.path.length === 0) continue;
                if (seq !== undefined && p.seq !== undefined && p.seq > seq) continue;
                if (seen[p.path]) continue;
                seen[p.path] = true; paths.push(p.path);
              }
              return paths.length ? paths : null;
            }
          },
          ProducedFilesTail
        );
      });
      // 官方对话 UI 的 openFile（产物芯片 / 消息内文件路径）在无头服务器上走
      // xdg-open 必败；暴露全局钩子，让官方 UI 把它路由进本查看器并切换标签页。
      if (typeof window !== "undefined") {
        window.__dshFileViewerOpen = function (path, session) {
          viewerStore.open(typeof path === "string" ? path : "", undefined, typeof session === "string" ? session : undefined);
          // 无头服务器：官方 openFile 被路由到这里后，还需要把 conversation.view
          // 切到本插件标签页内容才可见。alpha.2 的 openFile 注入点拿不到
          // conversation store 的 setView，这里退而点击标签栏上的「文件」按钮
          // （role=tab，文案与本地化 label 一致），等效于用户手动点标签。
          var labels = {};
          labels[__t("view")] = true;
          labels["\u6587\u4ef6"] = true;
          labels["Files"] = true;
          var tries = 0;
          var timer = setInterval(function () {
            tries += 1;
            var tabs = document.querySelectorAll("[role=\"tab\"]");
            for (var i = 0; i < tabs.length; i += 1) {
              var btn = tabs[i];
              var text = (btn.textContent || "").trim();
              if (labels[text] && btn.getAttribute("aria-selected") !== "true") {
                clearInterval(timer);
                btn.click();
                return;
              }
              if (labels[text] && btn.getAttribute("aria-selected") === "true") {
                clearInterval(timer);
                return;
              }
            }
            if (tries >= 200) clearInterval(timer);
          }, 150);
        };
      }
    }

    // 通过 props 传递 store / t / rpcCall
    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  }
});

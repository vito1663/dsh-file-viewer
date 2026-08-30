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
// 目录浏览：viewer.list 端点 —— 输入目录 → 面包屑 + 子目录/文件列表；
// 点子目录进入，点文件加载渲染，支持「上一级」与面包屑跳转；文件视图带「所在目录」返回。
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
    var TIMEOUT_MS = 25000;

    var ENDPOINTS = { load: "viewer.load", list: "viewer.list" };

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

    // v7.4: 目录浏览器（面包屑 + 子目录/文件列表）。
    function renderDirBrowser(dir, open, t) {
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
                e.kind === "file" && e.size !== undefined ? h("span", { style: S.entrySize }, formatSize(e.size)) : null
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
      var inputRef = React.useRef(null);
      // 请求序号：快速连续打开时丢弃过期响应（防慢响应覆盖新结果）。
      var reqIdRef = React.useRef(0);
      // 挂载首帧标记：首帧由 mount effect 决定展示内容，后续 store 变更才走 deps effect。
      var mountedRef = React.useRef(false);

      function loadFile(absPath, myId) {
        setFile(undefined); setDir(undefined);
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
        if (typeof last === "string" && last.length > 0) {
          setPath(last);
          open(last);
        } else if (pendingOpen && initialPath && (snapshot.session === undefined || snapshot.session === sessionId)) {
          setPath(initialPath);
          open(initialPath);
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
            ? renderDirBrowser(dir, open, t)
            : (file !== undefined
              ? h("div", { style: S.fileWrap },
                h("div", { style: S.meta },
                  h("span", null, t("auto") + file.kind + " · " + file.name + " · " + formatSize(file.size)),
                  fileParent !== undefined
                    ? h("span", { style: S.parentLink, role: "button", tabIndex: 0, title: fileParent,
                        onClick: function () { open(fileParent); },
                        onKeyDown: function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(fileParent); } } },
                      "⬅ " + t("parentDir"))
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
        };
      }
    }

    // 通过 props 传递 store / t / rpcCall
    module.exports = { name: name, inject: inject, apply: apply };
    return module.exports;
  }
});

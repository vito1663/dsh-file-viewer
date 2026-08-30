# dsh-file-viewer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that adds a **server file browser + viewer** inside the dsh web UI.

Enter a server path — if it is a **file**, the plugin auto-detects the type and renders it in the browser; if it is a **directory**, it shows the directory's subdirectories and files, letting you navigate into subdirectories and open files directly. Content is loaded **from the server** over the plugin's own RPC channel, so any device that can log into dsh can view files — no shared folders, no loopback, no desktop required.

## Why

dsh's built-in workspace file browser opens files via `xdg-open` on the machine running dsh. On a headless / containerised server this always fails (no desktop, no browser), and even when a browser exists it opens a **server-local** window you cannot see from your own device.

This plugin routes around that: a dedicated **"文件查看 / Files" tab** in the conversation area reads the file content on the server and renders it in your browser.

## Features

- **Directory browser**: enter any directory path → breadcrumb + sorted list of subdirectories (first) and files (with sizes); click a subdirectory to enter it, click a file to open it. Supports "up one level" and breadcrumb jumps.
- **Auto-detect + render**:

  | Type | Detection | Rendering |
  |---|---|---|
  | HTML / HTM / XHTML | extension + content | sandboxed `<iframe>` (`srcDoc`, scripts disabled) |
  | PNG / JPEG / GIF / WEBP | extension + **magic bytes** | `<img>` (base64) |
  | SVG | extension | sandboxed iframe |
  | PDF | magic bytes | iframe (base64) + "open in new tab" fallback |
  | Markdown | extension | headings / lists / tables / quotes / fenced code / inline styles |
  | JSON | extension | pretty-printed `<pre>` |
  | CSV / TSV | extension | table |
  | Word `.docx` | ZIP magic + extension | converted to HTML on the host via [mammoth](https://github.com/mammoth/mammoth.js) |
  | Word `.doc` | extension | converted to text on the host via `antiword` |
  | Any text / code / log | fallback | monospace `<pre>` |

  Magic bytes take precedence over extensions (forged extensions are not trusted).
- **Conversation integration**: clicking a produced-file chip or a file path in the conversation switches to the Files tab and opens it (on headless hosts, via an optional compatibility patch — see below).

## Installation

Requires Node >= 22 and a dsh web profile (with `@deepseek-ai/dsh-web-app`).

```sh
# in your dsh profile (e.g. the web profile)
dsh plugin --profile web add github:vito1663/dsh-file-viewer -w
```

Then install the optional Word-conversion dependency **inside the plugin directory**:

```sh
cd <plugin dir>      # e.g. ~/.dsh/local-plugins/dsh-file-viewer
npm install mammoth  # for .docx → HTML
```

`.doc` (legacy Word) additionally needs `antiword` on the host (Debian/Ubuntu: `apt install antiword`; it ships with a UTF-8 mapping for CJK documents). Both are optional — without them, Word files report a clear error and everything else still works.

Restart dsh web afterwards (`sudo systemctl restart dsh-web` if managed by systemd).

## Usage

1. Open any session in dsh web.
2. Click the **文件查看 / Files** tab (next to 对话 / Trajectory).
3. Enter an absolute server path and press Enter or click 打开 / Open:
   - a **directory** → its contents are listed (folders first); click to navigate or open;
   - a **file** → it is auto-detected and rendered.
4. Clicking produced-file chips or file paths in the conversation auto-switches to this tab (with the compatibility patch, see below).

## Security

- **Read-only**: never writes files, never executes anything.
- **Size limits**: text ≤ 8 MB; binary (images/PDF) ≤ 6 MB; Word documents ≤ 30 MB.
- **Denied paths**: `/etc`, `/proc`, `/sys`, `/dev` and path segments like `.ssh`, `.git`, `.dsh`, `settings.yaml`, `.credentials*`, `.env`, `.npmrc`, `.bash_history` etc. are rejected for both reading and listing (credential-bearing dotfiles are hidden from directory listings).
- **Denied extensions**: `.pem`, `.key`, `.p12`, `.pfx`, `.crt`, `.cer`, `.p8`, `.env`, `.keystore`.
- **Channel fence**: the RPC channel is registered with `authority: 'trusted-host'`, which is a DNS-rebinding guard, **not** an authentication layer — put real authentication (access password, reverse-proxy / gateway auth) in front of your dsh deployment.

## Compatibility patch (headless servers)

On headless hosts, dsh's core conversation "open file" action (`openFile`) still goes through `host.openPath` → `xdg-open`, which fails. This repo ships an idempotent helper that routes that core action into the plugin:

```sh
node scripts/patch-conversation-openfile.mjs
```

It patches `dsh-client-ui-conversation/lib/client.js` so `openFile` calls the plugin's global hook (`window.__dshFileViewerOpen`) and switches to the Files tab, falling back to the original behavior when the plugin is absent. **dsh upgrades overwrite node_modules, so re-run the script after upgrading dsh.** Patch without the plugin is inert.

## Development

```sh
npm install          # installs mammoth (runtime) 
node scripts/build-client.mjs   # copy client/client.src.js → client/client.js
npm test             # host-side contract tests (node:test)
```

`client/client.js` is generated from `client/client.src.js` — edit the source, then rebuild. The client is a `__ModuleLoader__` classic script (no JSX/TS/imports).

## License

MIT — see [LICENSE](LICENSE).

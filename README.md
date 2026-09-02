**English** | [简体中文](README.zh-CN.md)

# dsh-file-viewer

**In one sentence: browse and view the files and directories on the machine where dsh runs, right from the dsh web UI.**

## The two problems it solves

**Problem 1: you can't see the server's files.**
dsh runs on the server, but the web UI gives you no way to view the server's files directly — to see a file's content you'd have to SSH in.

**Problem 2: when you use dsh remotely, clicking a file path looks on *your* device.**
dsh lives on the server (or a remote machine), but you're operating from another device. When you click a file path in the conversation, dsh assumes the file exists on **the device you're currently using** and looks there — your device doesn't have the server's files, so it always fails with "not found".

With this plugin: open dsh in your own browser, click the **Files** tab, type a path or browse directories — the server's files render right in the page, no matter which device you're on.

> Installed on dsh running on your own computer instead? It works the same — you just view that computer's files.

## What it does

- **Browse directories**: enter a directory path (e.g. `/srv/share`) and get an instant list of subdirectories and files; click a subdirectory to enter it, click a file to open it. Supports "up one level" and breadcrumb jumps.
- **Open files**: enter a file path and the plugin auto-detects the type and renders it. Formats it understands:
| Format | Rendering |
|---|---|
| Markdown | headings / lists / tables / quotes / code blocks / inline styles |
| HTML / SVG | sandboxed iframe (scripts disabled, safe) |
| Images (PNG/JPG/GIF/WebP) | displayed directly |
| PDF | embedded viewer, plus "open in new tab" |
| Word (.docx) | converted to a web page (headings, tables, images intact) |
| Word (.doc legacy) | converted to plain text |
| JSON | pretty-printed |
| CSV / TSV | as a table |
| Any text / code / log | monospace display |

> Detection uses file content "magic bytes" first — a fake extension won't fool it.

- **Download files**: every file row in the directory list ends with a small **⬇** badge (and the file view has a **⬇ Download** button). Clicking the file title/row opens the preview as before; clicking the **⬇** badge downloads the original file to your device, with live progress and the original filename. Files are pulled in 512 KB chunks (safe behind gateways/CDNs) and never converted — a `.docx` downloads as the real `.docx`. Cap: **64 MB** per file.

- **Conversation integration**: click a produced-file chip or a file path in the conversation to jump straight to the Files tab (needs a small compatibility patch on headless servers — see below).

## Installation

Requires Node >= 22 and an existing dsh web setup.

```sh
# in your dsh profile (e.g. the web profile)
dsh plugin --profile web add github:vito1663/dsh-file-viewer -w
```

Then install one optional dependency **inside the plugin directory** (turns Word into web pages):

```sh
cd <plugin dir>      # usually ~/.dsh/local-plugins/dsh-file-viewer
npm install mammoth
```

- For legacy `.doc` files, also install `antiword` on the server: `apt install antiword` (Debian/Ubuntu).
- Both are **optional**: without them, opening Word files shows a clear error and everything else still works.

Finally restart dsh web (`sudo systemctl restart dsh-web` if managed by systemd).

## Usage

1. Open dsh web and enter any session.
2. Click the **Files** tab at the top (next to Chat and Trajectory).
3. Enter an absolute server path and press Enter or click Open:
   - a **directory** → its contents are listed; click your way down;
   - a **file** → auto-rendered.
4. **Download**: click the **⬇** badge at the end of a file row (or the **⬇ Download** button in the file view) to save the file to your device. Clicking the file title/row itself still opens the preview.

The first time you open the Files tab it defaults to the current workspace directory; files you viewed are remembered, so switching back shows them again.

## Security

- **Read-only**: it never writes files and never executes anything.
- **Size limits**: files are streamed in 512 KB chunks; **64 MB** per file for both preview and download.
- **Sensitive paths rejected**: `/etc`, `/proc`, `.ssh`, `.git`, `settings.yaml`, `.env`, `.npmrc`, etc. are not viewable, not downloadable, and are hidden from directory listings.
- **Important**: the plugin channel only guards against DNS rebinding — it is **not** login authentication. Make sure your dsh deployment has its own auth (access password / reverse-proxy auth) before exposing it to the internet.

## Compatibility patch for headless servers (recommended)

On headless servers, dsh's built-in "open file in conversation" action goes through `xdg-open` and fails. This repo ships a tiny script that reroutes it to the Files tab:

```sh
node scripts/patch-conversation-openfile.mjs
```

- Idempotent: re-running is harmless; re-run after dsh upgrades overwrite the patched file.
- Inert when the plugin isn't installed — safe to leave in place.

## Development

```sh
npm install                          # installs mammoth
node scripts/build-client.mjs        # client/client.src.js → client/client.js
npm test                             # host-side contract tests
```

`client/client.js` is generated from `client/client.src.js` — edit the source, then rebuild.

## License

MIT — see [LICENSE](LICENSE).

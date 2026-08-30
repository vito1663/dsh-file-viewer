**English** | [简体中文](README.zh-CN.md)

# dsh-file-viewer

**In one sentence: browse and view the files and directories on the machine where dsh runs, right from the dsh web UI.**

## Who is this for?

**Mainly for people running dsh on a remote server.**

Picture this:

- Your dsh runs on a Linux server with **no desktop and no browser** (normal for a server).
- You want to see what a file on that server looks like — before, you'd have to SSH in and `cat` it, or click "open" in dsh and nothing happens, because there's no graphical environment on the server.
- After installing this plugin: open dsh in **your own browser** (computer or phone) → click the **Files** tab → type a path or click through directories → the file renders right in the page.

You can look from anywhere: your office computer, your phone on a trip, an iPad at home. As long as you can log into dsh, you can see the server's files and directories. **No shared folders, no remote desktop, no browser installed on the server.**

> Installed on dsh running on your **own computer** instead? It works exactly the same — you just browse that computer's files.

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

The first time you open the Files tab it defaults to the current workspace directory; files you viewed are remembered, so switching back shows them again.

## Security

- **Read-only**: it never writes files and never executes anything.
- **Size limits**: regular files ≤ 6 MB, Word ≤ 30 MB.
- **Sensitive paths rejected**: `/etc`, `/proc`, `.ssh`, `.git`, `settings.yaml`, `.env`, `.npmrc`, etc. are not viewable and are hidden from directory listings.
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

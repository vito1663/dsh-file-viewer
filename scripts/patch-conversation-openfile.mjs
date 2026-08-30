#!/usr/bin/env node
// dsh-file-viewer: 把官方对话 UI 的 openFile（产物芯片 / 消息内文件路径）路由进本插件。
//
// 背景：无头服务器上官方 openFile 走 host.openPath → xdg-open → 必败
// （www-browser/links/lynx/w3m 全缺）。本脚本给 dsh-client-ui-conversation 打一个
// 极小补丁：openFile 时若 window.__dshFileViewerOpen 存在（本插件客户端已暴露），
// 就写入路径 + actions.setView("file-viewer") 切到「文件查看」标签页在浏览器内渲染，
// 否则保持官方行为不变。
//
// 幂等：已打过补丁的文件会跳过。dsh 升级会覆盖 node_modules 里的文件，升级后重跑本脚本即可。
// 用法：node scripts/patch-conversation-openfile.mjs [dsh安装根目录]
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync } from 'node:fs';

const ORIGINAL = `						openFile: (path) => {
							const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
							return workspaces.openPath((0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path));
						},`;
const PATCHED = `						openFile: (path) => {
							const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd;
							const resolved = (0, _deepseek_ai_dsh_client_runtime_client.resolveWorkspacePath)(cwd, path);
							if (typeof window !== "undefined" && typeof window.__dshFileViewerOpen === "function") {
								window.__dshFileViewerOpen(resolved);
								actions.setView("file-viewer");
								return Promise.resolve();
							}
							return workspaces.openPath(resolved);
						},`;
// v7 时代的旧补丁（无 setView），升级为目标补丁
const OLD_PATCH_INNER = `							if (typeof window !== "undefined" && typeof window.__dshFileViewerOpen === "function") {
								window.__dshFileViewerOpen(resolved);
								return Promise.resolve();
							}`;
const NEW_PATCH_INNER = `							if (typeof window !== "undefined" && typeof window.__dshFileViewerOpen === "function") {
								window.__dshFileViewerOpen(resolved);
								actions.setView("file-viewer");
								return Promise.resolve();
							}`;

function findTarget(explicit) {
  const candidates = [];
  if (explicit) candidates.push(join(explicit, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'));
  const nvmVersions = join(homedir(), '.nvm', 'versions');
  if (existsSync(nvmVersions)) {
    // ~/.nvm/versions/<engine>/<version>/lib/node_modules/...
    for (const engine of readdirSync(nvmVersions)) {
      const engineRoot = join(nvmVersions, engine);
      if (!existsSync(engineRoot)) continue;
      for (const v of readdirSync(engineRoot)) {
        candidates.push(join(engineRoot, v, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'));
      }
    }
  }
  candidates.push(join('/usr/local/lib/node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-conversation', 'lib', 'client.js'));
  for (const c of candidates) if (existsSync(c)) return c;
  return undefined;
}

const target = findTarget(process.argv[2]);
if (!target) {
  console.error('未找到 dsh-client-ui-conversation/lib/client.js。可用参数指定 dsh 安装根目录。');
  process.exit(1);
}
const src = readFileSync(target, 'utf8');
if (src.includes('actions.setView("file-viewer")')) {
  console.log(`已打过 v7.3 补丁，跳过：${target}`);
  process.exit(0);
}
if (src.includes(OLD_PATCH_INNER)) {
  copyFileSync(target, `${target}.bak-dsh-file-viewer`);
  writeFileSync(target, src.replace(OLD_PATCH_INNER, NEW_PATCH_INNER));
  console.log(`已升级 openFile 补丁（加 setView）：${target}`);
  process.exit(0);
}
if (src.includes(ORIGINAL)) {
  copyFileSync(target, `${target}.bak-dsh-file-viewer`);
  writeFileSync(target, src.replace(ORIGINAL, PATCHED));
  console.log(`已补丁 openFile → 文件查看标签页：${target}`);
  process.exit(0);
}
console.error(`目标文件内容与预期不符（openFile 片段未匹配），未改动：${target}`);
process.exit(1);

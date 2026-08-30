[English](README.md) | **简体中文**

# dsh-file-viewer

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 插件，在 dsh web 界面里提供**服务器文件浏览器 + 查看器**。

输入一个服务器路径——如果是**文件**，插件自动识别类型并在浏览器中渲染；如果是**目录**，则展示该目录下的子目录与文件列表，可点击进入子目录、直接打开文件。内容经插件自有的 RPC 通道**从服务器加载**，任何能登录 dsh 的设备都能查看文件——无需共享目录、无需 loopback、无需桌面环境。

## 为什么需要它

dsh 内置的工作区文件浏览器通过 `xdg-open` 在**运行 dsh 的机器上**打开文件。在无桌面/无浏览器的服务器（无头/容器化）上这必然失败；即便装了浏览器，打开的也是**服务器本地**的窗口，你在自己的设备上看不到。

本插件绕开这条路：在会话区提供一个专用的 **「文件」标签页**，从服务器读取文件内容并在你的浏览器中渲染。

## 功能

- **目录浏览器**：输入任意目录路径 → 面包屑 + 排序后的子目录（在前）与文件列表（含大小）；点击子目录进入、点击文件打开。支持「上一级」与面包屑跳转。
- **自动识别 + 渲染**：

  | 类型 | 识别 | 渲染 |
  |---|---|---|
  | HTML / HTM / XHTML | 扩展名 + 内容 | **沙箱 iframe**（`srcDoc`，禁脚本） |
  | PNG / JPEG / GIF / WEBP | 扩展名 + **魔数** | `<img>`（base64） |
  | SVG | 扩展名 | 沙箱 iframe |
  | PDF | 魔数 | iframe（base64）+「新窗口打开」兜底 |
  | Markdown | 扩展名 | 标题 / 列表 / 表格 / 引用 / 围栏代码 / 行内样式 |
  | JSON | 扩展名 | 美化后 `<pre>` |
  | CSV / TSV | 扩展名 | 表格 |
  | Word `.docx` | ZIP 魔数 + 扩展名 | 宿主端用 [mammoth](https://github.com/mammoth/mammoth.js) 转 HTML |
  | Word `.doc` | 扩展名 | 宿主端用 `antiword` 转文本 |
  | 任意文本 / 代码 / 日志 | 兜底 | 等宽 `<pre>` |

  魔数优先于扩展名（不信任伪造扩展名）。
- **会话内集成**：点击对话中的产物文件芯片或文件路径，会自动切到「文件」标签页并打开（无头服务器需配合兼容补丁，见下文）。

## 安装

要求 Node >= 22，且已有 dsh web profile（含 `@deepseek-ai/dsh-web-app`）。

```sh
# 在你的 dsh profile 中（如 web profile）
dsh plugin --profile web add github:vito1663/dsh-file-viewer -w
```

然后**在插件目录内**安装可选的 Word 转换依赖：

```sh
cd <插件目录>       # 如 ~/.dsh/local-plugins/dsh-file-viewer
npm install mammoth  # 用于 .docx → HTML
```

`.doc`（旧版 Word）还需要宿主机安装 `antiword`（Debian/Ubuntu：`apt install antiword`；自带 UTF-8 映射，中文文档正常）。两者均为可选——未安装时 Word 文件会给出明确错误提示，其余功能不受影响。

装完重启 dsh web（若由 systemd 托管：`sudo systemctl restart dsh-web`）。

## 使用

1. 在 dsh web 中打开任意会话。
2. 点击 **「文件」** 标签页（位于「对话 / 轨迹」之后）。
3. 输入服务器上的绝对路径，回车或点「打开」：
   - **目录** → 列出其内容（文件夹在前）；点击导航或打开；
   - **文件** → 自动识别并渲染。
4. 点击对话中的产物文件芯片或文件路径，会自动切到本标签页（需兼容补丁，见下文）。

## 安全

- **只读**：从不写文件、从不执行任何东西。
- **大小限制**：文件（文本、图片、PDF）≤ 6 MB；Word 文档 ≤ 30 MB。
- **拒绝路径**：`/etc`、`/proc`、`/sys`、`/dev` 以及 `.ssh`、`.git`、`.dsh`、`settings.yaml`、`.credentials*`、`.env`、`.npmrc`、`.bash_history` 等路径段在**读取和列目录**时均被拒绝（含凭据的 dotfile 不出现在目录列表中）。
- **拒绝扩展名**：`.pem`、`.key`、`.p12`、`.pfx`、`.crt`、`.cer`、`.p8`、`.env`、`.keystore`。
- **通道栅栏**：RPC 通道以 `authority: 'trusted-host'` 注册，这只是 DNS 重绑定防护，**不是**认证层——请在 dsh 部署前放置真正的认证（访问密码、反向代理/网关鉴权等）。

## 兼容补丁（无头服务器）

无头宿主机上，dsh 核心的对话「打开文件」动作（`openFile`）仍走 `host.openPath` → `xdg-open`，会失败。本仓库附带一个幂等脚本，把该核心动作路由进本插件：

```sh
node scripts/patch-conversation-openfile.mjs
```

它给 `dsh-client-ui-conversation/lib/client.js` 打补丁，使 `openFile` 调用插件的全局钩子（`window.__dshFileViewerOpen`）并切换到「文件」标签页；插件不存在时回退到原有行为。**dsh 升级会覆盖 node_modules，升级后请重跑本脚本。** 插件未安装时该补丁不产生任何效果。

## 开发

```sh
npm install          # 安装 mammoth（运行时依赖）
node scripts/build-client.mjs   # 拷贝 client/client.src.js → client/client.js
npm test             # 宿主契约测试（node:test）
```

`client/client.js` 由 `client/client.src.js` 生成——请改源码后重新构建。客户端是 `__ModuleLoader__` 经典脚本（无 JSX/TS/import）。

## 许可

MIT — 见 [LICENSE](LICENSE)。

// dsh-file-viewer — 宿主半边。
//
// 通过 dsh 的通用 Connection RPC 通道注册 `/dsh-file-viewer`，与客户端
// `connection.rpc.call("/dsh-file-viewer", "viewer.load" | "viewer.list", payload)` 对应。
//
// 注意：静态 bundle 插件的 web 通道必须用 `connection.rpc.handle(channel, handler)`
// 注册 —— `harness.handle` 是「动态 cordis 包沙箱」才有的全局，静态 bundle 宿主上
// 不存在（拿不到就安全降级，不阻断 boot）。
import { ENDPOINTS, createHandler } from "./rpc.js";

export const name = "dsh-file-viewer";
export const inject = ["connection", "fs"];

export function apply(ctx) {
  const logger = ctx.logger?.(name) ?? console;
  try {
    const fs = ctx.fs;
    const connection = ctx.connection;
    if (!fs || !connection || typeof connection.rpc?.handle !== "function") {
      logger.warn?.("dsh-file-viewer: 缺 fs/connection 服务，降级禁用");
      return;
    }
    const handler = createHandler(fs, logger);
    ctx.effect(
      () => connection.rpc.handle("/dsh-file-viewer", handler, { authority: "trusted-host" }),
      "dsh-file-viewer: 文件查看通道"
    );
    logger.info?.("dsh-file-viewer: 已注册 /dsh-file-viewer RPC 通道（%s / %s）", ENDPOINTS.load, ENDPOINTS.list);
  } catch (error) {
    logger.warn?.("dsh-file-viewer: 初始化失败（不阻断 boot）：%s", error?.message ?? String(error));
  }
}

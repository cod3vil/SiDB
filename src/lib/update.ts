// 在线自动更新（Tauri v2 updater 插件）。
// 端点与公钥在 src-tauri/tauri.conf.json 的 plugins.updater 配置；服务端做版本比较。

import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/** 检查更新；无更新（端点 204）返回 null。 */
export async function checkUpdate(): Promise<Update | null> {
  return await check();
}

/** 下载并安装，progress 回调返回 0–100 的百分比（总长未知时为 null）。安装后重启。 */
export async function installUpdate(
  update: Update,
  onProgress?: (pct: number | null) => void,
): Promise<void> {
  let total = 0;
  let got = 0;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Started") {
      total = ev.data.contentLength ?? 0;
      onProgress?.(total > 0 ? 0 : null);
    } else if (ev.event === "Progress") {
      got += ev.data.chunkLength;
      onProgress?.(total > 0 ? Math.min(100, Math.round((got / total) * 100)) : null);
    } else if (ev.event === "Finished") {
      onProgress?.(100);
    }
  });
  await relaunch();
}

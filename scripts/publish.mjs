#!/usr/bin/env node
/**
 * Tauri App Manager 发布 CLI
 *
 * 在 Tauri 应用项目里执行（需先 `tauri build` 产出带签名的更新包）：
 *
 *   node scripts/publish.mjs \
 *     --manager https://你的manager域名 \
 *     --app my-app \
 *     --version 1.0.0 \
 *     --notes "修复若干问题" \
 *     --dir src-tauri/target/release/bundle \
 *     --token <PUBLISH_TOKEN>
 *
 * 也可显式指定平台文件（可重复）：
 *   --platform darwin-aarch64=path/to/app.app.tar.gz
 *
 * token 也可用环境变量 PUBLISH_TOKEN 提供。
 *
 * 自动扫描规则：在 --dir 下递归查找所有 *.sig，签名同名去掉 .sig 即安装包；
 * 平台 target 由扩展名推断，arch 由文件名中的 aarch64/x64/x86_64/amd64 等推断。
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

function parseArgs(argv) {
  const args = { platform: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === "platform") {
      args.platform.push(next);
      i++;
    } else if (next && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function detectTarget(file) {
  const f = file.toLowerCase();
  if (f.endsWith(".app.tar.gz")) return "darwin";
  if (f.endsWith(".nsis.zip") || f.endsWith(".msi.zip")) return "windows";
  if (f.endsWith(".appimage.tar.gz") || f.endsWith(".appimage")) return "linux";
  return null;
}

function detectArch(file) {
  const f = file.toLowerCase();
  if (/(aarch64|arm64)/.test(f)) return "aarch64";
  if (/(x86_64|amd64|x64)/.test(f)) return "x86_64";
  if (/(armv7|armhf)/.test(f)) return "armv7";
  if (/(i686|x86|ia32)/.test(f)) return "i686";
  return null;
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function collectFromDir(dir) {
  const all = await walk(dir);
  const sigs = all.filter((f) => f.endsWith(".sig"));
  const result = [];
  for (const sig of sigs) {
    const bundle = sig.slice(0, -4); // 去掉 .sig
    if (!all.includes(bundle)) {
      console.warn(`⚠️  找到签名但缺少对应安装包：${sig}`);
      continue;
    }
    const name = basename(bundle);
    const target = detectTarget(name);
    const arch = detectArch(name);
    if (!target || !arch) {
      console.warn(
        `⚠️  无法识别平台/架构，已跳过：${name}（请用 --platform 显式指定）`
      );
      continue;
    }
    result.push({ platformKey: `${target}-${arch}`, target, arch, bundle, sig });
  }
  return result;
}

async function collectFromExplicit(specs) {
  const result = [];
  for (const spec of specs) {
    const [platformKey, file] = spec.split("=");
    if (!platformKey || !file) {
      throw new Error(`--platform 格式应为 key=文件路径，收到：${spec}`);
    }
    const [target, arch] = platformKey.split("-");
    const sig = `${file}.sig`;
    await stat(file); // 确认存在
    result.push({ platformKey, target, arch, bundle: file, sig });
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const manager = (args.manager || "").replace(/\/+$/, "");
  const app = args.app;
  const version = args.version;
  const channel = args.channel || "stable";
  const notes = args.notes || "";
  const token = args.token || process.env.PUBLISH_TOKEN;

  if (!manager || !app || !version) {
    console.error("用法: --manager <url> --app <slug> --version <x.y.z> [--dir <bundleDir> | --platform key=file ...] [--notes ..] [--channel ..] [--token ..]");
    process.exit(1);
  }
  if (!token) {
    console.error("缺少发布令牌：用 --token 或环境变量 PUBLISH_TOKEN 提供");
    process.exit(1);
  }

  let items = [];
  if (args.platform.length) {
    items = await collectFromExplicit(args.platform);
  } else if (args.dir) {
    items = await collectFromDir(resolve(args.dir));
  } else {
    console.error("请提供 --dir <bundleDir> 或至少一个 --platform key=file");
    process.exit(1);
  }

  if (!items.length) {
    console.error("没有找到任何可发布的安装包（需要 *.sig 签名文件）");
    process.exit(1);
  }

  console.log(`准备发布 ${app} v${version}（渠道 ${channel}）：`);
  for (const it of items) {
    console.log(`  · ${it.platformKey}  ${basename(it.bundle)}`);
  }

  const form = new FormData();
  form.set("app", app);
  form.set("version", version);
  form.set("channel", channel);
  form.set("notes", notes);

  for (const it of items) {
    const [buf, sig] = await Promise.all([
      readFile(it.bundle),
      readFile(it.sig, "utf8"),
    ]);
    const blob = new Blob([buf]);
    form.set(`file_${it.platformKey}`, blob, basename(it.bundle));
    form.set(`sig_${it.platformKey}`, sig.trim());
  }

  console.log("上传中……");
  const res = await fetch(`${manager}/api/publish`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`❌ 发布失败 (${res.status}): ${data.error || JSON.stringify(data)}`);
    process.exit(1);
  }
  console.log(`✅ 发布成功：${data.release.app} v${data.release.version}`);
  console.log(`   平台：${data.release.platforms.join(", ")}`);
}

main().catch((e) => {
  console.error("❌", e.message || e);
  process.exit(1);
});

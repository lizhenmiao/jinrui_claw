/**
 * 打包编排：渲染层构建 → 备份主进程源码 → 编译 V8 字节码（Electron V8 环境）→
 * 调用 electron-builder → 无论成败恢复源码。保证安装包内无明文业务源码，
 * 仓库工作区始终回到源码状态。
 *
 * 用法：node scripts/dist.mjs --win | --mac
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = ["src/main", "src/preload"];
const BACKUP_ROOT = path.join(os.tmpdir(), `zgyclaw-src-backup-${process.pid}`);

/** 报错并退出（仅限尚未改动源码的阶段；源码进入存根状态后失败必须走 finally 恢复）。 */
function fail(message) {
  console.error(`[dist] ${message}`);
  process.exit(1);
}

/** 备份主进程/预加载源码到系统临时目录，供打包后恢复。 */
function backupSources() {
  for (const dir of SOURCE_DIRS) {
    const source = path.join(PROJECT_ROOT, dir);
    const target = path.join(BACKUP_ROOT, dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
}

/** 用临时目录备份还原源码，保证工作区不残留字节码存根。 */
function restoreSources() {
  for (const dir of SOURCE_DIRS) {
    const backup = path.join(BACKUP_ROOT, dir);
    const source = path.join(PROJECT_ROOT, dir);
    fs.rmSync(source, { recursive: true, force: true });
    fs.cpSync(backup, source, { recursive: true });
  }
  fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
}

/** 在 Electron 的 Node 环境中编译主进程/预加载字节码（V8 版本与运行时一致），失败抛错以触发源码恢复。 */
async function compileBytecode() {
  const electronBinary = (await import("electron")).default;
  if (typeof electronBinary !== "string" || !electronBinary) {
    throw new Error("无法解析 Electron 可执行文件路径，请确认已安装依赖");
  }
  const compileScript = path.join(PROJECT_ROOT, "scripts", "bytecode-compile.cjs");
  const result = spawnSync(electronBinary, [compileScript], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`字节码编译失败（exit ${result.status}）`);
}

/** 调用 electron-builder 执行目标平台打包，返回退出码。mac 一次出 arm64 + x64 两个 dmg。 */
function runBuilder(platform) {
  const builderArgs = platform === "win"
    ? ["--win", "portable", "--x64", "--publish", "never"]
    : ["--mac", "dmg", "--x64", "--arm64", "--publish", "never"];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["node_modules/electron-builder/cli.js", ...builderArgs], {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      shell: false,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(`[dist] electron-builder 启动失败: ${error.message}`);
      resolve(1);
    });
  });
}

const target = process.argv[2];
if (!["--win", "--mac"].includes(target)) {
  fail("用法: node scripts/dist.mjs --win | --mac");
}

fs.rmSync(path.join(PROJECT_ROOT, "out", "renderer"), { recursive: true, force: true });
const vite = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  shell: false,
});
if (vite.status !== 0) fail(`渲染层构建失败（exit ${vite.status}）`);

let exitCode = 1;
backupSources();
try {
  await compileBytecode();
  exitCode = await runBuilder(target === "--win" ? "win" : "mac");
} finally {
  restoreSources();
}
console.log(`[dist] ${exitCode === 0 ? "打包完成" : `打包失败（exit ${exitCode}）`}`);
process.exit(exitCode);

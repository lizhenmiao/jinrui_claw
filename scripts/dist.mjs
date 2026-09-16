/**
 * 打包编排：渲染层构建 → 备份主进程源码 → 编译 V8 字节码（Electron V8 环境）→调用 electron-builder → 无论成败恢复源码。保证安装包内无明文业务源码，仓库工作区始终回到源码状态。
 *
 * Windows 产出目录形态（exe + resources 文件夹，压成 zip 交付）：双击即启动、没有单文件 portable 的自解压等待，启动等待全部由应用内加载页承接。
 * macOS 产出 dmg（arm64 + x64）。
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

/**
 * 在 Electron 的 Node 环境中编译主进程/预加载字节码（V8 版本与运行时一致），失败抛错以触发源码恢复。
 */
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

/**
 * 目录改名：Windows 上刚写完（尤其刚被 signtool 碰过）的目录常被杀软/索引器短暂占用，renameSync 会报 EPERM。退避重试若干次，仍失败则退化成"复制 + 删除"，不让整次打包白跑。
 */
async function moveDir(from, to) {
  const attempts = 12;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (i === attempts) {
        console.warn(`[dist] 目录改名重试 ${attempts} 次仍失败（${error.code}），改用复制方式`);
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/**
 * 运营配置在包内的路径。
 * 注意：不能放在 `resources/` 下——macOS 打包时整个 resources 源目录都不会进 asar
 * （实测 mac 产物 asar 顶层只有 node_modules/out/package.json/src），而 `out/` 是进得去的，
 * 所以打包前把配置暂存到 out/ 再打进去；运行时也从这里读，仍然受 asar 完整性校验保护。
 */
const PACKAGED_CONFIG_RELATIVE = "out/app.config.json";

/** 把 resources/app.config.json 暂存到 out/app.config.json，供 electron-builder 打进 asar。 */
function stagePackagedConfig() {
  const source = path.join(PROJECT_ROOT, "resources", "app.config.json");
  const target = path.join(PROJECT_ROOT, PACKAGED_CONFIG_RELATIVE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`[dist] 已暂存运营配置 → ${PACKAGED_CONFIG_RELATIVE}（打包用，二进制与源文件一致）`);
}

/**
 * 读 app.asar 的文件表（asar 头部是 JSON 目录表：16 字节头 + 该 JSON）。
 * 用于打包后确认运营配置真的进了包——macOS 上曾出现配置没进 asar、客户端起不来的情况，
 * 这类问题必须在构建期就暴露，不能等到了客户机器上才发现。
 */
function asarEntries(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    const jsonSize = header.readUInt32LE(12);
    const json = Buffer.alloc(jsonSize);
    fs.readSync(fd, json, 0, jsonSize, 16);
    return JSON.parse(json.toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

/** 在 asar 目录表里按路径查条目是否存在。 */
function asarHasPath(entries, relativePath) {
  let node = entries;
  for (const segment of relativePath.split("/")) {
    if (!node || typeof node !== "object") return false;
    node = node.files?.[segment];
  }
  return Boolean(node);
}

/** 递归找出产物目录下所有 app.asar（Windows 目录版与 mac 的 .app 各在不同层级）。 */
function findAsarFiles(dir, found = [], depth = 0) {
  if (depth > 6) return found;
  let children = [];
  try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const child of children) {
    const full = path.join(dir, child.name);
    if (child.isDirectory()) findAsarFiles(full, found, depth + 1);
    else if (child.name === "app.asar") found.push(full);
  }
  return found;
}

/**
 * 打包后自检：产物里必须能找到运营配置（客户端读它拿后台地址），且优先在 asar 内。
 * 找不到就构建失败，并把实际布局打进日志——曾出现 macOS 产物在 asar 里找不到配置、
 * 客户端停在"未配置管理后台地址"的情况，这类问题必须在构建期暴露，不能等到了客户机器上。
 */
function verifyPackagedConfig() {
  const releaseDir = path.join(PROJECT_ROOT, "release");
  const asarFiles = findAsarFiles(releaseDir);
  if (!asarFiles.length) throw new Error("打包产物里没有找到任何 app.asar");
  const failures = [];
  for (const asarPath of asarFiles) {
    const resourcesRoot = path.dirname(asarPath);
    const label = path.relative(releaseDir, asarPath);
    const entries = asarEntries(asarPath);
    const inAsar = asarHasPath(entries, PACKAGED_CONFIG_RELATIVE);
    const inAppDir = fs.existsSync(path.join(resourcesRoot, "app", PACKAGED_CONFIG_RELATIVE));
    const topLevel = Object.keys(entries.files || {}).join(", ");
    if (inAsar) {
      console.log(`[dist] 自检通过（asar 布局）：${label} 内含 ${PACKAGED_CONFIG_RELATIVE}`);
    } else if (inAppDir) {
      console.warn(`[dist] 自检通过（app 目录布局）：${label} 的 asar 内没有配置，但同级展开的 app 目录下有；asar 顶层条目=${topLevel}`);
    } else {
      failures.push(`  ${label}：asar 内与同级 app 目录里都没有 ${PACKAGED_CONFIG_RELATIVE}；asar 顶层条目=${topLevel}`);
    }
  }
  if (failures.length) {
    throw new Error(`打包产物缺少运营配置（客户端会停在"未配置管理后台地址"）：\n${failures.join("\n")}\n请检查 package.json 的 build.files 是否包含 ${PACKAGED_CONFIG_RELATIVE}。`);
  }
}

/** 产物名里的版本号：取 package.json 的 version，本地与 CI 单一来源。 */
function projectVersion() {
  return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")).version;
}

/** Windows 目录形态收尾：win-unpacked 更名为 zgyclaw 并压成交付 zip（解压到 U 盘双击即启动）。 */
async function packageWinDir() {
  const releaseDir = path.join(PROJECT_ROOT, "release");
  const unpacked = path.join(releaseDir, "win-unpacked");
  const appDir = path.join(releaseDir, "zgyclaw");
  const zipPath = path.join(releaseDir, `zgyclaw-windows-amd64-${projectVersion()}.zip`);
  if (!fs.existsSync(unpacked)) throw new Error("打包产物目录缺失：release/win-unpacked");
  fs.rmSync(appDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  await moveDir(unpacked, appDir);
  fs.rmSync(zipPath, { force: true });
  const tarExecutable = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const result = spawnSync(tarExecutable, ["-a", "-cf", zipPath, "zgyclaw"], { cwd: releaseDir, stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`Windows 目录压缩失败（exit ${result.status}）`);
}

/** 调用 electron-builder 执行目标平台打包，返回退出码。mac 一次出 arm64 + x64 两个 dmg。 */
function runBuilder(platform) {
  const builderArgs = platform === "win"
    ? ["--win", "dir", "--x64", "--publish", "never"]
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

// 交付包的运营配置进 asar，必须是真实线上配置（不入库，CI 从 Secrets 注入、本机手工放置）。
// 缺失或残留占位符时直接终止，避免打出连不上后台、或带示例地址的包。
const appConfigPath = path.join(PROJECT_ROOT, "resources", "app.config.json");
if (!fs.existsSync(appConfigPath)) {
  fail("缺少 resources/app.config.json（线上运营配置）。CI 从仓库 Secrets 注入；本机打包请先放置该文件，可参考 resources/app.config.example.json");
}
try {
  const appConfig = JSON.parse(fs.readFileSync(appConfigPath, "utf8"));
  const clientId = String(appConfig?.oauth?.clientId || "");
  if (!clientId || /替换|placeholder|xxx/i.test(clientId)) fail("resources/app.config.json 的 oauth.clientId 仍是占位符，请填入真实公共客户端 ID");
  if (appConfig?.oauth?.clientSecret) fail("resources/app.config.json 含 oauth.clientSecret：桌面端是公共客户端，只用 PKCE，请删除该字段并在授权平台作废该密钥");
  const backendUrl = String(appConfig?.backend?.url || "");
  if (!backendUrl) fail("resources/app.config.json 的 backend.url 为空");
  // 本机用本地地址打包属正常（自测），但交付包不能带它——出个显眼警告而不是阻断。
  const localHosts = [backendUrl, String(appConfig?.oauth?.issuer || "")].filter((url) => /127\.0\.0\.1|localhost/i.test(url));
  if (localHosts.length) {
    console.warn(`[dist] 注意：配置里仍是本地地址（${localHosts.join("、")}），此包只能自测，不可交付客户`);
  }
} catch (error) {
  if (error instanceof SyntaxError) fail(`resources/app.config.json 解析失败：${error.message}`);
  throw error;
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
  stagePackagedConfig();
  exitCode = await runBuilder(target === "--win" ? "win" : "mac");
  if (exitCode === 0) {
    try {
      // 先自检产物里的运营配置，再收尾改名/压缩——带着问题收尾只会发出去一份起不来的包。
      verifyPackagedConfig();
      if (target === "--win") await packageWinDir();
    } catch (error) {
      console.error(`[dist] ${error.message}`);
      exitCode = 1;
    }
  }
} finally {
  restoreSources();
}
console.log(`[dist] ${exitCode === 0 ? "打包完成" : `打包失败（exit ${exitCode}）`}`);
process.exit(exitCode);

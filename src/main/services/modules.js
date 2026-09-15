/**
 * 运行时模块引导：把 openclaw 模块压缩包解压到本机缓存（仅首次），
 * 后续启动直接命中缓存，U 盘只保留压缩包。
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { getPaths } = require("../paths");

function log(message) {
  try {
    const { logsDir } = getPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, "modules-bootstrap.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch { /* 日志失败不阻塞引导 */ }
}

function moduleEntryPath() {
  return path.join(getPaths().modulesCacheDir, "openclaw", "openclaw.mjs");
}

function isReady() {
  const { modulesCacheDir } = getPaths();
  return fs.existsSync(path.join(modulesCacheDir, ".zgy-extract-ready")) && fs.existsSync(moduleEntryPath());
}

/**
 * 本机是否已经把 openclaw 组件跑起来过一次。
 * 刚解压出来的模块树第一次执行要付冷启动代价（实测约 1 分钟：Windows 首次读取扫描 + 冷文件缓存），
 * 标记与模块缓存同目录，模块重新解压时随 node_modules 一起消失，冷启动代价随之重来。
 */
function isRuntimeWarm() {
  return fs.existsSync(path.join(getPaths().modulesCacheDir, ".zgy-warm"));
}

/** 组件首次成功跑起来后落标记，之后的启动不再按"首次"提示。 */
function markRuntimeWarm() {
  try {
    fs.writeFileSync(path.join(getPaths().modulesCacheDir, ".zgy-warm"), `warmedAt=${new Date().toISOString()}\n`, "utf8");
  } catch { /* 标记写不进去只影响提示文案，不影响功能 */ }
}

/** 解压到临时目录再原子改名，避免中途失败留下半个缓存。 */
function extractArchive(archive, cacheParent) {
  fs.mkdirSync(cacheParent, { recursive: true });
  const staging = path.join(cacheParent, "_extracting");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  log(`extracting modules to ${cacheParent}`);
  const tarExecutable = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";
  const result = spawnSync(tarExecutable, ["-xzf", archive, "-C", staging], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("模块解压失败: " + (result.stderr || result.stdout || result.status));
  }

  const extracted = path.join(staging, "node_modules");
  if (!fs.existsSync(extracted)) throw new Error("压缩包缺少 node_modules");

  const finalDir = path.join(cacheParent, "node_modules");
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(extracted, finalDir);
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }

  fs.writeFileSync(path.join(finalDir, ".zgy-extract-ready"), `extractedAt=${new Date().toISOString()}\narchive=${archive}\n`, "utf8");
  log("extract complete");
}

/** 确保模块缓存就绪并返回模块根目录；压缩包缺失时抛错。 */
function ensureModules() {
  const { payloadArchive, modulesCacheDir } = getPaths();
  if (isReady()) return modulesCacheDir;
  if (!fs.existsSync(payloadArchive)) {
    throw new Error(`缺少模块压缩包: ${payloadArchive}`);
  }
  extractArchive(payloadArchive, path.dirname(modulesCacheDir));
  if (!fs.existsSync(moduleEntryPath())) throw new Error("解压后未找到 openclaw.mjs");
  return modulesCacheDir;
}


/**
 * 按需安装的 payload 包登记表：压缩包放 `resources/payload/`，解压到 target 目录。
 * 只给"不随模块包分发、要单独分发"的插件用；新增平台加一条即可。
 * 压缩包格式不限（tar / tar.gz / zip 都能用系统 tar 解），补齐 manifest 即视为已安装。
 */
const PAYLOADS = {
  qqbot: {
    archive: "qqbot-node_modules.zip",
    target: (p) => path.join(p.npmProjectsDir, "openclaw-qqbot-d3553f72f8"),
    manifest: "node_modules/@openclaw/qqbot/openclaw.plugin.json",
  },
  // 企业微信官方插件按 openclaw 官方安装布局分发（extensions 目录自动发现，无需登记加载路径）；
  // 包里刻意不含 node_modules/openclaw 链接（指向本机模块缓存、随机器变化），激活时代码重建。
  wecom: {
    archive: "wecom-plugin-extensions.zip",
    target: (p) => path.join(p.stateDir, "extensions", "wecom-openclaw-plugin"),
    manifest: "openclaw.plugin.json",
  },
};

/** payload 是否已就位（清单文件存在即认为装好了）。 */
function isPayloadReady(name) {
  const entry = PAYLOADS[name];
  if (!entry) return false;
  return fs.existsSync(path.join(entry.target(getPaths()), entry.manifest));
}

/**
 * 确保某个 payload 已解压到目标目录，返回目标目录路径（失败返回空串）。
 * 解压到临时目录再整体拷贝，避免中途失败留下半个安装；已就位时直接返回。
 */
function ensurePayload(name) {
  const entry = PAYLOADS[name];
  if (!entry) return "";
  const paths = getPaths();
  const target = entry.target(paths);
  if (isPayloadReady(name)) return target;

  const archive = path.join(paths.payloadDir, entry.archive);
  if (!fs.existsSync(archive)) {
    log(`payload ${name} missing archive: ${archive}`);
    return "";
  }

  const tmpDir = path.join(paths.payloadDir, `_payload-${name}-${process.pid}`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tarExecutable = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    // -xf 对 tar / tar.gz / zip 都能自适应（Windows 的 bsdtar 支持 zip）。
    const result = spawnSync(tarExecutable, ["-xf", archive, "-C", tmpDir], { windowsHide: true, timeout: 900000 });
    if (result.status !== 0) throw new Error(`payload ${name} 解压失败: ${result.stderr || result.status}`);
    if (!fs.existsSync(path.join(tmpDir, entry.manifest))) throw new Error(`payload ${name} 压缩包内容不完整`);
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(tmpDir, target, { recursive: true, force: true });
    log(`payload ${name} installed to ${target}`);
  } catch (error) {
    log(`payload ${name} install failed: ${error.message}`);
    return "";
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }
  }
  return isPayloadReady(name) ? target : "";
}

/** 查找已安装的 QQBot 插件工程目录列表。 */
function findQQBotPluginPaths() {
  const { npmProjectsDir } = getPaths();
  const found = [];
  if (!fs.existsSync(npmProjectsDir)) return found;
  for (const entry of fs.readdirSync(npmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("openclaw-qqbot")) continue;
    const pluginPath = path.join(npmProjectsDir, entry.name, "node_modules", "@openclaw", "qqbot");
    if (fs.existsSync(path.join(pluginPath, "openclaw.plugin.json"))) found.push(pluginPath);
  }
  return found;
}

/** QQBot 官方连接器入口（扫码绑定使用）。 */
function findQQBotConnectorEntry() {
  for (const project of findQQBotPluginPaths()) {
    const candidate = path.join(project, "node_modules", "@tencent-connect", "qqbot-connector", "dist", "esm", "index.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** 资源目录内的插件路径（随安装包分发）。 */
function bundledPluginPath(name) {
  return path.join(getPaths().pluginsDir, name);
}

module.exports = {
  bundledPluginPath,
  ensureModules,
  ensurePayload,
  findQQBotConnectorEntry,
  findQQBotPluginPaths,
  isPayloadReady,
  isRuntimeWarm,
  markRuntimeWarm,
  moduleEntryPath,
};

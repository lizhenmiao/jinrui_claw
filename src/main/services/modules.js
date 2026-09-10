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

/** QQBot 插件按需安装：首次配置 QQ 时把内置压缩包安装到数据目录的 npm 工程。 */
function ensureQQBotDependencyPayload() {
  const { stateDir, qqbotPayloadZip } = getPaths();
  const projectDir = path.join(stateDir, "npm", "projects", "openclaw-qqbot-d3553f72f8");
  const targetNodeModules = path.join(projectDir, "node_modules");
  const manifest = path.join(targetNodeModules, "@openclaw", "qqbot", "openclaw.plugin.json");
  if (fs.existsSync(manifest)) return true;
  if (!fs.existsSync(qqbotPayloadZip)) return false;

  const tmpDir = path.join(path.dirname(qqbotPayloadZip), `_qqbot-extract-${process.pid}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    const tarExecutable = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const result = spawnSync(tarExecutable, ["-xf", qqbotPayloadZip, "-C", tmpDir], { windowsHide: true, timeout: 900000 });
    if (result.status !== 0) throw new Error("QQBot 依赖解压失败: " + (result.stderr || result.status));
    const sourceNodeModules = path.join(tmpDir, "node_modules");
    if (!fs.existsSync(path.join(sourceNodeModules, "@openclaw", "qqbot", "openclaw.plugin.json"))) {
      throw new Error("QQBot 压缩包内容不完整");
    }
    fs.mkdirSync(projectDir, { recursive: true });
    fs.cpSync(sourceNodeModules, targetNodeModules, { recursive: true, force: true });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }
  }
  return fs.existsSync(manifest);
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
  ensureQQBotDependencyPayload,
  findQQBotConnectorEntry,
  findQQBotPluginPaths,
  moduleEntryPath,
};

/**
 * 路径解析：产品根目录固定为可执行文件所在目录（U 盘根目录）。
 * 用户数据全部写在产品根目录的 data/ 下，随 U 盘插拔整体迁移；
 * openclaw 模块缓存解压到本机磁盘，U 盘只保留一份压缩包。
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { app } = require("electron");

let cached = null;

/**
 * 产品根目录：运行期文件都写在这里的 data/ 下，随 U 盘插拔迁移。
 * - 便携自解压运行时由 PORTABLE_EXECUTABLE_DIR 指定；
 * - Windows 目录分发：可执行文件所在目录（zgyclaw 文件夹）；
 * - macOS：可执行文件在 App.app/Contents/MacOS/ 里，根目录要取 App 所在的那一层，
 *   这样 data/ 与 App 并列（对应 Windows 的 zgyclaw/data/），而不是被写进 App 包内部。
 */
function resolveProductRoot() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (portableDir) return path.resolve(portableDir);
  if (!app.isPackaged) return path.resolve(__dirname, "..", "..");
  const exeDir = path.dirname(app.getPath("exe"));
  if (process.platform === "darwin") return path.resolve(exeDir, "..", "..", "..");
  return exeDir;
}

/** 模块缓存根目录：Windows 放本地应用数据，macOS 放用户应用支持目录。 */
function resolveLocalCacheRoot() {
  if (process.platform === "win32") {
    const base = String(process.env.LOCALAPPDATA || "").trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "ZgyClaw", "cache");
  }
  return path.join(app.getPath("userData"), "cache");
}

/**
 * 模块缓存键：按模块压缩包自身（大小 + 修改时间）算，不按 exe 所在路径算。
 * 这样同一台机器上换盘符、换 USB 口、改程序文件夹名都命中同一份缓存，不会把几十秒的解压重做一遍；
 * 换了新的模块包（重新打包过）则大小/时间必然变化，自动用新缓存，不会串用旧树。
 * 压缩包不在时退化成一个固定键：反正这时也解不出东西，解压会明确报错。
 */
function modulesCacheKey(archivePath) {
  let identity = "payload-missing";
  try {
    const stat = fs.statSync(archivePath);
    identity = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch { /* 压缩包缺失：用固定键占位，解压时会给明确错误 */ }
  return crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function build() {
  const productRoot = resolveProductRoot();
  
  // 数据目录统一放在 U 盘根目录的 zgy-data，Windows 和 macOS 共享。
  // macOS: productRoot 已经是 .app 的父目录（U 盘根目录）
  // Windows: productRoot 是 zgyclaw/ 目录，父目录才是 U 盘根
  const usbRoot = process.platform === "win32" ? path.resolve(productRoot, "..") : productRoot;
  const dataDir = path.join(usbRoot, "zgy-data");
  const stateDir = path.join(dataDir, ".openclaw");
  // 打包后资源目录用 Electron 给的 process.resourcesPath：
  // Windows 目录分发下它就是 <安装目录>/resources（与按可执行文件目录推导等价），
  // macOS 下是 App.app/Contents/Resources——按可执行文件所在目录去找会落在 Contents/MacOS 里，找不到 app.asar 与 extraResources。
  // 开发模式资源位于工程根目录的 resources/。
  const resourcesDir = app.isPackaged
    ? process.resourcesPath
    : path.join(productRoot, "resources");
  const payloadDir = path.join(resourcesDir, "payload");
  const payloadArchive = path.join(payloadDir, "openclaw-modules.tar.gz");
  const cacheKey = modulesCacheKey(payloadArchive);
  return {
    productRoot,
    dataDir,
    stateDir,
    logsDir: path.join(stateDir, "logs"),
    npmProjectsDir: path.join(dataDir, "npm", "projects"),
    resourcesDir,
    configPath: path.join(stateDir, "openclaw.json"),
    dingtalkChannelConfigPath: path.join(dataDir, "dingtalk-channel.json"),
    modulesCacheDir: path.join(resolveLocalCacheRoot(), cacheKey, "node_modules"),
    // 按需安装的 payload 包目录（登记表见 services/modules.js 的 PAYLOADS）。
    payloadDir,
    payloadArchive,
    pluginsDir: path.join(resourcesDir, "plugins"),
    bridgeDir: path.join(resourcesDir, "bridge"),
    updateDir: path.join(dataDir, "update"),
    // 授权文件与其它运行期文件统一放在 data 下；根目录旧文件在首次读取时自动迁移。
    licensePath: path.join(dataDir, "license.json"),
    legacyLicensePath: path.join(productRoot, "license.dat"),
    executablePath: process.env.PORTABLE_EXECUTABLE_FILE || app.getPath("exe"),
    isPackaged: app.isPackaged,
  };
}

/** 全局路径快照，进程生命周期内只解析一次。 */
function getPaths() {
  if (!cached) cached = build();
  return cached;
}

module.exports = { getPaths };

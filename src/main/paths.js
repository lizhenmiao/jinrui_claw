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

/** portable 包运行时由自解压器注入 PORTABLE_EXECUTABLE_DIR，开发模式回落到工程根目录。 */
function resolveProductRoot() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (portableDir) return path.resolve(portableDir);
  if (app.isPackaged) return path.dirname(app.getPath("exe"));
  return path.resolve(__dirname, "..", "..");
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
  const dataDir = path.join(productRoot, "data");
  const stateDir = path.join(dataDir, ".openclaw");
  // electron-builder extraResources 落在 <安装目录>/resources/；
  // portable 自解压临时目录里的 process.resourcesPath 同样指向该层级。
  // 开发模式资源位于工程根目录的 resources/。
  const resourcesDir = app.isPackaged
    ? path.resolve(path.dirname(app.getPath("exe")), "resources")
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

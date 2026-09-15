/**
 * 路径解析：产品根目录固定为可执行文件所在目录（U 盘根目录）。
 * 用户数据全部写在产品根目录的 data/ 下，随 U 盘插拔整体迁移；
 * openclaw 模块缓存解压到本机磁盘，U 盘只保留一份压缩包。
 */
const os = require("os");
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
  const cacheKey = crypto.createHash("sha256").update(productRoot.toLowerCase()).digest("hex").slice(0, 16);
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
    payloadDir: path.join(resourcesDir, "payload"),
    payloadArchive: path.join(resourcesDir, "payload", "openclaw-modules.tar.gz"),
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

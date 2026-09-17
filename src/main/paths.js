/**
 * 路径解析：产品根目录固定为可执行文件所在目录，运行期数据根目录另行解析为实际存储卷根。
 * 用户数据全部写在 U 盘根目录的 zgy-data/ 下，随 U 盘插拔整体迁移；
 * openclaw 模块缓存解压到本机磁盘，U 盘只保留一份压缩包。
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { app } = require("electron");
const timing = require("../shared/timing.json");

let cached = null;

/**
 * 产品根目录：资源与可执行文件所在目录，运行期数据目录不直接依赖这一层级。
 * - 便携自解压运行时由 PORTABLE_EXECUTABLE_DIR 指定；
 * - Windows 目录分发：可执行文件所在目录（zgyclaw 文件夹）；
 * - macOS：可执行文件在 App.app/Contents/MacOS/ 里，根目录要取 App 所在的那一层，
 *   这样可以从 App 路径继续解析所在 U 盘卷，而不是把运行期文件写进 App 包内部。
 */
function resolveProductRoot() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || "").trim();
  if (portableDir) return path.resolve(portableDir);
  if (!app.isPackaged) return path.resolve(__dirname, "..", "..");
  const exeDir = path.dirname(app.getPath("exe"));
  if (process.platform === "darwin") return path.resolve(exeDir, "..", "..", "..");
  return exeDir;
}

/** 判断 Windows 程序所在盘符是否为可移动或 USB 磁盘，避免本地测试时把数据写到 C:\\zgy-data。 */
function isRemovableWindowsDrive(root) {
  const drive = String(root || "").replace(/[\\/]+$/, "");
  if (!drive) return false;
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$drive = '${drive.replace(/'/g, "''")}'
$logical = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$drive'"
$partition = $null
$disk = $null
if ($logical) {
  $partition = Get-CimAssociatedInstance -InputObject $logical -Association Win32_LogicalDiskToPartition | Select-Object -First 1
}
if ($partition) {
  $disk = Get-CimAssociatedInstance -InputObject $partition -Association Win32_DiskDriveToDiskPartition | Select-Object -First 1
}
if ($logical -and $logical.DriveType -eq 2) { 'USB' }
elseif ($disk -and ($disk.InterfaceType -eq 'USB' -or $disk.PNPDeviceID -like 'USB*')) { 'USB' }
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: timing.paths.windowsDriveTypeTimeoutMs,
      windowsHide: true,
    });
    return output.trim() === "USB";
  } catch {
    return false;
  }
}

/** 解析 macOS 程序所在的实际卷根目录，支持 App 位于卷内任意子目录。 */
function resolveMacVolumeRoot(productRoot) {
  const resolved = path.resolve(productRoot);
  const volumePrefix = `${path.sep}Volumes${path.sep}`;
  if (!resolved.startsWith(volumePrefix)) return resolved;
  const volumeName = resolved.slice(volumePrefix.length).split(path.sep)[0];
  return volumeName ? path.join(path.sep, "Volumes", volumeName) : resolved;
}

/** 解析运行期数据根目录：U 盘使用物理卷根，本地测试保留在发行目录旁边。 */
function resolveDataRoot(productRoot) {
  const resolved = path.resolve(productRoot);
  if (!app.isPackaged) return resolved;
  if (process.platform === "win32") {
    const volumeRoot = path.parse(resolved).root;
    return isRemovableWindowsDrive(volumeRoot) ? volumeRoot : path.resolve(resolved, "..");
  }
  if (process.platform === "darwin") return resolveMacVolumeRoot(resolved);
  return resolved;
}

/** 找出旧发行目录中的运行期数据目录，供首次升级时迁移到 U 盘根目录。 */
function legacyDataDirectories(productRoot, dataDir) {
  const candidates = [
    path.join(productRoot, "data"),
    path.join(productRoot, "zgy-data"),
    ...(process.platform === "win32" ? [path.resolve(productRoot, "..", "zgy-data")] : []),
  ];
  const target = path.normalize(dataDir);
  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))].filter((candidate) => candidate !== target);
}

/** 把旧数据目录原子移动到新的 U 盘根目录，失败时保留原目录等待人工处理。 */
function migrateLegacyData(dataDir, candidates) {
  if (fs.existsSync(dataDir)) return;
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) return;
  try {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    fs.renameSync(source, dataDir);
  } catch {
    // 迁移失败不删除旧目录，启动链会在新目录给出明确的写入或授权提示。
  }
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

/** 组装产品、数据、资源、插件与授权文件的完整路径快照。 */
function build() {
  const productRoot = resolveProductRoot();
  // 数据目录统一放在实际存储卷根目录的 zgy-data，Windows 和 macOS 共享。
  const usbRoot = resolveDataRoot(productRoot);
  const dataDir = path.join(usbRoot, "zgy-data");
  migrateLegacyData(dataDir, legacyDataDirectories(productRoot, dataDir));
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
    // 授权文件与其它运行期文件统一放在 zgy-data 下；旧目录在首次解析路径时自动迁移。
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

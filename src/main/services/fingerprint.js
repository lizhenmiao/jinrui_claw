/**
 * U 盘设备指纹：读取跨平台共用的 USB 硬件序列号，哈希出设备指纹，供授权绑定与后台设备上报使用；
 * 本机标识（machineId）同样在这里推导，用于后台区分"哪台电脑"。
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { getPaths } = require("../paths");
const timing = require("../../shared/timing.json");

// 产品级盐值：用于把硬件序列号转换成不直接外传原值的本地指纹。
const PRODUCT_SALT = "zgy-openclaw-portable-v1";
// 系统返回的占位序列号：这些值不代表真实 USB 硬件身份，不能参与授权绑定。
const SERIAL_PLACEHOLDERS = new Set(["UNKNOWN", "UNAVAILABLE", "NOTSUPPORTED", "NOTAVAILABLE", "NOTAPPLICABLE", "NOTFOUND", "NONE", "NULL", "NA", "N/A"]);

/** 遮盖授权指纹的中间部分，供界面和命令行展示。 */
function mask(value, keepStart = 6, keepEnd = 6) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= keepStart + keepEnd) return `${text.slice(0, 2)}****`;
  return `${text.slice(0, keepStart)}****${text.slice(-keepEnd)}`;
}

/** 清理系统返回的序列号格式，使 Windows 与 macOS 使用相同的比较值。 */
function normalizeSerial(value) {
  return String(value || "").replace(/[^0-9a-z]/gi, "").toUpperCase();
}

/** 判断清理后的序列号是否确实能代表一块 USB 硬件。 */
function usableSerial(value) {
  const serial = normalizeSerial(value);
  if (!serial || /^0+$/.test(serial) || /^F+$/.test(serial) || SERIAL_PLACEHOLDERS.has(serial)) return "";
  return serial;
}

/** 返回无法读取 USB 硬件序列号时的统一处理提示。 */
function usbSerialUnavailableMessage() {
  return "无法读取 U 盘硬件序列号，请确认程序是从 U 盘启动，并更换一个能提供 USB 序列号的 U 盘后重试。";
}

/** 取 macOS USB 设备名称的可比较形式，用于把挂载卷映射到物理 USB 设备。 */
function normalizeLabel(value) {
  return String(value || "").toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/gi, "");
}

/** 从 system_profiler 的嵌套 JSON 中收集带硬件序列号的 USB 设备。 */
function collectMacUsbDevices(value, devices = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectMacUsbDevices(item, devices);
    return devices;
  }
  if (!value || typeof value !== "object") return devices;

  const serial = value.serial_num || value.serialNumber || value.usb_serial_number || value["USB Serial Number"] || value.kUSBSerialNumberString;
  if (serial) {
    devices.push({
      serial,
      labels: [value._name, value.name, value.product_name, value.product, value.bsd_name, value.bsdName, value.device_node, value.deviceNode],
    });
  }
  for (const child of Object.values(value)) collectMacUsbDevices(child, devices);
  return devices;
}

/** 从 macOS USB 设备列表中选择与当前挂载卷对应的硬件序列号。 */
function readMacUsbSerial(mediaName, diskNode) {
  try {
    const stdout = execFileSync("system_profiler", ["SPUSBDataType", "-json"], { encoding: "utf8", timeout: timing.fingerprint.macSystemProfilerTimeoutMs });
    const devices = collectMacUsbDevices(JSON.parse(stdout || "{}"))
      .map((device) => ({ ...device, serial: usableSerial(device.serial) }))
      .filter((device) => device.serial);
    if (!devices.length) return "";

    const normalizedMediaName = normalizeLabel(mediaName);
    const normalizedDiskNode = normalizeLabel(diskNode);
    const ranked = devices.map((device) => {
      const labels = device.labels.map(normalizeLabel).filter(Boolean);
      let score = 0;
      if (normalizedDiskNode && labels.some((label) => label === normalizedDiskNode || label.includes(normalizedDiskNode))) score = Math.max(score, 10);
      if (normalizedMediaName && labels.some((label) => label === normalizedMediaName || label.includes(normalizedMediaName) || normalizedMediaName.includes(label))) score = Math.max(score, 6);
      return { ...device, score };
    });
    const matched = ranked.filter((device) => device.score > 0).sort((left, right) => right.score - left.score);
    if (matched.length) {
      const highestScore = matched[0].score;
      const highest = matched.filter((device) => device.score === highestScore);
      return highest.length === 1 ? highest[0].serial : "";
    }
    return devices.length === 1 ? devices[0].serial : "";
  } catch {
    return "";
  }
}

/** 取程序所在存储卷的根路径；macOS 必须保留 /Volumes/卷名，不能退化成系统根目录。 */
function driveRoot(inputRoot) {
  const resolved = path.resolve(inputRoot || getPaths().productRoot);
  if (process.platform === "darwin") {
    const volumePrefix = `${path.sep}Volumes${path.sep}`;
    if (resolved.startsWith(volumePrefix)) {
      const volumeName = resolved.slice(volumePrefix.length).split(path.sep)[0];
      if (volumeName) return path.join(path.sep, "Volumes", volumeName);
    }
    return resolved;
  }
  const parsed = path.parse(resolved);
  return parsed.root.replace(/[\\/]+$/, "");
}

/** Windows 卷信息：优先 PowerShell CIM 完整信息，失败回落 cmd vol 的卷序列号。 */
function readWindowsDriveInfo(drive) {
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
[pscustomobject]@{
  volumeSerial = if ($logical) { $logical.VolumeSerialNumber } else { '' }
  volumeName = if ($logical) { $logical.VolumeName } else { '' }
  fileSystem = if ($logical) { $logical.FileSystem } else { '' }
  driveType = if ($logical) { [string]$logical.DriveType } else { '' }
  diskSerial = if ($disk) { ($disk.SerialNumber -replace '^\\s+|\\s+$','') } else { '' }
  model = if ($disk) { $disk.Model } else { '' }
} | ConvertTo-Json -Compress
`;
  const fallback = () => {
    try {
      return execFileSync("cmd.exe", ["/d", "/s", "/c", `vol ${drive}`], { encoding: "utf8", timeout: timing.fingerprint.windowsVolumeTimeoutMs, windowsHide: true });
    } catch {
      return "";
    }
  };
  try {
    const stdout = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: timing.fingerprint.windowsPowerShellTimeoutMs,
      windowsHide: true,
    }).trim();
    const parsed = JSON.parse(stdout || "{}");
    if (!parsed.volumeSerial) {
      const match = fallback().match(/([0-9A-F]{4}-[0-9A-F]{4})/i);
      parsed.volumeSerial = match ? match[1].replace("-", "") : "";
    }
    return parsed;
  } catch {
    const match = fallback().match(/([0-9A-F]{4}-[0-9A-F]{4})/i);
    return { volumeSerial: match ? match[1].replace("-", "") : "" };
  }
}

/** macOS 卷信息：从程序所在挂载卷定位物理 USB 设备，再读取其硬件序列号。 */
function readMacDriveInfo(volumePath) {
  try {
    // diskutil 直接接受挂载卷内的路径，可正确解析嵌套在 U 盘目录中的应用。
    const infoStdout = execFileSync("diskutil", ["info", volumePath], { encoding: "utf8", timeout: timing.fingerprint.macDiskutilTimeoutMs });
    const volumeUUID = (infoStdout.match(/Volume UUID:\s*(\S+)/i) || [])[1] || "";
    const volumeName = (infoStdout.match(/Volume Name:\s*(.+)\r?\n/i) || [])[1] || "";
    const mediaName = (infoStdout.match(/Device \/ Media Name:\s*(.+)\r?\n/i) || [])[1] || "";
    const fileSystem = (infoStdout.match(/Type \(Bundle\):\s*(\S+)/i) || [])[1] || "";
    const deviceNode = (infoStdout.match(/Device Node:\s*(\S+)/i) || [])[1] || "";

    const diskNode = deviceNode.replace(/s\d+$/, "");
    const diskSerial = readMacUsbSerial(mediaName, diskNode);
    return { 
      volumeSerial: volumeUUID, 
      diskSerial, 
      volumeName: volumeName.trim(), 
      mediaName: mediaName.trim(),
      fileSystem 
    };
  } catch {
    return { volumeSerial: "", diskSerial: "" };
  }
}

let cachedDriveInfo = null;
/**
 * 读取 U 盘信息。Windows 下要起一次 PowerShell，所以进程生命周期内只读一次并缓存：
 * 拔盘会直接退出应用，不存在读到过期值的场景。
 */
function readDriveInfo() {
  if (cachedDriveInfo) return cachedDriveInfo;
  const productRoot = getPaths().productRoot;
  const root = driveRoot(productRoot);
  if (process.platform === "win32") {
    cachedDriveInfo = { platform: "win32", root, ...readWindowsDriveInfo(root) };
  } else if (process.platform === "darwin") {
    cachedDriveInfo = { platform: "darwin", root, ...readMacDriveInfo(productRoot) };
  } else {
    cachedDriveInfo = { platform: process.platform, root, volumeSerial: "" };
  }
  return cachedDriveInfo;
}

/** 规范化设备身份：只使用跨平台共用的 USB 硬件序列号，不使用平台各自的卷 UUID。 */
function canonicalDriveIdentity(info) {
  return {
    usbId: usableSerial(info.diskSerial),
  };
}

/** 计算当前 U 盘的设备指纹；没有硬件序列号时返回不可绑定状态。 */
function getFingerprint() {
  const info = readDriveInfo();
  const identity = canonicalDriveIdentity(info);
  if (!identity.usbId) return { fingerprint: "", info, identity, maskedFingerprint: "", available: false };
  const fingerprint = crypto
    .createHash("sha256")
    .update(PRODUCT_SALT)
    .update("\n")
    .update(JSON.stringify(identity))
    .digest("hex");
  return { fingerprint, info, identity, maskedFingerprint: mask(fingerprint), available: true };
}

/** 后台设备 ID：Windows 与 macOS 统一使用同一硬件序列号命名空间。 */
function getUsbId() {
  const identity = canonicalDriveIdentity(readDriveInfo());
  return identity.usbId ? `USB-${identity.usbId}` : "";
}

/**
 * 本机稳定身份源：Windows 取注册表 MachineGuid（装一次系统就固定）、macOS 取 IOPlatformUUID（主板级唯一）、Linux 取 /etc/machine-id。
 * 读不到时返回空串，由调用方回落。
 */
function readMachineIdentity() {
  try {
    if (process.platform === "win32") {
      const stdout = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: timing.fingerprint.windowsMachineGuidTimeoutMs,
        windowsHide: true,
      });
      return (stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/i) || [])[1] || "";
    }
    if (process.platform === "darwin") {
      const stdout = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: timing.fingerprint.macMachineUuidTimeoutMs });
      return (stdout.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/) || [])[1] || "";
    }
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try {
        const value = fs.readFileSync(file, "utf8").trim();
        if (value) return value;
      } catch { /* 换下一个候选文件 */ }
    }
    return "";
  } catch {
    return "";
  }
}

let cachedMachineId = "";
/**
 * 后台上报用的本机标识：盐 + 操作系统稳定身份的 SHA-256 摘要（不外传注册表/主板原值）。
 * 确定性推导是关键——恢复出厂设置、删掉 data 目录都算回同一个 ID，后台设备记录才不会把同一台机器记成好几台。
 * 身份源读不到时用上次缓存的值（machine-id.txt），再退一步才用主机名等信息拼，避免个别机器读注册表失败导致每次启动换一个 ID。
 */
function getMachineId() {
  if (cachedMachineId) return cachedMachineId;
  const file = path.join(getPaths().stateDir, "machine-id.txt");
  const identity = readMachineIdentity();
  if (identity) {
    cachedMachineId = `MACHINE-${crypto.createHash("sha256")
      .update(PRODUCT_SALT).update("\n").update(process.platform).update("\n").update(identity)
      .digest("hex").slice(0, 24).toUpperCase()}`;
  } else {
    let stored = "";
    try { stored = fs.readFileSync(file, "utf8").trim(); } catch { /* 首次或已被清空 */ }
    cachedMachineId = stored || `MACHINE-${crypto.createHash("sha256")
      .update(PRODUCT_SALT).update("\n").update([os.hostname(), os.userInfo().username, process.platform, process.arch].join("|"))
      .digest("hex").slice(0, 24).toUpperCase()}`;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedMachineId + "\n", "utf8");
  } catch { /* 缓存写不进去不影响本次上报 */ }
  return cachedMachineId;
}

module.exports = { getDriveInfo: readDriveInfo, getFingerprint, getMachineId, getUsbId, mask, usbSerialUnavailableMessage };

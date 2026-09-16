/**
 * U 盘设备指纹：以卷序列号（Windows）或卷 UUID（macOS）为稳定身份源，哈希出设备指纹，供授权绑定与后台设备上报使用；
 * 本机标识（machineId）同样在这里推导，用于后台区分"哪台电脑"。
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { getPaths } = require("../paths");

const PRODUCT_SALT = "zgy-openclaw-portable-v1";

function mask(value, keepStart = 6, keepEnd = 6) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= keepStart + keepEnd) return `${text.slice(0, 2)}****`;
  return `${text.slice(0, keepStart)}****${text.slice(-keepEnd)}`;
}

function normalizeSerial(value) {
  return String(value || "").replace(/[^0-9a-z]/gi, "").toUpperCase();
}

function driveRoot(inputRoot) {
  const parsed = path.parse(path.resolve(inputRoot || getPaths().productRoot));
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
      return execFileSync("cmd.exe", ["/d", "/s", "/c", `vol ${drive}`], { encoding: "utf8", timeout: 3000, windowsHide: true });
    } catch {
      return "";
    }
  };
  try {
    const stdout = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      encoding: "utf8",
      timeout: 6000,
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

/** macOS 卷信息：diskutil 的 VolumeUUID 跨机器稳定，作为卷身份。 */
function readMacDriveInfo(mountRoot) {
  try {
    const stdout = execFileSync("diskutil", ["info", mountRoot], { encoding: "utf8", timeout: 5000 });
    const uuid = (stdout.match(/Volume UUID:\s*(\S+)/i) || [])[1] || "";
    const name = (stdout.match(/Volume Name:\s*(.+)\r?\n/i) || [])[1] || "";
    const fileSystem = (stdout.match(/Type \(Bundle\):\s*(\S+)/i) || [])[1] || "";
    return { volumeSerial: uuid, volumeName: name.trim(), fileSystem };
  } catch {
    return { volumeSerial: "" };
  }
}

let cachedDriveInfo = null;
/**
 * 读取 U 盘信息。Windows 下要起一次 PowerShell，所以进程生命周期内只读一次并缓存：
 * 拔盘会直接退出应用，不存在读到过期值的场景。
 */
function readDriveInfo() {
  if (cachedDriveInfo) return cachedDriveInfo;
  const root = driveRoot();
  if (process.platform === "win32") {
    cachedDriveInfo = { platform: "win32", root, ...readWindowsDriveInfo(root) };
  } else if (process.platform === "darwin") {
    cachedDriveInfo = { platform: "darwin", root, ...readMacDriveInfo(root.endsWith(":") ? root : root || "/") };
  } else {
    cachedDriveInfo = { platform: process.platform, root, volumeSerial: "" };
  }
  return cachedDriveInfo;
}

function canonicalDriveIdentity(info) {
  const volumeSerial = normalizeSerial(info.volumeSerial);
  return {
    platform: info.platform || process.platform,
    volumeSerial,
    diskSerial: volumeSerial ? "" : normalizeSerial(info.diskSerial),
  };
}

/** 计算当前 U 盘的设备指纹（盐 + 规范化身份 JSON 的 SHA-256）。 */
function getFingerprint() {
  const info = readDriveInfo();
  const identity = canonicalDriveIdentity(info);
  const fingerprint = crypto
    .createHash("sha256")
    .update(PRODUCT_SALT)
    .update("\n")
    .update(JSON.stringify(identity))
    .digest("hex");
  return { fingerprint, info, identity, maskedFingerprint: mask(fingerprint) };
}

/** 后台设备 ID：Windows 使用 WINVOL 前缀兼容既有后台约定，其余平台 MACVOL。 */
function getUsbId() {
  const info = readDriveInfo();
  const serial = normalizeSerial(info.volumeSerial);
  const prefix = process.platform === "win32" ? "WINVOL" : "MACVOL";
  if (serial) return `${prefix}-${serial}`;
  return `DEV-${crypto.createHash("sha256").update(driveRoot()).digest("hex").slice(0, 16).toUpperCase()}`;
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
        timeout: 4000,
        windowsHide: true,
      });
      return (stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/i) || [])[1] || "";
    }
    if (process.platform === "darwin") {
      const stdout = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000 });
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

module.exports = { getDriveInfo: readDriveInfo, getFingerprint, getMachineId, getUsbId, mask };

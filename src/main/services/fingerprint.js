/**
 * U 盘设备指纹：以卷序列号（Windows）或卷 UUID（macOS）为稳定身份源，
 * 哈希出设备指纹，供授权绑定与后台设备上报使用。
 */
const crypto = require("crypto");
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
/** 读取 U 盘信息；Windows 下要起 PowerShell，进程生命周期内缓存一份（拔盘即退出应用，不会读到旧值）。 */
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

module.exports = { getDriveInfo: readDriveInfo, getFingerprint, getUsbId, mask };

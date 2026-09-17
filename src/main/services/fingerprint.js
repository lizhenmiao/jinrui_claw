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

/** 
 * macOS 卷信息：优先读物理磁盘序列号（硬件级唯一 ID，跨平台稳定），
 * 退而求其次才用 Volume UUID（文件系统级，某些格式如 FAT32 可能不稳定）。
 */
function readMacDriveInfo(mountRoot) {
  try {
    // 先用 diskutil info 拿到设备节点（如 /dev/disk2s1）和基本信息
    const infoStdout = execFileSync("diskutil", ["info", mountRoot], { encoding: "utf8", timeout: 5000 });
    const volumeUUID = (infoStdout.match(/Volume UUID:\s*(\S+)/i) || [])[1] || "";
    const volumeName = (infoStdout.match(/Volume Name:\s*(.+)\r?\n/i) || [])[1] || "";
    const fileSystem = (infoStdout.match(/Type \(Bundle\):\s*(\S+)/i) || [])[1] || "";
    const deviceNode = (infoStdout.match(/Device Node:\s*(\S+)/i) || [])[1] || "";
    
    // 尝试读物理磁盘的序列号（从分区节点 /dev/disk2s1 推到磁盘 /dev/disk2）
    let diskSerial = "";
    if (deviceNode) {
      try {
        const diskNode = deviceNode.replace(/s\d+$/, "");  // /dev/disk2s1 → /dev/disk2
        const listStdout = execFileSync("diskutil", ["info", diskNode], { encoding: "utf8", timeout: 5000 });
        // macOS 的 diskutil 在磁盘级别有 "Device / Media Name" 或 "Disk / Partition UUID"
        // 但最稳定的是物理设备的 IORegistry 属性，我们用 "Media UUID" 或 "Disk UUID"
        const mediaUUID = (listStdout.match(/Media UUID:\s*(\S+)/i) || [])[1] || "";
        const diskUUID = (listStdout.match(/Disk \/ Partition UUID:\s*(\S+)/i) || [])[1] || "";
        diskSerial = mediaUUID || diskUUID;
        
        // 如果 diskutil 拿不到，尝试 system_profiler（更慢但更全）
        if (!diskSerial) {
          try {
            const usbStdout = execFileSync("system_profiler", ["SPUSBDataType", "-detailLevel", "mini"], { 
              encoding: "utf8", 
              timeout: 8000 
            });
            // 找到卷名对应的 USB 设备块，提取 Serial Number
            const volumeBlock = usbStdout.split(/\n\s{2,4}\S/).find((block) => 
              block.includes(volumeName.trim()) || block.includes(diskNode)
            );
            if (volumeBlock) {
              diskSerial = (volumeBlock.match(/Serial Number:\s*(\S+)/i) || [])[1] || "";
            }
          } catch { /* system_profiler 超时或失败，继续用 UUID */ }
        }
      } catch { /* 读磁盘级信息失败，继续用卷 UUID */ }
    }
    
    return { 
      volumeSerial: volumeUUID, 
      diskSerial, 
      volumeName: volumeName.trim(), 
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

/**
 * 规范化设备身份：优先用物理磁盘序列号（真正的 U 盘硬件 ID，跨平台稳定），
 * 没有才用卷序列号（文件系统级，可能因格式化而变）。
 * 不再区分 platform，只用 U 盘的唯一标识，这样同一 U 盘在 Windows 和 macOS 上算出的指纹一致。
 */
function canonicalDriveIdentity(info) {
  const diskSerial = normalizeSerial(info.diskSerial);
  const volumeSerial = normalizeSerial(info.volumeSerial);
  
  return {
    // 优先物理序列号，没有才用卷序列号
    usbId: diskSerial || volumeSerial || "",
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

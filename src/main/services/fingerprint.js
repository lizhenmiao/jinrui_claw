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
const { appendLogLine } = require("./logs");
const diagnostics = require("./diagnostics");

/** 记录身份查询命令的原始输出和耗时，失败时也保留系统返回的错误。 */
function runIdentityCommand(command, args, options) {
  const started = Date.now();
  try {
    const stdout = execFileSync(command, args, options);
    diagnostics.commandResult(command, args, stdout, "", null, Date.now() - started);
    return stdout;
  } catch (error) {
    diagnostics.commandResult(command, args, error.stdout, error.stderr, error, Date.now() - started);
    throw error;
  }
}

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
  return "未能确认当前 U 盘的硬件身份。请确认程序位于 U 盘内并重新插入后点重试；已有授权无需重新绑定，可查看 fingerprint.log 排查识别原因。";
}

/** 沿 IOService 树将 BSD 磁盘名定位到最近的 USB 设备，禁止使用旁边设备或上层 Hub 的序列号。 */
function selectMacUsbSerial(output, diskNode) {
  // 栈保存当前节点的祖先链；同名型号、多层转接和枚举顺序都不参与身份选择。
  const stack = [];
  const matches = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const node = line.match(/^([ |]*)\+-o\s+(.+?)\s+<class\s+([^,>]+)/);
    if (node) {
      const depth = node[1].length;
      while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ depth, usb: /(?:^|:)(?:IOUSBHostDevice|IOUSBDevice)$/.test(node[3]), serial: "", deviceClass: "" });
      continue;
    }
    const current = stack[stack.length - 1];
    if (!current) continue;
    const serial = line.match(/^[ |]*"(?:USB Serial Number|kUSBSerialNumberString)"\s*=\s*"([^"]*)"/);
    if (serial) current.serial = usableSerial(serial[1]);
    const deviceClass = line.match(/^[ |]*"bDeviceClass"\s*=\s*(\d+)/);
    if (deviceClass) current.deviceClass = deviceClass[1];
    const bsd = line.match(/^[ |]*"BSD Name"\s*=\s*"([^"]+)"/);
    if (!bsd || bsd[1] !== diskNode) continue;
    const device = [...stack].reverse().find((entry) => entry.usb);
    matches.push(device && !["9", "17"].includes(device.deviceClass) ? device.serial : "");
  }
  return matches.length === 1 ? matches[0] : "";
}

/** 读取包含磁盘父子关系的 IOService 树，只查询当前物理磁盘的 USB 身份。 */
function readMacUsbSerial(diskNode) {
  // 完整 IOService 树可能超过 Node 默认的 1 MiB 输出上限。
  const registryMaxBytes = 32 * 1024 * 1024;
  const output = runIdentityCommand("ioreg", ["-p", "IOService", "-l", "-w", "0"], {
    encoding: "utf8", timeout: timing.fingerprint.macIoregTimeoutMs, maxBuffer: registryMaxBytes,
  });
  return selectMacUsbSerial(output, diskNode);
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
      return runIdentityCommand("cmd.exe", ["/d", "/s", "/c", `vol ${drive}`], { encoding: "utf8", timeout: timing.fingerprint.windowsVolumeTimeoutMs, windowsHide: true });
    } catch {
      return "";
    }
  };
  try {
    const stdout = runIdentityCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
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
    // 查询挂载卷根目录，避免把嵌套应用目录或 Mac 系统根目录当成存储卷。
    const infoStdout = runIdentityCommand("diskutil", ["info", volumePath], { encoding: "utf8", timeout: timing.fingerprint.macDiskutilTimeoutMs });
    const volumeUUID = (infoStdout.match(/Volume UUID:\s*(\S+)/i) || [])[1] || "";
    const volumeName = (infoStdout.match(/Volume Name:\s*(.+)\r?\n/i) || [])[1] || "";
    let mediaName = (infoStdout.match(/Device \/ Media Name:\s*(.+)\r?\n/i) || [])[1] || "";
    const fileSystem = (infoStdout.match(/Type \(Bundle\):\s*(\S+)/i) || [])[1] || "";
    const deviceNode = (infoStdout.match(/Device Node:\s*(\S+)/i) || [])[1] || "";

    const diskNode = (infoStdout.match(/Part of Whole:\s*(disk\d+)/i) || [])[1] || deviceNode.replace(/^\/dev\//, "").replace(/(?:s\d+)+$/, "");
    if (!/^disk\d+$/.test(diskNode)) throw new Error("无法定位当前卷所属的物理磁盘");
    if (!mediaName && diskNode) {
      try {
        const diskInfoStdout = runIdentityCommand("diskutil", ["info", `/dev/${diskNode}`], { encoding: "utf8", timeout: timing.fingerprint.macDiskutilTimeoutMs });
        mediaName = (diskInfoStdout.match(/Device \/ Media Name:\s*(.+)\r?\n/i) || [])[1] || "";
      } catch {
        // 媒体名称只用于诊断，不影响按 BSD 磁盘节点关联 USB 设备。
      }
    }
    const diskSerial = readMacUsbSerial(diskNode);
    appendLogLine("fingerprint.log", `mac volume=${volumePath} device=${deviceNode} whole=${diskNode} source=IOService serial=${mask(diskSerial)} result=${diskSerial ? "matched" : "unresolved"}`);
    return { 
      volumeSerial: volumeUUID, 
      diskSerial, 
      volumeName: volumeName.trim(), 
      mediaName: mediaName.trim(),
      fileSystem 
    };
  } catch (error) {
    appendLogLine("fingerprint.log", `mac volume=${volumePath} identification failed: ${error.message}`);
    return { volumeSerial: "", diskSerial: "" };
  }
}

let cachedDriveInfo = null;
/**
 * 读取 U 盘信息，成功识别后在进程生命周期内缓存；失败不缓存，允许重试重新探测。
 * 拔盘会直接退出应用，不存在成功缓存跨 U 盘复用的场景。
 */
function readDriveInfo() {
  if (cachedDriveInfo?.diskSerial) return cachedDriveInfo;
  const productRoot = getPaths().productRoot;
  const root = driveRoot(productRoot);
  if (process.platform === "win32") {
    cachedDriveInfo = { platform: "win32", root, ...readWindowsDriveInfo(root) };
  } else if (process.platform === "darwin") {
    cachedDriveInfo = { platform: "darwin", root, ...readMacDriveInfo(root) };
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
      const stdout = runIdentityCommand("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], {
        encoding: "utf8",
        timeout: timing.fingerprint.windowsMachineGuidTimeoutMs,
        windowsHide: true,
      });
      return (stdout.match(/MachineGuid\s+REG_SZ\s+(\S+)/i) || [])[1] || "";
    }
    if (process.platform === "darwin") {
      const stdout = runIdentityCommand("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: timing.fingerprint.macMachineUuidTimeoutMs });
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

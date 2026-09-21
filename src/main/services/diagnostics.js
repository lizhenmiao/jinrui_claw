/** 跨机器诊断：每次启动单独归档到 U 盘，记录身份、模块、进程与错误并过滤凭据。 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const zlib = require("zlib");
const { execFile } = require("child_process");
const { getPaths } = require("../paths");
const timing = require("../../shared/timing.json");

// 会话目录首次写入时创建，启动早期异常也会留下独立记录。
let sessionDirectory = "";
let sessionStarted = false;
let artifactSequence = 0;
// 已使用过的明文凭据只在内存保存，用来遮盖错误文本里没有字段名的凭据。
const secrets = new Set();
const SECRET_FIELD = /(?:api[-_]?key|token|secret|password|credential|license[-_]?key|authorization|cookie|code[-_]?verifier)$/i;

/** 登记业务对象中的凭据，不把对象本身写入日志。 */
function registerSecrets(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_FIELD.test(key) && typeof child === "string" && child.length >= 4) secrets.add(child);
    else if (child && typeof child === "object") registerSecrets(child);
  }
}

/** 过滤结构化字段及文本中的常见凭据格式，保留硬件序列号用于跨机器对照。 */
function sanitize(value) {
  if (value instanceof Error || Object.prototype.toString.call(value) === "[object Error]") return sanitize({ name: value.name, message: value.message, stack: value.stack, code: value.code, status: value.status, signal: value.signal, killed: value.killed });
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET_FIELD.test(key) ? "[已脱敏]" : sanitize(child)]));
  if (typeof value !== "string") return value;
  let text = value;
  for (const secret of secrets) text = text.split(secret).join("[已脱敏]");
  return text
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [已脱敏]")
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[已脱敏JWT]")
    .replace(/\b(?:sk-|XLX-)[A-Za-z0-9_-]+/g, "[已脱敏]")
    .replace(/([?&](?:code|state|key)=)[^&\s"']+/gi, "$1[已脱敏]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|app[_-]?secret|password|license[_-]?key|authorization|cookie|token|secret|qrcode|code_verifier)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi, "$1[已脱敏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已脱敏]@");
}

/** 创建带时间、系统和随机标识的目录，不覆盖其它电脑或同一次重试的记录。 */
function directory() {
  if (!sessionDirectory) {
    const host = crypto.createHash("sha256").update(os.hostname()).digest("hex").slice(0, 8);
    const session = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.platform}-${host}-${crypto.randomBytes(4).toString("hex")}`;
    sessionDirectory = path.join(getPaths().dataDir, "diagnostics", session);
  }
  fs.mkdirSync(sessionDirectory, { recursive: true });
  return sessionDirectory;
}

/** 追加结构化事件；写盘失败只输出提示，不能影响授权与网关运行。 */
function record(event, details = {}) {
  try {
    const entry = sanitize({ at: new Date().toISOString(), uptimeSeconds: process.uptime(), pid: process.pid, event, details });
    fs.appendFileSync(path.join(directory(), "events.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (error) { console.error(`[diagnostics] 写入失败：${error.code || error.message}`); }
}

/** 保存可复查的系统命令输出，压缩大体积设备树并明确记录截断情况。 */
function commandResult(command, args, stdout, stderr, error, elapsedMs) {
  try {
    const name = `${String(++artifactSequence).padStart(3, "0")}-${path.basename(command).replace(/[^a-z0-9.-]/gi, "_")}.json.gz`;
    const output = String(stdout || "");
    const limit = 32 * 1024 * 1024;
    const payload = sanitize({ command, args, stdout: output.slice(0, limit), stderr: String(stderr || "").slice(0, limit), error, elapsedMs, truncated: output.length > limit });
    fs.writeFileSync(path.join(directory(), name), zlib.gzipSync(JSON.stringify(payload), { level: 1 }));
    record("system-command", { command, args, artifact: name, ok: !error, elapsedMs, error });
  } catch (failure) { record("diagnostic-command-save-failed", { command, error: failure }); }
}

/** 获取文件属性与内容摘要，配置和授权只算哈希，绝不收集正文。 */
function fileInfo(file, hash = false) {
  try {
    const stat = fs.statSync(file);
    return { file, exists: true, size: stat.size, modifiedAt: stat.mtime.toISOString(), regularFile: stat.isFile(), ...(hash && stat.isFile() && stat.size <= 1024 * 1024 ? { sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") } : {}) };
  } catch (error) { return { file, exists: false, error: error.code }; }
}

/** 在启动、解压完成与失败时保存路径和模块入口状态，区分缺文件、坏缓存和路径变化。 */
function snapshot(reason) {
  try {
    const paths = getPaths();
    const files = [paths.licensePath, paths.configPath, paths.payloadArchive,
      path.join(paths.modulesCacheDir, ".zgy-extract-ready"),
      path.join(paths.modulesCacheDir, "openclaw", "package.json"),
      path.join(paths.modulesCacheDir, "openclaw", "openclaw.mjs"),
      path.join(paths.modulesCacheDir, "openclaw", "dist", "entry.js"),
      path.join(paths.modulesCacheDir, "openclaw", "dist", "entry.mjs")].filter(Boolean);
    let free = null;
    try { const stat = fs.statfsSync(paths.dataDir); free = { type: stat.type, blockSize: stat.bsize, freeBytes: stat.bavail * stat.bsize }; } catch { /* 不支持时保留其它快照 */ }
    let runtimePackage = null;
    let configuration = null;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(paths.modulesCacheDir, "openclaw", "package.json"), "utf8"));
      runtimePackage = { version: info.version, type: info.type, engines: info.engines, os: info.os, cpu: info.cpu };
    } catch { /* 包缺失会在文件清单中记录 */ }
    try {
      const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8").replace(/^\uFEFF/, ""));
      configuration = { defaultModel: config.agents?.defaults?.model, providers: Object.entries(config.models?.providers || {}).map(([id, provider]) => ({ id, baseUrl: provider?.baseUrl, api: provider?.api, keyPresent: Boolean(provider?.apiKey) })), channels: Object.entries(config.channels || {}).map(([id, channel]) => ({ id, enabled: channel?.enabled })), pluginPaths: config.plugins?.load?.paths };
    } catch { /* 配置缺失不触发创建或修复 */ }
    record("snapshot", { reason, paths, disk: free, runtimePackage, configuration, files: files.map((file) => fileInfo(file, true)) });
  } catch (error) { record("snapshot-failed", { reason, error }); }
}

/** 流式计算模块包摘要，帮助确认不同电脑实际使用的压缩包是否一致。 */
async function hashArchive() {
  const file = getPaths().payloadArchive;
  try {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    record("module-archive-digest", { file, sha256: hash.digest("hex") });
  } catch (error) { record("module-archive-digest-failed", { file, error }); }
}

/** 异步执行只读硬件探针，单条失败不影响其余项目或应用启动。 */
function probe(command, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(command, args, { encoding: "utf8", windowsHide: true, timeout: timing.diagnostics.probeTimeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      commandResult(command, args, stdout, stderr, error, Date.now() - started);
      resolve();
    });
  });
}

/** 补充各系统的原始硬件拓扑和版本信息，即使授权失败也会继续完成采集。 */
async function collectHardware() {
  let failure = null;
  try {
    const fingerprint = require("./fingerprint");
    record("device-identity", { machineId: fingerprint.getMachineId(), ...fingerprint.getFingerprint() });
    if (process.platform === "darwin") {
      for (const [command, args] of [
        ["sw_vers", []], ["sysctl", ["-n", "hw.model"]], ["sysctl", ["-n", "sysctl.proc_translated"]],
        ["diskutil", ["list", "-plist"]], ["ioreg", ["-p", "IOUSB", "-l", "-w", "0"]],
        ["system_profiler", ["SPUSBHostDataType", "-json"]], ["system_profiler", ["SPUSBDataType", "-json"]],
      ]) await probe(command, args);
    } else if (process.platform === "win32") {
      await probe("powershell.exe", ["-NoProfile", "-Command", "$os=Get-CimInstance Win32_OperatingSystem; $pc=Get-CimInstance Win32_ComputerSystem; $disks=Get-CimInstance Win32_DiskDrive | Select-Object Model,SerialNumber,InterfaceType,PNPDeviceID,DeviceID,Size; [pscustomobject]@{os=$os.Caption;version=$os.Version;build=$os.BuildNumber;manufacturer=$pc.Manufacturer;model=$pc.Model;disks=@($disks)} | ConvertTo-Json -Depth 4 -Compress"]);
    }
    await hashArchive();
  } catch (error) { failure = error; record("hardware-collection-failed", { error }); }
  finally {
    record("hardware-collection-complete", { partial: Boolean(failure) });
    try { fs.writeFileSync(path.join(directory(), "采集完成.txt"), "基础诊断采集已结束，无法读取的项目已记录错误；网关启动和后续错误仍会继续写入 events.jsonl。\n", "utf8"); } catch { /* 写盘失败已在事件日志中尝试记录 */ }
  }
}

/** 开始本次启动的诊断，异步补充硬件资料，不等待用户另行运行命令。 */
function start(app) {
  if (sessionStarted) return;
  sessionStarted = true;
  let build = null;
  try { build = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), "out", "build-info.json"), "utf8")); } catch { /* 开发运行可能没有打包信息 */ }
  record("session-start", { version: app.getVersion(), build, packaged: app.isPackaged, platform: process.platform, arch: process.arch, hardwareArch: os.machine(), hostname: os.hostname(), osRelease: os.release(), osVersion: os.version(), cpu: os.cpus()[0]?.model, cpuCount: os.cpus().length, memoryBytes: os.totalmem(), versions: process.versions, executable: process.execPath, cwd: process.cwd(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  snapshot("startup");
  setImmediate(() => { void collectHardware(); });
}

/** 把现有业务日志中的启动、告警和错误归入本次会话，不复制聊天正文或调试提示词。 */
function captureLog(name, text) {
  const relevant = String(text || "").split(/\r?\n/).filter((line) => !/context-diag|pre-prompt|promptChars|historyText|textBody|getupdates/i.test(line) && /error|fail|warn|missing|ready|started|exited|license|fingerprint|extract|失败|错误|缺少|授权|超时/i.test(line));
  if (relevant.length) record("runtime-log", { name, text: relevant.join("\n").slice(-65536) });
}

module.exports = { start, record, snapshot, commandResult, registerSecrets, captureLog, sanitize };

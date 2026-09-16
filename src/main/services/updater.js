/**
 * 整包更新：检查后台新版本 → 下载并校验 SHA-256 → 生成替换脚本 →退出客户端后由脚本完成新旧可执行文件交换并重新拉起。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { app } = require("electron");
const { getPaths } = require("../paths");
const { getAppConfig } = require("../app-config");
const { getUsbId } = require("./fingerprint");
const timing = require("../../shared/timing.json");
const { requireBackendSettings, reportEvent } = require("./backend-client");

function currentVersion() {
  return String(getAppConfig().product?.version || "0.0.0");
}

function joinUrl(base, pathname) {
  return String(base || "").replace(/\/+$/, "") + pathname;
}

async function postJson(url, body, timeoutMs = timing.update.requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || data.code || `后台返回 HTTP ${response.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 向后台查询是否有新版本。
 * 不带 channel：版本按哪条通道发由后台按授权记录上的 channel 决定，客户端声明反而会盖掉它。
 */
async function checkUpdate() {
  const settings = requireBackendSettings();
  await postJson(joinUrl(settings.backendUrl, "/api/client/license/check"), {
    licenseKey: settings.licenseKey,
    usbId: getUsbId(),
    clientVersion: currentVersion(),
  });
  const response = await postJson(joinUrl(settings.backendUrl, "/api/client/update/check"), {
    licenseKey: settings.licenseKey,
    usbId: getUsbId(),
    platform: process.platform === "darwin" ? "macos" : "windows",
    arch: process.arch,
    currentVersion: currentVersion(),
  });
  return { ok: true, request: { currentVersion: currentVersion() }, result: response.data || response };
}

function downloadFile(targetUrl, destPath, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error("更新下载重定向次数过多"));
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const request = (url.protocol === "https:" ? require("https") : require("http")).get({
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      headers: { "User-Agent": "ZgyClaw-Updater/1.0" },
      timeout: 60000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        downloadFile(new URL(response.headers.location, targetUrl).toString(), destPath, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error("更新下载失败：HTTP " + response.statusCode));
        return;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const file = fs.createWriteStream(destPath);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolve(destPath)));
      file.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("更新下载超时")));
    request.on("error", reject);
  });
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toLowerCase();
}

function safeFilePart(value) {
  return String(value || "update").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 80) || "update";
}

/**
 * 执行更新：下载 → 校验 → 落替换脚本 → 返回 true（调用方随后退出客户端）。
 * Windows 交付物是单个 exe；macOS 交付物是包含 .app 的 zip。
 */
async function installUpdate() {
  const checked = await checkUpdate();
  const result = checked.result || {};
  if (!result.needUpdate) return { ok: true, needUpdate: false, message: "已是最新版本。" };
  if (!result.downloadUrl) throw new Error("更新包下载地址为空。");

  const { executablePath, updateDir } = getPaths();
  const downloadDir = path.join(updateDir, "downloads");
  const version = safeFilePart(result.latestVersion || result.version || "new");
  fs.mkdirSync(downloadDir, { recursive: true });

  let filename = "";
  try { filename = path.basename(new URL(result.downloadUrl).pathname); } catch { /* 回落默认名 */ }
  const ext = process.platform === "win32" ? ".exe" : ".zip";
  if (!filename.toLowerCase().endsWith(ext)) filename = `zgyclaw-${version}${ext}`;
  const downloadPath = path.join(downloadDir, `${version}-${Date.now()}-${safeFilePart(filename)}`);

  await downloadFile(result.downloadUrl, downloadPath);
  const actualSha = sha256File(downloadPath);
  const expectedSha = String(result.sha256 || "").trim().toLowerCase();
  if (expectedSha && actualSha !== expectedSha) {
    fs.rmSync(downloadPath, { force: true });
    throw new Error(`更新包 SHA-256 校验失败，已放弃安装。`);
  }

  const scriptPath = process.platform === "win32"
    ? writeWindowsReplaceScript(executablePath, downloadPath)
    : writeMacReplaceScript(downloadPath);
  const child = spawn(
    process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    process.platform === "win32" ? ["/d", "/c", scriptPath] : [scriptPath],
    { cwd: path.dirname(scriptPath), detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  void reportEvent({ eventType: "update_install_started", level: "info", message: "Update installing.", details: { version } });
  return { ok: true, needUpdate: true, installing: true, version, downloadPath, sha256: actualSha };
}

/** Windows 替换脚本：等待主进程退出 → 备份旧 exe → 落新 exe → 拉起 → 清理。 */
function writeWindowsReplaceScript(executablePath, downloadPath) {
  const scriptPath = path.join(getPaths().updateDir, `apply-update-${Date.now()}.cmd`);
  const ownerPid = process.pid;
  const script = [
    "@echo off",
    "setlocal",
    ":waitloop",
    `tasklist /FI "PID eq ${ownerPid}" | find "${ownerPid}" >nul`,
    "if not errorlevel 1 (timeout /t 1 /nobreak >nul & goto waitloop)",
    `move /y "${executablePath}" "${executablePath}.updating"`,
    `move /y "${downloadPath}" "${executablePath}"`,
    `start "" "${executablePath}"`,
    "timeout /t 3 /nobreak >nul",
    `del "${executablePath}.updating"`,
    `del "%~f0"`,
    "endlocal",
  ].join("\r\n");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, script, "utf8");
  return scriptPath;
}

/** macOS 替换脚本：等待退出 → 解压新 .app → 交换目录 → 重新打开。 */
function writeMacReplaceScript(downloadPath) {
  const appPath = macAppBundlePath();
  const parentDir = path.dirname(appPath);
  const stagingDir = path.join(getPaths().updateDir, `staging-${Date.now()}`);
  const scriptPath = path.join(getPaths().updateDir, `apply-update-${Date.now()}.sh`);
  const ownerPid = process.pid;
  const script = [
    "#!/bin/sh",
    `while kill -0 ${ownerPid} 2>/dev/null; do sleep 1; done`,
    `mkdir -p "${stagingDir}"`,
    `ditto -x -k "${downloadPath}" "${stagingDir}"`,
    `rm -rf "${appPath}.updating"`,
    `mv "${appPath}" "${appPath}.updating"`,
    `mv "${stagingDir}/"*.app "${parentDir}/"`,
    `open "${appPath}"`,
    `rm -rf "${appPath}.updating" "${stagingDir}"`,
    `rm -f -- "$0"`,
  ].join("\n");
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, script, "utf8");
  try { fs.chmodSync(scriptPath, 0o755); } catch { /* 权限设置失败时由 sh 显式调用 */ }
  return scriptPath;
}

/** macOS 应用包路径：从可执行文件路径截取 .app 根目录。 */
function macAppBundlePath() {
  const exePath = app.getPath("exe");
  const marker = "/Contents/MacOS/";
  const index = exePath.indexOf(marker);
  return index > 0 ? exePath.slice(0, index) : path.dirname(exePath);
}

module.exports = { checkUpdate, installUpdate };

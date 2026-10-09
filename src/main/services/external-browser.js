/** 网页打开入口：优先使用系统默认浏览器，Windows 打开失败时让用户选择本机浏览器。 */
const { dialog, shell } = require("electron");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { appendLogLine } = require("./logs");
const timing = require("../../shared/timing.json");

// 只读取注册为 HTTP 浏览器的程序，不执行注册表中的命令行或附加参数。
const WINDOWS_BROWSER_QUERY = String.raw`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$browserRoots = @('HKCU:\SOFTWARE\Clients\StartMenuInternet', 'HKLM:\SOFTWARE\Clients\StartMenuInternet', 'HKLM:\SOFTWARE\WOW6432Node\Clients\StartMenuInternet')
$browsers = @(foreach ($browserRoot in $browserRoots) {
  foreach ($browserKey in (Get-ChildItem -LiteralPath $browserRoot -ErrorAction SilentlyContinue)) {
    $commandKey = Get-Item -LiteralPath (Join-Path $browserKey.PSPath 'shell\open\command') -ErrorAction SilentlyContinue
    $associationKey = Get-Item -LiteralPath (Join-Path $browserKey.PSPath 'Capabilities\URLAssociations') -ErrorAction SilentlyContinue
    if ($commandKey -and $associationKey -and $associationKey.GetValue('http')) {
      [pscustomobject]@{
        name = [string]$browserKey.GetValue('')
        command = [Environment]::ExpandEnvironmentVariables([string]$commandKey.GetValue(''))
      }
    }
  }
})
ConvertTo-Json -InputObject $browsers -Compress
`;

// 选择只在本次客户端运行期间复用，换电脑时不会携带旧电脑的浏览器路径。
let selectedBrowser = null;
// 并发链接共用一次浏览器选择，同一链接的重复点击共用一次打开任务。
let browserSelection = null;
const pendingOpens = new Map();

/** 记录打开失败的阶段与错误码，不把包含聊天令牌或 OAuth 参数的链接写入日志。 */
function logBrowserFailure(stage, error) {
  const code = error?.code || String(error?.message || "").match(/0x[0-9a-f]+/i)?.[0] || error?.name || "unknown";
  appendLogLine("browser-open.log", `${stage} code=${code}`);
}

/** 确认候选项是本机实际存在的 EXE 文件。 */
function isBrowserExecutable(executable) {
  if (!path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe") return false;
  try { return fs.statSync(executable).isFile(); } catch { return false; }
}

/** 异步读取本机浏览器登记；登记损坏或读取失败时仍可手动选择浏览器。 */
async function listWindowsBrowsers() {
  try {
    const output = await new Promise((resolve, reject) => {
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_BROWSER_QUERY], {
        encoding: "utf8",
        windowsHide: true,
        timeout: timing.externalBrowser.discoveryTimeoutMs,
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const registered = JSON.parse(output.replace(/^\uFEFF/, "").trim() || "[]");
    // 32 位与 64 位登记可能指向同一个文件，按路径去重后再展示。
    const browsers = new Map();
    for (const browser of registered) {
      const match = String(browser.command || "").match(/^\s*(?:"([^\"]+\.exe)"|(.+?\.exe)(?=\s|$))/i);
      const executable = match?.[1] || match?.[2] || "";
      if (!isBrowserExecutable(executable)) continue;
      const name = String(browser.name || "").trim();
      browsers.set(executable.toLowerCase(), { executable, name: name && !name.startsWith("@") ? name : path.basename(executable, ".exe") });
    }
    return [...browsers.values()].sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    logBrowserFailure("读取浏览器列表失败", error);
    return [];
  }
}

/** 用原生弹窗选择浏览器；手动选择取消时回到列表，关闭列表时取消打开。 */
async function chooseBrowser(parentWindow, message) {
  const browsers = await listWindowsBrowsers();
  while (!parentWindow?.isDestroyed()) {
    const options = {
      type: "info",
      title: "选择浏览器",
      message,
      detail: browsers.length ? "请选择一个浏览器打开页面。" : "未找到已登记的浏览器，请手动选择已安装的浏览器。",
      buttons: [...browsers.map((browser) => browser.name), "手动选择浏览器…", "取消"],
      defaultId: 0,
      cancelId: browsers.length + 1,
      noLink: false,
    };
    const { response } = await dialog.showMessageBox(...(parentWindow ? [parentWindow, options] : [options]));
    if (response === browsers.length + 1) return null;
    if (response < browsers.length) return browsers[response];
    if (parentWindow?.isDestroyed()) return null;
    const fileOptions = {
      title: "选择浏览器程序",
      buttonLabel: "使用此浏览器",
      filters: [{ name: "浏览器程序", extensions: ["exe"] }],
      properties: ["openFile", "dontAddToRecent"],
    };
    const { canceled, filePaths } = await dialog.showOpenDialog(...(parentWindow ? [parentWindow, fileOptions] : [fileOptions]));
    if (!canceled && filePaths[0]) return { executable: filePaths[0], name: path.basename(filePaths[0], ".exe") };
  }
  return null;
}

/** 多个链接同时失败时共用当前弹窗，避免重叠的浏览器选择窗口。 */
function requestBrowser(parentWindow, message) {
  if (!browserSelection) {
    browserSelection = chooseBrowser(parentWindow, message).finally(() => { browserSelection = null; });
  }
  return browserSelection;
}

/** 直接启动用户选择的程序，链接作为单个参数传递，不经命令解释器。 */
function launchBrowser(executable, url) {
  if (!isBrowserExecutable(executable)) throw new Error("所选浏览器程序不存在或不可用");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [url], { detached: true, stdio: "ignore", windowsHide: true, shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

/** 默认浏览器失败后允许选择与重选，取消只返回状态，不作为应用错误上抛。 */
async function openWithBrowser(url, parentWindow) {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (error) {
    logBrowserFailure("默认浏览器打开失败", error);
  }
  if (process.platform !== "win32") return { ok: false, message: "无法打开浏览器，请在系统设置中重新选择默认浏览器后重试。" };

  let message = "默认浏览器无法打开链接";
  while (!parentWindow?.isDestroyed()) {
    const browser = selectedBrowser || await requestBrowser(parentWindow, message);
    if (!browser) return { ok: false, canceled: true };
    try {
      await launchBrowser(browser.executable, url);
      selectedBrowser = browser;
      return { ok: true };
    } catch (error) {
      logBrowserFailure("所选浏览器启动失败", error);
      selectedBrowser = null;
      message = `“${browser.name}”无法启动，请选择其他浏览器`;
    }
  }
  return { ok: false, canceled: true };
}

/** 校验网页链接并合并重复打开请求，所有网页入口共用默认浏览器与选择逻辑。 */
async function openBrowser(rawUrl, parentWindow) {
  const url = String(rawUrl || "").trim();
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error("只允许打开 HTTP/HTTPS 链接");
  if (!pendingOpens.has(url)) {
    const opening = openWithBrowser(url, parentWindow).catch((error) => {
      logBrowserFailure("浏览器选择失败", error);
      return { ok: false, message: "暂时无法打开浏览器，请稍后重试。" };
    }).finally(() => { pendingOpens.delete(url); });
    pendingOpens.set(url, opening);
  }
  return pendingOpens.get(url);
}

module.exports = { openBrowser };

/**
 * 应用入口：单实例锁、启动链（模块引导 → 授权校验 → 后台校验 → 窗口）、
 * 拔盘看护、退出清理与命令行授权工具。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { getPaths } = require("./paths");
const { registerIpcHandlers } = require("./ipc");
const modules = require("./services/modules");
const license = require("./services/license");
const processManager = require("./services/process-manager");
const { checkBackendLicense, syncBackendModels } = require("./services/backend-client");
const { cleanupStaleProcesses } = require("./services/process-manager");
const { startUsbWatch } = require("./services/usb-watch");
const { appendWechatLoginLog } = require("./services/logs");
const oauthListener = require("./services/oauth-listener");

// macOS 26 GPU/字体渲染路径存在崩溃问题，仅 darwin 关闭硬件加速。
if (process.platform === "darwin") {
  app.commandLine.appendSwitch("disable-gpu");
}

const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 780;
let mainWindow = null;
let isQuitting = false;

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    const { logsDir } = getPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, "electron-shell.log"), line + "\n", "utf8");
  } catch { /* 日志失败不阻塞启动 */ }
}

/** 命令行工具：--bind-usb 绑定授权，--check-license 校验授权（替代旧 .bat 脚本）。 */
async function runCliCommand() {
  const command = process.argv.find((arg) => arg === "--bind-usb" || arg === "--check-license");
  if (!command) return false;
  await app.whenReady();
  try {
    if (command === "--bind-usb") {
      const result = license.bindUsb();
      console.log(`授权绑定完成: ${result.filePath}`);
      console.log(`设备指纹: ${result.maskedFingerprint}`);
    } else {
      const result = license.verify();
      console.log(result.ok ? "授权校验通过" : `授权校验失败: ${result.message}`);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`命令执行失败: ${error.message}`);
    process.exitCode = 1;
  }
  app.exit(process.exitCode || 0);
  return true;
}

function showFatalError(message) {
  const { dialog } = require("electron");
  dialog.showErrorBox("小龙虾启动失败", message);
}

/** 启动链：模块引导 → 授权校验 → 后台校验/模型同步 → 残留进程清理 → 窗口。 */
async function bootSequence() {
  const { logsDir } = getPaths();
  fs.mkdirSync(logsDir, { recursive: true });

  modules.ensureModules();
  logLine("modules ready");

  if (license.shouldRequireLicense()) {
    const verification = license.verify();
    if (!verification.ok) {
      throw new Error(`${verification.message}\n\n该 U 盘尚未绑定授权，请联系售后处理。`);
    }
  }
  logLine("license ok");

  const backendLicense = await checkBackendLicense();
  if (!backendLicense.ok && !backendLicense.reportOnly) {
    throw new Error(backendLicense.message || "后台授权校验失败。");
  }
  if (backendLicense.ok && !backendLicense.skipped) {
    await syncBackendModels("boot");
  }
  logLine("backend check done");

  await cleanupStaleProcesses();
  createMainWindow();
}

function createMainWindow() {
  const productVersion = String(require("./app-config").getAppConfig().product?.version || app.getVersion());
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // 使用系统原生标题栏，页面内不绘制假窗口控制按钮。
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    title: `小龙虾U盘版 v${productVersion}`,
    ...(process.platform === "win32" ? { icon: path.join(__dirname, "..", "..", "build", "icon.ico") } : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(`小龙虾U盘版 v${productVersion}`);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.includes("127.0.0.1") && !url.includes("localhost")) {
      require("electron").shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "..", "out", "renderer", "index.html"));
  }
  mainWindow.once("ready-to-show", () => mainWindow && mainWindow.show());
}

/** 退出收尾：停 OAuth 监听、清杀子进程树。 */
async function gracefulExit() {
  isQuitting = true;
  try { oauthListener.stop(); } catch { /* 监听器可能未启动 */ }
  try { await processManager.shutdownAll(); } catch { /* 退出路径尽力清理 */ }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (await runCliCommand()) return;
    registerIpcHandlers();
    try {
      await bootSequence();
    } catch (error) {
      const message = error?.message || String(error);
      logLine(`boot failed: ${message}`);
      appendWechatLoginLog(`boot failed: ${message}`);
      createMainWindow();
      mainWindow.webContents.on("did-finish-load", () => {
        mainWindow?.webContents.send("boot:error", { message });
      });
      showFatalError(message);
      return;
    }
    // 拔盘看护：U 盘移除即停网关、清进程、退出。
    startUsbWatch(() => {
      logLine("usb removed; shutting down");
      void gracefulExit().finally(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
        app.exit(0);
      });
    });
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && !isQuitting) {
      createMainWindow();
    }
  });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    void gracefulExit();
  });

  app.on("window-all-closed", () => {
    void gracefulExit().finally(() => app.quit());
  });

  process.on("uncaughtException", (error) => {
    logLine(`uncaught exception: ${error.message}`);
  });
}

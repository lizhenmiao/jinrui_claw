/**
 * 应用入口：单实例锁、窗口先行的启动链（加载页即刻可见，模块引导/授权校验后台进行）、
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
const { readConfig, writeConfig } = require("./services/config-store");
const { startUsbWatch } = require("./services/usb-watch");
const { appendWechatLoginLog } = require("./services/logs");
const oauth = require("./services/oauth");
const oauthListener = require("./services/oauth-listener");
const keepalive = require("./services/keepalive");

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

// 命令行授权工具（--bind-usb / --check-license）：不参与单实例锁——主窗口开着
// （比如停在启动错误页）时也要能执行，绑定完回窗口点"重试"即可进入，形成闭环。
const cliCommand = process.argv.find((arg) => arg === "--bind-usb" || arg === "--check-license") || "";

/** 命令行工具：--bind-usb 绑定授权，--check-license 校验授权（替代旧 .bat 脚本）。 */
async function runCliCommand() {
  if (!cliCommand) return false;
  await app.whenReady();
  try {
    if (cliCommand === "--bind-usb") {
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

/**
 * 启动核心：模块引导 → 授权校验 → 后台校验/模型同步 → 残留进程清理。
 * 幂等可重试（模块已解压/授权已通过时秒回），失败抛错由状态机转成错误页。
 */
async function bootCore() {
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

  await processManager.cleanupStaleProcesses();
  logLine("stale cleanup done");
  // 配置归一化回写一次：模型展示名的品牌前缀等约定在写入路径上补齐，
  // 升级前写好的旧配置靠这一步在首次启动就生效。
  try { writeConfig(readConfig()); } catch { /* 归一化失败不阻塞启动 */ }
}

/** 启动成功后的常驻服务：预热、心跳保活、登录回调、拔盘看护（只挂一次，重试不重复）。 */
function startBootServices() {
  if (bootServicesStarted) return;
  bootServicesStarted = true;
  // 后台预热：把 openclaw 组件的首次冷启动（实测约 1 分钟）挪到启动阶段，
  // 用户还在走登录/模型步骤时二维码就已经备好，到 BOT 页不用再等。
  try { if (processManager.prewarmWechatLogin({ warmup: true })) logLine("wechat login prewarmed"); } catch { /* 预热失败不阻塞启动 */ }
  keepalive.start();
  // 浏览器不允许网页关闭/跳回客户端，这里在授权成功时把客户端窗口唤到前台作为补偿。
  oauth.onLoginSuccess(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  // 拔盘看护：U 盘移除即停网关、清进程、退出。
  startUsbWatch(() => {
    logLine("usb removed; shutting down");
    void gracefulExit().finally(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      app.exit(0);
    });
  });
  logLine("boot services started");
}

// ---- 启动状态机：窗口先开（加载页），核心链后台跑，结果推给渲染层 ----

let bootState = { status: "booting", message: "" };
let bootRunning = false;
let bootServicesStarted = false;

/** 把启动状态推给渲染层（页面还没加载完时事件会被丢弃，渲染层靠 getBootState 补齐首查）。 */
function sendBootState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("boot:state", bootState);
}

/** 跑一次启动核心：成功进入常驻服务，失败进入错误页（用户可点重试再跑）。 */
async function runBoot() {
  if (bootRunning) return;
  bootRunning = true;
  bootState = { status: "booting", message: "" };
  sendBootState();
  try {
    await bootCore();
  } catch (error) {
    const message = error?.message || String(error);
    logLine(`boot failed: ${message}`);
    appendWechatLoginLog(`boot failed: ${message}`);
    bootState = { status: "error", message };
    sendBootState();
    return;
  } finally {
    bootRunning = false;
  }
  bootState = { status: "ready" };
  sendBootState();
  startBootServices();
}

ipcMain.handle("app:getBootState", () => bootState);
ipcMain.handle("app:retryBoot", () => {
  void runBoot();
  return { ok: true };
});

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
      // 登录/订阅要在浏览器里完成，本窗口被浏览器遮挡时若被节流，轮询会几乎停摆，
      // 用户会看到"登录验证一直转圈""订购完成却不生效"，因此关闭后台节流。
      backgroundThrottling: false,
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
    mainWindow.loadFile(path.join(__dirname, "..", "..", "out", "renderer", "index.html"))
      .catch((error) => logLine(`renderer load failed: ${error.message}`));
  }
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logLine(`renderer gone: ${details.reason} exit=${details.exitCode}`);
  });
  mainWindow.once("ready-to-show", () => {
    logLine("renderer ready");
    mainWindow && mainWindow.show();
  });
}

/** 退出收尾：停 OAuth 监听、清杀子进程树。 */
async function gracefulExit() {
  isQuitting = true;
  keepalive.stop();
  try { oauthListener.stop(); } catch { /* 监听器可能未启动 */ }
  try { await processManager.shutdownAll(); } catch { /* 退出路径尽力清理 */ }
}

const gotLock = Boolean(cliCommand) || app.requestSingleInstanceLock();
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
    // 窗口先行：加载页立刻可见（首次模块解压约 1 分钟不再是黑等），
    // 启动核心在后台进行，失败在窗口错误页展示并支持重试。
    createMainWindow();
    void runBoot();
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

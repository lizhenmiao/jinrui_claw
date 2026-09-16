/**
 * 应用入口：单实例锁、窗口先行的启动链（加载页即刻可见，模块引导/授权校验后台进行）、拔盘看护、退出清理与命令行授权工具。
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { getPaths } = require("./paths");
const { registerIpcHandlers } = require("./ipc");
const modules = require("./services/modules");
const license = require("./services/license");
const processManager = require("./services/process-manager");
const { checkBackendLicense, syncBackendModels, readBackendSettings } = require("./services/backend-client");
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

// 命令行授权工具（--bind-usb / --check-license）：不参与单实例锁——主窗口开着（比如停在启动错误页）时也要能执行，绑定完回窗口点"重试"即可进入，形成闭环。
const cliCommand = process.argv.find((arg) => arg === "--bind-usb" || arg === "--check-license") || "";

/** 取 --license 的值，支持 `--license KEY` 与 `--license=KEY` 两种写法。 */
function parseLicenseArg() {
  const index = process.argv.findIndex((arg) => arg === "--license");
  if (index >= 0) return String(process.argv[index + 1] || "").trim().replace(/^["']|["']$/g, "");
  const inline = process.argv.find((arg) => arg.startsWith("--license="));
  return inline ? inline.slice("--license=".length).trim().replace(/^["']|["']$/g, "") : "";
}

/** 后台拒绝时的处理建议：售后照着做就能解决，不用回来查代码。 */
function backendRejectionHint(code) {
  if (code === "USB_MISMATCH") return "该授权码已经绑定过别的 U 盘。到管理后台清空这条授权的 U 盘 ID 后重新执行本命令。";
  if (code === "LICENSE_NOT_FOUND") return "管理后台里没有这个授权码。请先在后台新建授权，授权码要与命令里输入的完全一致。";
  if (code === "LICENSE_DISABLED") return "这条授权在管理后台已被禁用，请启用后重试。";
  if (code === "LICENSE_EXPIRED") return "这条授权已过期，请在管理后台延长到期时间后重试。";
  return "请到管理后台核对这条授权的状态、到期时间与 U 盘绑定情况。";
}

/**
 * --bind-usb --license KEY：为当前 U 盘写绑定文件，并把该盘要用的授权码一起写进去。
 * 先向后台核对：核对通过等于同时在后台把这条授权绑到本盘（一码一盘）；
 * 核对被拒（授权不存在/禁用/过期/已绑别的盘）就不落盘，避免把配错的盘发给客户；
 * 后台连不上则写文件并警告，客户端首次启动时还会再校验一次。
 * 授权码是必需的：包内没有缺省值，写出不带授权码的绑定等于把一张打不开的盘发给客户。
 */
async function runBindCommand() {
  const requestedKey = parseLicenseArg();

  if (!requestedKey) {
    console.error("缺少 --license 参数：授权码随 U 盘走，包内没有缺省值，不写授权码的绑定客户端起不来。");
    console.error("请在管理后台新建授权码，然后执行：zgyclaw.exe --bind-usb --license XLX-XXXXXXXX");
    console.error("未写入本地绑定文件。");
    return 1;
  }
  if (!license.isValidLicenseKey(requestedKey)) {
    // 格式先卡住：明显写错的授权码不必去打扰后台，也避免把空格、中文之类的脏值发出去。
    console.error(`授权码格式不正确：${requestedKey}（只允许字母、数字、点、下划线、短横线，4~64 位）`);
    console.error("未写入本地绑定文件。");
    return 1;
  }
  const check = await checkBackendLicense({ licenseKey: requestedKey });
  if (check.rejected) {
    console.error(`授权码核对未通过：${check.message}`);
    console.error(backendRejectionHint(check.code));
    console.error("未写入本地绑定文件。");
    return 1;
  }
  if (!check.ok) {
    console.warn(`警告：连不上后台（${check.message}），未能核对授权码；客户端首次启动时会再校验。`);
  } else {
    console.log("授权码核对通过，该授权已绑定本 U 盘。");
  }

  const result = license.bindUsb({ licenseKey: requestedKey });
  console.log(`本地授权文件：${result.filePath}`);
  console.log(`U 盘指纹：${result.maskedFingerprint}`);
  console.log(`授权码：${requestedKey}`);
  return 0;
}

/** --check-license：校验本地绑定与本次实际使用的授权码。 */
function runCheckCommand() {
  const result = license.verify();
  if (result.ok) {
    console.log("本地授权校验通过。");
    console.log(`U 盘指纹：${result.maskedFingerprint}`);
  } else {
    // 校验结果里带文件路径，方便售后定位（界面上的文案不带路径）。
    console.error(`本地授权校验失败：${result.message}${result.filePath ? `（${result.filePath}）` : ""}`);
  }
  // 授权码只可能来自本盘绑定文件；没有就是还没绑定，顺带把补救命令打出来。
  const settings = readBackendSettings();
  console.log(settings.licenseKey
    ? `授权码：${settings.licenseKey}`
    : "授权码：未绑定（执行 zgyclaw.exe --bind-usb --license 你的授权码 完成绑定）");
  console.log(settings.backendUrl
    ? `管理后台：${settings.backendUrl}`
    : "管理后台：未配置（app.config.json 的 backend.url 为空）");
  return result.ok ? 0 : 1;
}

/** 命令行工具：--bind-usb 绑定授权，--check-license 校验授权（替代旧 .bat 脚本）。 */
async function runCliCommand() {
  if (!cliCommand) return false;
  await app.whenReady();
  let code = 0;
  try {
    code = cliCommand === "--bind-usb" ? await runBindCommand() : runCheckCommand();
  } catch (error) {
    console.error(`命令执行失败：${error.message}`);
    code = 1;
  }
  // app.exit 正常即可结束；个别环境（杀软正在扫描刚解压出来的 exe、外部句柄未释放）可能拖住进程，兜一个定时强制退出，避免终端卡在一条不返回的命令上。
  app.exit(code);
  setTimeout(() => process.exit(code), 1500);
  return true;
}

/**
 * 启动核心：模块引导 → 授权校验 → 后台校验/模型同步 → 微信组件预热 → 残留进程清理。
 * 幂等可重试（模块已解压/授权已通过时秒回），失败抛错由状态机转成错误页。
 * onStage 把当前阶段推给加载页：解压与首次预热合起来要一两分钟，逐步说明在做什么，用户才不是白等。
 */
async function bootCore(onStage) {
  const { dataDir, logsDir } = getPaths();
  // 产品目录不可写时给出明确原因，而不是让后续 mkdir 抛一个看不懂的 EACCES：
  // macOS 上用户常把 App 拖进 /Applications，那里建 data/ 需要管理员权限，数据也就没法随盘走。
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new Error(`无法在程序所在目录写入数据（${dataDir}）：${error.message}\n\n请把程序放在 U 盘目录里运行，不要单独放进 /Applications。`);
  }
  fs.mkdirSync(logsDir, { recursive: true });

  // 必须 await：子进程启动要用解压后的模块目录，不等就会拿着未就绪的缓存往下走。
  if (!modules.isModulesReady()) onStage("正在解压运行组件，首次运行需要一分钟左右…");
  await modules.ensureModules();
  logLine("modules ready");

  onStage("正在校验授权…");
  if (license.shouldRequireLicense()) {
    const verification = license.verify();
    if (!verification.ok) {
      throw new Error(`${verification.message}\n\n该 U 盘尚未绑定授权，请联系售后处理。`);
    }
  }
  logLine("license ok");

  onStage("正在连接管理后台…");
  // 后台授权校验：配不全（缺地址或缺本盘授权码）时 checkBackendLicense 直接抛错，加载页显示原因并可重试，不会静默跳过联检。
  const backendLicense = await checkBackendLicense();
  // 只有后台明确拒绝（授权无效/过期/U 盘不匹配）才拦启动；连不上后台属"无法判定"，放过并记日志——否则后台故障或离线环境会让所有客户端集体打不开，此时本地授权仍在把关。
  if (backendLicense.rejected) {
    throw new Error(backendLicense.message || "后台授权校验未通过。");
  }
  if (backendLicense.ok && !backendLicense.skipped) {
    await syncBackendModels();
  }
  logLine("backend check done");

  // 微信组件预热放在最后：前面每一步都可能在几秒内失败，先让用户看到真正的原因，
  // 而不是白等一分多钟再被告知授权不对。已热过或已绑定微信号时这里立即返回。
  const warmup = await processManager.warmupWechatRuntime((message) => onStage(message));
  logLine(warmup.warmed ? `wechat runtime warmed (ready=${warmup.ready})` : "wechat runtime already warm");

  await processManager.cleanupStaleProcesses();
  logLine("stale cleanup done");
  // 配置归一化回写一次：模型展示名的品牌前缀等约定在写入路径上补齐，升级前写好的旧配置靠这一步在首次启动就生效。
  try { writeConfig(readConfig()); } catch { /* 归一化失败不阻塞启动 */ }
}

/** 启动成功后的常驻服务：心跳保活、登录回调、拔盘看护（只挂一次，重试不重复）。 */
function startBootServices() {
  if (bootServicesStarted) return;
  bootServicesStarted = true;
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
    await bootCore((message) => {
      bootState = { status: "booting", message };
      sendBootState();
    });
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
      // 登录/订阅要在浏览器里完成，本窗口被浏览器遮挡时若被节流，轮询会几乎停摆，用户会看到"登录验证一直转圈""订购完成却不生效"，因此关闭后台节流。
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
    // 窗口先行：加载页立刻可见（首次模块解压约 1 分钟不再是黑等），启动核心在后台进行，失败在窗口错误页展示并支持重试。
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

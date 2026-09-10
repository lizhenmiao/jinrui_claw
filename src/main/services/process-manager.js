/**
 * 子进程编排：网关、钉钉 bridge、通道登录进程的启动与停止。
 * 子进程统一使用 Electron 自带 Node（ELECTRON_RUN_AS_NODE），不再内置 node.exe。
 * 所有子进程登记到看护进程（process-warden）：主进程无论正常退出还是被强杀，
 * 看护进程都会终止整棵进程树，保证 U 盘句柄全部释放。
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const { execFile, execFileSync, spawn } = require("child_process");
const { getPaths } = require("../paths");
const { getAppConfig } = require("../app-config");
const { prepareRuntimeConfig } = require("./secret-crypto");
const { readConfig, writeConfig, ensurePluginLoadPath } = require("./config-store");
const { ensureModules, moduleEntryPath } = require("./modules");
const { syncBackendModels, reportEvent } = require("./backend-client");

let gatewayProcess = null;
let dingTalkBridgeProcess = null;
let wechatLoginProcess = null;
let wardenProcess = null;

/** 网关端口来自应用配置，运营可通过覆盖文件调整。 */
function gatewayPort() {
  return Number(getAppConfig().ports?.gateway || 18789);
}

function logDirEnsure() {
  const { logsDir } = getPaths();
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function appendLog(name, text) {
  try {
    fs.appendFileSync(path.join(logDirEnsure(), name), text, "utf8");
  } catch { /* 日志失败不影响进程管理 */ }
}

/** 子进程 PID 登记文件：看护进程轮询它来决定清杀目标。 */
function childPidsFile() {
  return path.join(getPaths().stateDir, "child-pids.json");
}

function readChildPids() {
  try {
    const parsed = JSON.parse(fs.readFileSync(childPidsFile(), "utf8"));
    return Array.isArray(parsed.pids) ? parsed.pids.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function writeChildPids(pids) {
  writeJsonAtomicQuiet(childPidsFile(), { pids: [...new Set(pids)] });
}

function writeJsonAtomicQuiet(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch { /* 登记失败时仍有显式清理兜底 */ }
}

/** 启动看护进程（整个应用生命周期只启动一次）。 */
function ensureWarden() {
  if (wardenProcess && !wardenProcess.killed) return;
  const wardenScript = path.join(getPaths().bridgeDir, "process-warden.cjs");
  if (!fs.existsSync(wardenScript)) return;
  const child = spawn(process.execPath, [wardenScript, childPidsFile(), String(process.pid)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "ignore",
    detached: true,
    windowsHide: true,
  });
  child.unref();
  wardenProcess = child;
}

/** 登记子进程 PID 到看护进程。 */
function registerChild(child) {
  if (!child?.pid) return child;
  ensureWarden();
  writeChildPids([...readChildPids(), child.pid]);
  child.on("exit", () => {
    writeChildPids(readChildPids().filter((pid) => pid !== child.pid));
  });
  return child;
}

/** 启动业务子进程：日志落盘、环境指向模块缓存与数据目录，可注入附加环境变量。 */
function startChild(name, scriptPath, args, options = {}) {
  const { dataDir, stateDir, configPath, productRoot } = getPaths();
  const logsDir = logDirEnsure();
  const modulesDir = ensureModules();
  const out = fs.openSync(path.join(logsDir, `${name}.log`), "a");
  const err = fs.openSync(path.join(logsDir, `${name}.err.log`), "a");
  const child = spawn(process.execPath, [scriptPath, ...args], {
    cwd: productRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      OPENCLAW_HOME: dataDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: options.runtimeConfig ? prepareRuntimeConfig() : configPath,
      OPENCLAW_MODULES_DIR: modulesDir,
      OPENCLAW_NO_AUTO_UPDATE: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
      NODE_PATH: [modulesDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
      ...(options.extraEnv || {}),
    },
    stdio: ["ignore", out, err],
    windowsHide: true,
    // POSIX 上独立进程组，便于整组终止；Windows 由 taskkill /T 处理进程树。
    detached: process.platform !== "win32",
  });
  child.unref();
  registerChild(child);
  appendLog(`${name}.start.log`, `[${new Date().toISOString()}] pid=${child.pid} script=${scriptPath}\n`);
  return child;
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
}

async function waitForPort(port, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/** 命令行包含 matchText 的进程 PID 列表（Windows CIM / POSIX pgrep）。 */
async function listMatchingProcesses(matchText) {
  if (process.platform === "win32") {
    const script = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($args[0]) } | Select-Object ProcessId | ConvertTo-Json -Compress";
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script, matchText], { encoding: "utf8", timeout: 8000, windowsHide: true }, (error, stdoutText) => (error ? reject(error) : resolve(stdoutText)));
      });
      const parsed = JSON.parse(String(stdout).trim() || "[]");
      return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => Number(item.ProcessId)).filter(Number.isFinite);
    } catch {
      return [];
    }
  }
  try {
    const stdout = await new Promise((resolve) => {
      execFile("pgrep", ["-f", matchText], { encoding: "utf8", timeout: 5000 }, (error, stdoutText) => resolve(error ? "" : stdoutText));
    });
    return String(stdout).split(/\s+/).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/** 终止进程树：Windows taskkill /T，POSIX kill 进程组。 */
function stopProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch { /* 进程可能已退出 */ }
}

/** 清理上次异常退出残留的子进程（按模块缓存路径匹配，不会误伤其它 U 盘）。 */
async function cleanupStaleProcesses() {
  const { modulesCacheDir } = getPaths();
  const pids = await listMatchingProcesses(modulesCacheDir);
  for (const pid of pids) {
    if (pid === process.pid) continue;
    stopProcessTree(pid);
  }
  if (pids.length) appendLog("stale-cleanup.log", `[${new Date().toISOString()}] killed=[${pids.join(",")}]\n`);
  return pids;
}

/** 网关是否在监听端口。 */
async function isGatewayRunning() {
  return isPortOpen(gatewayPort());
}

function ensureChatCompletionsEndpoint(config) {
  config.gateway = config.gateway || {};
  config.gateway.http = config.gateway.http || {};
  config.gateway.http.endpoints = config.gateway.http.endpoints || {};
  config.gateway.http.endpoints.chatCompletions = config.gateway.http.endpoints.chatCompletions || {};
  if (config.gateway.http.endpoints.chatCompletions.enabled !== true) {
    config.gateway.http.endpoints.chatCompletions.enabled = true;
    return true;
  }
  return false;
}

/** 启动网关：同步后台模型 → 启用 chatCompletions → 拉起进程并等待端口就绪。 */
async function startGateway() {
  if (gatewayProcess && !gatewayProcess.killed) {
    return { ok: true, message: "网关已在运行", alreadyRunning: true };
  }
  try {
    const config = readConfig();
    if (ensureChatCompletionsEndpoint(config)) writeConfig(config);
  } catch (error) {
    console.error("[gateway] ensure chatCompletions failed:", error.message);
  }
  try { await syncBackendModels("gateway-start"); } catch { /* 后台同步失败不阻塞启动 */ }
  const child = startChild("gateway", moduleEntryPath(), ["gateway", "--port", String(gatewayPort()), "--verbose"], { runtimeConfig: true });
  gatewayProcess = child;
  const reachable = await waitForPort(gatewayPort(), 45000);
  if (reachable) {
    void reportEvent({ eventType: "gateway_start_success", level: "info", message: "Gateway started.", details: { ready: true } });
    // 网关内的钉钉 Stream 循环不可靠，桥接进程在网关就绪后接管。
    setTimeout(() => { startDingTalkBridge().catch(() => {}); }, 3000);
  } else {
    void reportEvent({ eventType: "gateway_start_failed", level: "error", message: "Gateway port not reachable.", details: { ready: false } });
  }
  return { ok: reachable, message: reachable ? "网关已启动" : "网关启动超时，请查看日志" };
}

/** 停止网关并等待端口释放。 */
async function stopGateway() {
  stopDingTalkBridge();
  const port = gatewayPort();
  const pids = await listMatchingProcesses(`openclaw.mjs gateway --port ${port}`);
  for (const pid of pids) stopProcessTree(pid);
  if (gatewayProcess && !gatewayProcess.killed) stopProcessTree(gatewayProcess.pid);
  gatewayProcess = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return { ok: true, stopped: true, message: "Gateway stopped", stoppedPids: pids };
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return { ok: false, message: "停止网关失败：端口仍被占用", stoppedPids: pids };
}

/** 重启网关（通道配置变化后调用）。 */
async function restartGateway(reason) {
  appendLog("gateway.log", `[${new Date().toISOString()}] restart for ${reason}\n`);
  await stopGateway();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return startGateway();
}

function stopDingTalkBridge() {
  if (dingTalkBridgeProcess && !dingTalkBridgeProcess.killed) stopProcessTree(dingTalkBridgeProcess.pid);
  dingTalkBridgeProcess = null;
}

/** 启动钉钉 Stream 桥接进程（数据目录配置启用后调用，凭证经环境变量注入）。 */
async function startDingTalkBridge() {
  stopDingTalkBridge();
  const { decryptConfigSecrets } = require("./secret-crypto");
  const { readJsonFile } = require("./config-utils");
  const { dingtalkChannelConfigPath, bridgeDir } = getPaths();
  const fileConfig = decryptConfigSecrets(readJsonFile(dingtalkChannelConfigPath));
  if (!(fileConfig && fileConfig.enabled === true && fileConfig.clientId && fileConfig.clientSecret)) return false;
  const bridgePath = path.join(bridgeDir, "dingtalk-stream-bridge.mjs");
  if (!fs.existsSync(bridgePath)) return false;
  // 网关内的 Stream 循环不可靠：桥接进程运行期间关闭通道内建连接，避免重复消费。
  const full = readConfig();
  full.channels = full.channels || {};
  full.channels["openclaw-dingtalk-channel"] = { ...(full.channels["openclaw-dingtalk-channel"] || {}), enabled: false };
  writeConfig(full);
  dingTalkBridgeProcess = startChild("dingtalk-bridge", bridgePath, [], {
    extraEnv: {
      DINGTALK_BRIDGE_CLIENT_ID: fileConfig.clientId,
      DINGTALK_BRIDGE_CLIENT_SECRET: fileConfig.clientSecret,
      DINGTALK_BRIDGE_DEBUG: fileConfig.debug === true ? "1" : "0",
      OPENCLAW_GATEWAY_TOKEN: readConfig().gateway?.auth?.token || "",
    },
  });
  return true;
}

/** 启动微信登录子进程（扫码绑定）。 */
function startWechatLoginChild() {
  const child = startChild("wechat-login", moduleEntryPath(), ["channels", "login", "--channel", "openclaw-weixin"], { runtimeConfig: true });
  wechatLoginProcess = child;
  return child;
}

function stopWechatLoginChild() {
  if (wechatLoginProcess && !wechatLoginProcess.killed) stopProcessTree(wechatLoginProcess.pid);
  wechatLoginProcess = null;
}

/** 登记插件加载路径到 openclaw.json（通道启用后调用）。 */
function registerPluginLoadPath(pluginPath) {
  const config = readConfig();
  if (ensurePluginLoadPath(config, pluginPath)) writeConfig(config);
}

/** 应用退出时的进程清理：杀全部登记子进程并清空登记文件。 */
async function shutdownAll() {
  stopDingTalkBridge();
  stopWechatLoginChild();
  try { await stopGateway(); } catch { /* 退出路径尽力清理 */ }
  const pids = readChildPids();
  for (const pid of pids) stopProcessTree(pid);
  writeChildPids([]);
}

module.exports = {
  cleanupStaleProcesses,
  isGatewayRunning,
  registerPluginLoadPath,
  restartGateway,
  shutdownAll,
  startDingTalkBridge,
  startGateway,
  startWechatLoginChild,
  stopDingTalkBridge,
  stopGateway,
  stopProcessTree,
  waitForPort,
};

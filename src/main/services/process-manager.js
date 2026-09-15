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
const timing = require("../../shared/timing.json");
const { prepareRuntimeConfig } = require("./secret-crypto");
const { readConfig, writeConfig, ensurePluginLoadPath } = require("./config-store");
const { ensureModules, isRuntimeWarm, markRuntimeWarm, moduleEntryPath } = require("./modules");
const { syncBackendModels, reportEvent } = require("./backend-client");
const { appendLogLine, appendRawLog } = require("./logs");
const { createQrSession } = require("./qr-session");

let gatewayProcess = null;
let dingTalkBridgeProcess = null;
let wardenProcess = null;

// 微信登录会话：登录子进程由本模块独占，其 stdout 输出同时驱动二维码与状态机，
// 因此预热、刷新、UI 轮询三条路径共享同一份状态，不会出现"已扫码却仍提示待扫码"。
// 状态与过期自动重建策略由 qr-session 统一维护，这里只管子进程与输出解析。
let wechatLoginProcess = null;
/** 用户主动"重新绑定"期间为 true：此时即使已绑定也展示二维码。 */
let wechatRebinding = false;
/** 重新绑定前已绑定的账号：新号绑成功后据此清理旧号，避免两个微信号同时在线。 */
let wechatRebindBaseline = [];
let wechatLoginOutput = "";
const wechatSession = createQrSession({
  messages: { waiting: "请用微信扫码", ended: "登录进程已退出，正在重新生成二维码..." },
  start: (options) => spawnWechatLoginChild(options),
  stop: () => killWechatLoginProcess(),
});

/** 网关端口来自应用配置，运营可通过覆盖文件调整。 */
function gatewayPort() {
  return Number(getAppConfig().ports?.gateway || 18789);
}

function logDirEnsure() {
  const { logsDir } = getPaths();
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", WARDEN_CHECK_INTERVAL_MS: String(timing.processWarden.checkIntervalMs) },
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

/** 启动业务子进程：日志落盘、环境指向模块缓存与数据目录，可注入附加环境变量。
 *  pipeStdout: 输出走管道返回给调用方（而非日志文件），由调用方自行消费与落盘。 */
function startChild(name, scriptPath, args, options = {}) {
  const { dataDir, stateDir, configPath, productRoot } = getPaths();
  const logsDir = logDirEnsure();
  const modulesDir = ensureModules();
  const stdio = options.pipeStdout
    ? ["ignore", "pipe", "pipe"]
    : ["ignore", fs.openSync(path.join(logsDir, `${name}.log`), "a"), fs.openSync(path.join(logsDir, `${name}.err.log`), "a")];
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
    stdio,
    windowsHide: true,
    // POSIX 上独立进程组，便于整组终止；Windows 由 taskkill /T 处理进程树。
    detached: process.platform !== "win32",
  });
  child.unref();
  registerChild(child);
  appendLogLine(`${name}.start.log`, `pid=${child.pid} script=${scriptPath}`);
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

async function waitForPort(port, timeoutMs = timing.gateway.startWaitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, timing.gateway.portProbeIntervalMs));
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
  if (pids.length) appendLogLine("stale-cleanup.log", `killed=[${pids.join(",")}]`);
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
  // 即将按最新配置启动，此前累积的"待重启"标记全部落地。
  pendingRestartReasons.clear();
  try {
    const config = readConfig();
    if (ensureChatCompletionsEndpoint(config)) writeConfig(config);
  } catch (error) {
    console.error("[gateway] ensure chatCompletions failed:", error.message);
  }
  try { await syncBackendModels("gateway-start"); } catch { /* 后台同步失败不阻塞启动 */ }
  const child = startChild("gateway", moduleEntryPath(), ["gateway", "--port", String(gatewayPort()), "--verbose"], { runtimeConfig: true });
  gatewayProcess = child;
  const reachable = await waitForPort(gatewayPort(), timing.gateway.startWaitTimeoutMs);
  if (reachable) {
    void reportEvent({ eventType: "gateway_start_success", level: "info", message: "Gateway started.", details: { ready: true } });
    // 网关内的钉钉 Stream 循环不可靠，桥接进程在网关就绪后接管。
    setTimeout(() => { startDingTalkBridge().catch(() => {}); }, timing.dingtalkBridge.startDelayMs);
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
  const deadline = Date.now() + timing.gateway.stopTimeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortOpen(port))) return { ok: true, stopped: true, message: "Gateway stopped", stoppedPids: pids };
    await new Promise((resolve) => setTimeout(resolve, timing.gateway.portProbeIntervalMs));
  }
  return { ok: false, message: "停止网关失败：端口仍被占用", stoppedPids: pids };
}

/** 重启排队：两个通道先后保存（或绑定成功）时重启流程串行执行，避免停/启交叉。 */
let restartChain = Promise.resolve();

/** 待重启原因：通道保存/扫码绑定只写配置并登记在这里，由界面的"重启生效"按钮一次应用，
 *  避免连改几个通道要挨个等十几秒的网关重启。网关真正启动时读的是最新配置，标记随之清空。 */
const pendingRestartReasons = new Set();

/** 标记"有配置变更等待网关重启加载"。 */
function markConfigPendingRestart(reason) {
  pendingRestartReasons.add(String(reason || "config-changed"));
}

/** 是否有等待重启生效的配置变更（运行页/通道工作区据此显示"重启生效"按钮）。 */
function hasPendingRestart() {
  return pendingRestartReasons.size > 0;
}

/** 等待重启生效的原因列表（界面展示"因为什么要重启"用）。 */
function listPendingRestartReasons() {
  return [...pendingRestartReasons];
}

/** 重启网关（通道配置变化后调用）。 */
function restartGateway(reason) {
  const run = async () => {
    appendLogLine("gateway.log", `restart for ${reason}`);
    await stopGateway();
    await new Promise((resolve) => setTimeout(resolve, timing.gateway.restartSettleMs));
    return startGateway();
  };
  restartChain = restartChain.then(run, run);
  return restartChain;
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

/** 微信通道是否已在配置中启用（未启用时不在后台拉起登录进程）。 */
function isWeixinChannelEnabled() {
  try {
    return readConfig()?.plugins?.entries?.["openclaw-weixin"]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * 登录子进程输出 → 界面状态映射。
 * 文案取自微信插件（openclaw-weixin）真实 stdout：扫码后先打印"正在验证"，
 * 绑定成功打印"已将此 OpenClaw 连接到微信"。同一条输出命中多条时按本表顺序取首个。
 */
const WECHAT_LOGIN_SIGNALS = [
  { status: "success", message: "已扫码并绑定成功，微信通道已启用", patterns: ["已将此 OpenClaw 连接到微信", "已连接过此 OpenClaw", "绑定成功", "登录成功"] },
  { status: "scanned", message: "已扫码，请在手机上确认", patterns: ["正在验证", "扫描成功", "已扫描"] },
  { status: "expired", message: "二维码已过期，正在重新生成...", patterns: ["二维码已过期", "二维码多次失效"] },
  { status: "failed", message: "登录失败，请在微信中重试", patterns: ["多次输入错误", "登录超时", "登录失败"] },
];

/** 按输出片段推进登录状态；已成功不再回退，二维码过期时立即作废旧码。 */
function applyWechatLoginSignal(text) {
  for (const signal of WECHAT_LOGIN_SIGNALS) {
    if (!signal.patterns.some((pattern) => text.includes(pattern))) continue;
    wechatSession.reportStatus(signal.status, signal.message);
    // 绑定成功：退出重绑态，并清掉这次替换掉的旧账号。
    if (signal.status === "success") {
      wechatRebinding = false;
      void dropReplacedWeixinAccounts();
    }
    return;
  }
}

/** 从登录进程输出中提取最新的二维码链接（过期换码后必须取最后一条）。 */
function extractWeixinQrUrl(output) {
  const urls = String(output || "").match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  const matched = urls.filter((url) => /liteapp\.weixin\.qq\.com\/q\//i.test(url) || /qrcode=|bot_type=3/i.test(url));
  return matched.length ? matched[matched.length - 1] : "";
}

/** 当前微信登录子进程（已退出返回 null；进程被外部清杀时也能识别）。 */
function getWechatLoginProcess() {
  if (!wechatLoginProcess || wechatLoginProcess.killed) return null;
  try {
    process.kill(wechatLoginProcess.pid, 0);
  } catch {
    wechatLoginProcess = null;
    return null;
  }
  return wechatLoginProcess;
}

/** 消费登录进程输出：提取最新二维码、推进状态并落日志（每个进程只接一次）。 */
function consumeWechatLoginOutput(child) {
  const consume = (chunk) => {
    const text = chunk.toString();
    wechatLoginOutput += text;
    applyWechatLoginSignal(text);
    const qr = extractWeixinQrUrl(wechatLoginOutput);
    if (qr && qr !== wechatSession.snapshot().qr) {
      // 记录从拉起子进程到拿到二维码的耗时，便于排查"重新绑定很慢"这类反馈。
      appendLogLine("wechat-login.log", `qr ready in ${wechatSession.attemptElapsedMs()}ms`);
      // 能出码说明本机组件已经跑起来过，此后的启动不再有冷启动代价。
      markRuntimeWarm();
    }
    wechatSession.reportQr(qr);
    appendRawLog("wechat-login.log", text);
  };
  if (child.stdout) child.stdout.on("data", consume);
  if (child.stderr) child.stderr.on("data", consume);
  child.on("error", (error) => {
    appendRawLog("wechat-login.log", `login process error: ${error.message}`);
    wechatSession.reportStatus("failed", `微信登录进程启动失败：${error.message}`);
  });
  // 进程结束但未绑定成功（超时、被清杀）：会话回到待重建，由状态查询按冷却重建。
  child.on("exit", () => wechatSession.attemptEnded());
}

/** 拉起一次登录尝试（会话的 start 钩子）：注册插件路径 → 起子进程 → 接输出。
 *  状态、二维码与自动重建计数由 wechatSession 维护，这里只管进程本身。 */
function spawnWechatLoginChild(options = {}) {
  if (options.rebinding) wechatRebinding = true;
  killWechatLoginProcess();
  // 确保微信插件已启用并注册加载路径，否则登录子进程会卡在交互式安装提示。
  try {
    const { pluginsDir } = getPaths();
    const config = readConfig();
    if (ensurePluginLoadPath(config, path.join(pluginsDir, "openclaw-weixin"))) {
      config.plugins = config.plugins || {};
      config.plugins.entries = config.plugins.entries || {};
      config.plugins.entries["openclaw-weixin"] = { ...(config.plugins.entries["openclaw-weixin"] || {}), enabled: true };
      writeConfig(config);
    }
  } catch { /* 插件注册失败时仍尝试启动，行为与旧版一致 */ }
  // 二维码链接需从子进程输出流中实时提取，因此必须走管道而非日志文件。
  const child = startChild("wechat-login", moduleEntryPath(), ["channels", "login", "--channel", "openclaw-weixin"], { runtimeConfig: true, pipeStdout: true });
  wechatLoginProcess = child;
  wechatLoginOutput = "";
  consumeWechatLoginOutput(child);
  return child;
}

/** 发起一次扫码尝试：已有存活进程直接复用；restart 表示用户主动换码。 */
function startWechatLoginChild(options = {}) {
  const running = getWechatLoginProcess();
  if (running && !options.restart) return running;
  if (options.restart) wechatSession.halt();
  return wechatSession.begin(options) ? wechatLoginProcess : null;
}

/** 停掉当前登录子进程（会话的 stop 钩子）。 */
function killWechatLoginProcess() {
  const child = getWechatLoginProcess();
  if (child) {
    try { stopProcessTree(child.pid); } catch { /* 进程可能已退出 */ }
  }
  wechatLoginProcess = null;
  wechatLoginOutput = "";
}

/** 出厂重置配套：清空微信登录的内存态（扫码会话的成功标记、重绑过程）。
 *  主进程不随重置重启，不清的话界面会凭旧会话继续显示"已绑定"。 */
function resetWechatLoginState() {
  killWechatLoginProcess();
  wechatSession.reset();
  wechatRebinding = false;
  wechatRebindBaseline = [];
}

/**
 * 重新绑定到另一个微信号后清理旧账号：只保留这次新绑上的账号。
 * 同一个微信号重扫时插件自身会去重（clearStaleAccountsForUserId），这里不需要动手。
 */
async function dropReplacedWeixinAccounts() {
  const baseline = wechatRebindBaseline;
  wechatRebindBaseline = [];
  if (!baseline.length) return;
  try {
    const channels = require("./channels");
    const current = channels.listWeixinAccounts();
    const fresh = current.filter((id) => !baseline.includes(id));
    if (!fresh.length) return;
    const removed = channels.dropWeixinAccounts(baseline);
    if (!removed.length) return;
    appendLogLine("wechat-login.log", `dropped replaced accounts=[${removed.join(",")}] kept=[${fresh.join(",")}]`);
    // 网关启动时读一次账号列表：换了号要重启才能停止继续服务旧账号。
    markConfigPendingRestart("weixin-account-changed");
  } catch { /* 清理失败不影响新绑定生效 */ }
}

/** 微信是否已经绑定过（插件落盘的账号文件，重启后依然有效）。 */
function isWeixinBound() {
  try {
    return require("./channels").listWeixinAccounts().length > 0;
  } catch {
    return false;
  }
}

/**
 * 微信登录会话快照（UI 轮询入口）：{ running, status, qr, message }。
 * 登录进程已退出且二维码不可用时按冷却时间后台重建，前端下一次轮询即可拿到新码；
 * 连续自动重建超过上限后不再自动拉起，改为提示用户点击"刷新二维码"（人工点击会重置计数）。
 */
function getWechatLoginSnapshot() {
  // 已绑定且不在重新绑定过程中：一律报"已绑定"，界面不展示二维码。
  if (isWeixinBound() && !wechatRebinding) {
    return { running: Boolean(getWechatLoginProcess()), status: "success", qr: "", message: "微信已绑定，通道已启用" };
  }
  if (!isWeixinChannelEnabled()) {
    const snapshot = wechatSession.snapshot();
    return { ...snapshot, status: snapshot.qr ? snapshot.status : "idle", message: snapshot.qr ? snapshot.message : "微信通道未启用" };
  }
  // 过期后的自动重建（冷却 + 次数上限）在 snapshot() 里统一处理。
  return wechatSession.snapshot();
}

/**
 * 等待可用二维码（无可用进程时按需拉起），超时返回空串。
 * options.restart=true 表示用户主动"重新绑定"，此时即使已绑定也允许换新码。
 */
function waitForWechatQr(options = {}) {
  const timeoutMs = options.timeoutMs || timing.wechatScan.qrWaitTimeoutMs;
  if (options.restart) {
    // 用户主动重新绑定：先进入重绑态，否则下一次状态查询会立刻把界面判回"已绑定"。
    wechatRebinding = true;
    // 记下当前绑定，等新号绑成功后清掉旧的；不在点击时就清，避免用户点了不扫把可用绑定弄没。
    if (!wechatRebindBaseline.length) wechatRebindBaseline = require("./channels").listWeixinAccounts();
    // 手上这个码足够新就直接复用，省掉一次子进程冷启动（实测约 5 秒）。
    const warmQr = wechatSession.qrAge() < timing.wechatScan.qrReuseWindowMs && getWechatLoginProcess();
    if (warmQr) {
      appendLogLine("wechat-login.log", `reuse warm qr age=${wechatSession.qrAge()}ms`);
      return wechatSession.waitForQr(timeoutMs);
    }
    wechatSession.halt();
  }
  // 已经绑定过就别再拉新进程生成二维码（除非用户明确要重新绑定）。
  if (!options.restart && isWeixinBound()) return Promise.resolve("");
  startWechatLoginChild(options.restart ? { restart: true } : {});
  return wechatSession.waitForQr(timeoutMs);
}

/**
 * 后台预生成微信登录二维码（仅当微信通道已启用）。
 * force=true 由面板打开时调用：即使已绑定也预热，用户点"重新绑定"时能立刻拿到二维码。
 */
function prewarmWechatLogin(options = {}) {
  if (getWechatLoginProcess()) return false;
  // warmup=true 由启动阶段调用：通道还没启用也提前把组件拉起来，把首次冷启动的等待挪到向导之前。
  if (!options.warmup && !isWeixinChannelEnabled()) return false;
  if (isWeixinBound() && !options.force) return false;
  try {
    startWechatLoginChild();
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动阶段等首次冷启动完成：本机组件还没热过时，一直等到二维码就绪（或超时）再返回，
 * 让启动加载页把这一分钟挡住，用户进向导后 BOT 页直接有码。
 * 已经热过（有 .zgy-warm 标记）或已绑定微信号时立即返回，不额外拉起进程。
 */
async function warmupWechatRuntime() {
  if (isRuntimeWarm() || isWeixinBound()) return { ready: true, warmed: false };
  const qr = await waitForWechatQr({ timeoutMs: timing.boot.warmupTimeoutMs });
  appendLogLine("electron-shell.log", qr ? "wechat runtime ready" : "wechat runtime warmup timed out");
  return { ready: Boolean(qr), warmed: true };
}

/** 登记插件加载路径到 openclaw.json（通道启用后调用）。 */
function registerPluginLoadPath(pluginPath) {
  const config = readConfig();
  if (ensurePluginLoadPath(config, pluginPath)) writeConfig(config);
}

/** 应用退出时的进程清理：杀全部登记子进程并清空登记文件。 */
async function shutdownAll() {
  stopDingTalkBridge();
  killWechatLoginProcess();
  try { await stopGateway(); } catch { /* 退出路径尽力清理 */ }
  const pids = readChildPids();
  for (const pid of pids) stopProcessTree(pid);
  writeChildPids([]);
}

module.exports = {
  cleanupStaleProcesses,
  getWechatLoginProcess,
  getWechatLoginSnapshot,
  prewarmWechatLogin,
  isGatewayRunning,
  markConfigPendingRestart,
  hasPendingRestart,
  listPendingRestartReasons,
  registerPluginLoadPath,
  restartGateway,
  resetWechatLoginState,
  shutdownAll,
  startDingTalkBridge,
  startGateway,
  startWechatLoginChild,
  warmupWechatRuntime,
  stopDingTalkBridge,
  stopGateway,
  stopProcessTree,
  waitForPort,
  waitForWechatQr,
};

/**
 * 启动检查与一键修复：环境自检（模块、插件、端口、配置、磁盘空间）
 * 与自动修复（恢复出厂网关配置、激活微信通道、重启网关）。
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { getPaths } = require("../paths");
const { readConfig, writeConfig } = require("./config-store");
const { readWecomConfig, readFeishuConfig } = require("./channels");
const { moduleEntryPath, findQQBotPluginPaths } = require("./modules");
const { isGatewayRunning, startGateway } = require("./process-manager");

function formatBytes(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return "未知";
  if (size >= 1024 * 1024 * 1024) return Math.round(size / 1024 / 1024 / 1024) + " GB";
  return Math.round(size / 1024 / 1024) + " MB";
}

/** U 盘剩余空间检查（Windows 精确，其余平台跳过）。 */
function getDiskFreeInfo() {
  if (process.platform !== "win32") return { ok: true, detail: "空间检查跳过" };
  try {
    const { productRoot } = getPaths();
    const drive = path.parse(productRoot).root.replace(/[:\\]/g, "");
    const free = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `(Get-PSDrive -Name '${drive}').Free`], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    }).trim();
    const bytes = Number(free);
    return { ok: !Number.isFinite(bytes) || bytes > 300 * 1024 * 1024, detail: "剩余 " + formatBytes(bytes) };
  } catch {
    return { ok: true, detail: "空间检查不可用" };
  }
}

function buildCheck(label, ok, okDetail, badDetail) {
  return { label, ok, detail: ok ? okDetail : badDetail };
}

/** 全量启动检查清单。 */
async function buildRepairChecks() {
  const { modulesCacheDir } = getPaths();
  const gatewayPort = readConfig().gateway?.port || 18789;
  const checks = [];
  checks.push(buildCheck(
    "OpenClaw 程序文件",
    fs.existsSync(moduleEntryPath()),
    "openclaw.mjs 已就绪",
    "缺少 openclaw.mjs，请重新运行一次客户端完成模块装载",
  ));
  const pluginRoot = modulesCacheDir;
  for (const [label, pluginRelative] of [
    ["微信插件", path.join("@tencent-weixin", "openclaw-weixin")],
    ["飞书插件", path.join("@openclaw", "feishu")],
  ]) {
    const installed = fs.existsSync(path.join(pluginRoot, pluginRelative));
    checks.push(buildCheck(label, installed, "已安装", `缺少 ${pluginRelative.replaceAll(path.sep, "/")}`));
  }
  // 企业微信走按需 payload（openclaw 官方安装布局），配置时自动装进 data 的 extensions 目录。
  const wecomInstalled = fs.existsSync(path.join(getPaths().stateDir, "extensions", "wecom-openclaw-plugin", "openclaw.plugin.json"));
  checks.push(buildCheck("企业微信插件", wecomInstalled, "已安装", "首次配置企业微信时自动安装"));
  const qqbotInstalled = findQQBotPluginPaths().length > 0;
  checks.push(buildCheck("QQ 插件", qqbotInstalled, "QQ 插件已安装", "QQ 插件尚未安装，首次配置 QQ 时自动安装"));
  const gatewayRunning = await isGatewayRunning();
  checks.push(buildCheck("端口 " + gatewayPort, gatewayRunning, "网关正在运行", "网关未运行，可通过启动按钮拉起"));
  let configOk = false;
  let configDetail = "配置读取失败";
  try {
    const config = readConfig();
    const gateway = config.gateway || {};
    const wecom = readWecomConfig();
    const feishu = readFeishuConfig();
    configOk = gateway.mode === "local" && Number(gateway.port || 18789) === 18789;
    const channelHint = wecom.configured ? "企业微信已配置" : feishu.configured ? "飞书已配置" : "渠道可按需配置";
    configDetail = configOk ? `配置正常，${channelHint}` : "gateway.mode 或端口异常";
  } catch (error) {
    configDetail = error.message;
  }
  checks.push({ label: "网关配置", ok: configOk, detail: configDetail });
  checks.push(getDiskFreeInfo());
  return checks;
}

/** 一键修复：恢复标准网关配置、激活微信通道、必要时拉起网关。 */
async function runPortableRepair() {
  const config = readConfig();
  config.gateway = config.gateway || {};
  config.gateway.mode = "local";
  config.gateway.port = 18789;
  config.gateway.bind = config.gateway.bind || "loopback";
  config.gateway.auth = config.gateway.auth || { mode: "token" };
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries["openclaw-weixin"] = { ...(config.plugins.entries["openclaw-weixin"] || {}), enabled: true };
  config.update = config.update || {};
  config.update.checkOnStart = false;
  config.update.auto = { ...(config.update.auto || {}), enabled: false };
  writeConfig(config);
  if (!(await isGatewayRunning())) {
    await startGateway();
  }
  return buildRepairChecks();
}

module.exports = { buildRepairChecks, runPortableRepair };

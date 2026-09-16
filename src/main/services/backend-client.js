/**
 * 后台客户端：授权校验、模型配置同步、设备事件上报。
 * 设备身份 = U 盘指纹（usbId）+ 本机标识（machineId），后台地址与授权码来自应用配置。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getPaths } = require("../paths");
const { getAppConfig, configLookupHint } = require("../app-config");
const { getUsbId, getDriveInfo, getMachineId } = require("./fingerprint");
const { boundLicenseKey } = require("./license");
const { decryptConfigSecrets, encryptConfigSecrets, writeJsonAtomic } = require("./secret-crypto");
const { readConfig, writeConfig } = require("./config-store");
const timing = require("../../shared/timing.json");

const DEFAULT_TIMEOUT_MS = timing.backend.requestTimeoutMs;

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function logPath() {
  return path.join(getPaths().stateDir, "logs", "backend-client.log");
}

function writeLog(message, details) {
  try {
    const file = logPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const line = { time: new Date().toISOString(), message, ...(details === undefined ? {} : { details }) };
    fs.appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  } catch { /* 日志失败不影响业务 */ }
}

/**
 * 后台接入信息。授权码只来自本盘绑定文件（--bind-usb --license 写入），一张盘一个授权码，所以同一个安装包能发给不同客户，包内不保留任何授权码。
 * 后台地址与产品版本来自包内配置，地址不允许外部提供（能被改就等于架空授权）。
 * 这里不声明 channel：下发版本与模型走哪条通道，由后台按授权记录上的 channel 决定。
 */
function readBackendSettings() {
  const backend = getAppConfig().backend || {};
  const product = getAppConfig().product || {};
  return {
    licenseKey: boundLicenseKey(),
    backendUrl: String(backend.url || "").trim().replace(/\/+$/, ""),
    clientVersion: String(product.version || "unknown").trim(),
  };
}

/**
 * 取后台接入信息，缺任何一项直接抛错：后台是必需依赖，配不全属于部署事故。
 * override.licenseKey 供命令行"先把授权码拿去后台核对再绑定"使用（此时绑定文件还没写出来）。
 */
function requireBackendSettings(override = {}) {
  const settings = readBackendSettings();
  if (!settings.backendUrl) {
    throw new Error(`未配置管理后台地址（app.config.json 的 backend.url）。\n${configLookupHint()}`);
  }
  const licenseKey = String(override.licenseKey || settings.licenseKey).trim();
  if (!licenseKey) throw new Error("本 U 盘未绑定授权码，请执行 zgyclaw.exe --bind-usb --license 你的授权码。\n（Windows 是 zgyclaw.exe，macOS 是 小龙虾U盘版.app/Contents/MacOS/zgyclaw）");
  return { ...settings, licenseKey };
}

function joinUrl(base, pathname) {
  return String(base || "").replace(/\/+$/, "") + pathname;
}

async function postJson(url, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
    if (parsed && parsed.ok === false) {
      const error = new Error(parsed.message || parsed.code || "后台返回失败");
      error.code = parsed.code;
      error.response = parsed;
      throw error;
    }
    return parsed && Object.prototype.hasOwnProperty.call(parsed, "data") ? parsed.data : parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** 请求上下文：本机与 U 盘身份。override.licenseKey 供命令行"先核对再绑定"用。 */
function clientContext(override = {}) {
  const settings = readBackendSettings();
  return {
    licenseKey: String(override.licenseKey || settings.licenseKey).trim(),
    usbId: getUsbId(),
    machineId: getMachineId(),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    driveFs: String(getDriveInfo().fileSystem || ""),
    clientVersion: settings.clientVersion,
  };
}

/** 上报一条事件；后台不可用时只记日志（心跳与事件不许影响客户端功能）。 */
async function reportEvent(event) {
  const settings = readBackendSettings();
  if (!settings.backendUrl || !settings.licenseKey) return { ok: false, skipped: true };
  const ctx = clientContext();
  try {
    await postJson(joinUrl(settings.backendUrl, "/api/client/event"), {
      licenseKey: ctx.licenseKey,
      usbId: ctx.usbId,
      machineId: ctx.machineId,
      eventType: event.eventType || "client_event",
      level: event.level || "info",
      message: event.message || "",
      details: event.details || {},
    }, timing.backend.eventTimeoutMs);
    return { ok: true };
  } catch (error) {
    writeLog("event report failed", { error: error.message, event });
    return { ok: false, error: error.message };
  }
}

/**
 * 后台授权校验。返回 rejected=true 表示**后台明确拒绝**（授权无效/过期/U 盘不匹配等业务错误码），启动链据此拒绝启动；网络不通、超时、后台 5xx 属于"无法判定"，只记日志不拦截——否则后台一故障或客户在内网环境就会集体打不开，而本地 U 盘指纹授权此时仍在把关。
 * override.licenseKey 用于命令行绑定前核对指定授权码（此时绑定文件还没写出来）。
 */
async function checkBackendLicense(override = {}) {
  const settings = requireBackendSettings(override);
  const ctx = clientContext(override);
  try {
    const data = await postJson(joinUrl(settings.backendUrl, "/api/client/license/check"), {
      licenseKey: ctx.licenseKey,
      usbId: ctx.usbId,
      machineId: ctx.machineId,
      hostname: ctx.hostname,
      os: ctx.os,
      arch: ctx.arch,
      driveFs: ctx.driveFs,
      clientVersion: ctx.clientVersion,
    });
    writeLog("backend license check success", { usbId: ctx.usbId });
    await reportEvent({ eventType: "license_check_success", level: "info", message: "Backend license check succeeded." });
    return { ok: true, data };
  } catch (error) {
    // 业务拒绝由 postJson 带出后台的 code（如 USB_MISMATCH）；网络/服务器故障没有 code。
    const rejected = Boolean(error.code);
    const result = {
      ok: false,
      rejected,
      message: error.message,
      code: error.code || "BACKEND_UNREACHABLE",
    };
    writeLog(rejected ? "backend license rejected" : "backend license check unreachable", result);
    return result;
  }
}

/** 设备心跳：刷新后台"最近在线"，让运营侧能看到客户端当前是否在跑（失败静默，下个周期重试）。 */
async function devicePing() {
  const settings = readBackendSettings();
  if (!settings.backendUrl || !settings.licenseKey) return { ok: false, skipped: true };
  const ctx = clientContext();
  try {
    await postJson(joinUrl(settings.backendUrl, "/api/client/device/ping"), {
      licenseKey: ctx.licenseKey,
      usbId: ctx.usbId,
      machineId: ctx.machineId,
      hostname: ctx.hostname,
      os: ctx.os,
      arch: ctx.arch,
      driveFs: ctx.driveFs,
      clientVersion: ctx.clientVersion,
    }, timing.backend.eventTimeoutMs);
    writeLog("backend device ping ok", { usbId: ctx.usbId });
    return { ok: true };
  } catch (error) {
    writeLog("backend device ping failed", { error: error.message });
    return { ok: false, error: error.message };
  }
}

function normalizeProviders(remoteProviders) {
  if (!remoteProviders || typeof remoteProviders !== "object" || Array.isArray(remoteProviders)) return {};
  const out = {};
  for (const [id, provider] of Object.entries(remoteProviders)) {
    if (id && provider && typeof provider === "object" && !Array.isArray(provider)) out[id] = { ...provider };
  }
  return out;
}

/** 后台下发 provider 的标记：后台不再下发时据此回收，避免配置里留幽灵条目。 */
const BACKEND_PROVIDER_SOURCE = "backend";

/**
 * 判断某个 provider 是否来自后台下发。后台下发的都会带 source 标记；
 * 没有标记但带 requiresClientKey 的也算（该字段只有后台下发会写）。
 */
function isBackendProvider(provider) {
  return Boolean(provider && typeof provider === "object" && (provider.source === BACKEND_PROVIDER_SOURCE || provider.requiresClientKey === true));
}

/** 把后台模型配置合并进 openclaw.json；后台已不下发的内置 provider 一并回收。 */
function mergeRemoteModels(remote) {
  const config = readConfig();
  const providers = normalizeProviders(remote && remote.providers);
  const providerIds = Object.keys(providers);

  config.models = config.models && typeof config.models === "object" ? config.models : {};
  config.models.providers = config.models.providers && typeof config.models.providers === "object" ? config.models.providers : {};

  // 回收后台来源但这次没下发到的 provider（含运营在后台关掉的）：只动带后台标记的，客户自己填的 provider 不碰。
  const removed = [];
  for (const [id, provider] of Object.entries(config.models.providers)) {
    if (providerIds.includes(id) || !isBackendProvider(provider)) continue;
    delete config.models.providers[id];
    removed.push(id);
  }
  if (!providerIds.length && !removed.length) return { changed: false, reason: "no providers returned" };

  for (const providerId of providerIds) {
    config.models.providers[providerId] = {
      ...(config.models.providers[providerId] || {}),
      ...providers[providerId],
      source: BACKEND_PROVIDER_SOURCE,
    };
  }

  config.agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  config.agents.defaults = config.agents.defaults && typeof config.agents.defaults === "object" ? config.agents.defaults : {};
  if (removed.length) {
    const current = String(config.agents.defaults.model || "");
    if (removed.some((id) => current.startsWith(`${id}/`))) {
      const fallbackProvider = Object.entries(config.models.providers).find(([, provider]) => Array.isArray(provider?.models) && provider.models.length);
      config.agents.defaults.model = (remote && remote.defaultModel)
        || (fallbackProvider ? `${fallbackProvider[0]}/${fallbackProvider[1].models[0].id}` : "");
      writeLog("backend models removed; default model switched", { removed, model: config.agents.defaults.model });
    }
  }
  if (remote && remote.defaultModel && (remote.forceDefault || !config.agents.defaults.model)) {
    config.agents.defaults.model = remote.defaultModel;
  }
  if (!config.agents.defaults.thinkingDefault) config.agents.defaults.thinkingDefault = "off";
  config.agents.defaults.compaction = config.agents.defaults.compaction && typeof config.agents.defaults.compaction === "object"
    ? config.agents.defaults.compaction
    : {};
  const floor = Number(config.agents.defaults.compaction.reserveTokensFloor || 0);
  if (!Number.isFinite(floor) || floor < 20000) config.agents.defaults.compaction.reserveTokensFloor = 20000;

  writeConfig(config);
  return {
    changed: true,
    revision: remote && remote.revision,
    providerIds,
    removed,
    defaultModel: remote && remote.defaultModel,
    forceDefault: Boolean(remote && remote.forceDefault),
  };
}

/** 拉取后台模型配置并合并到本地。 */
async function syncBackendModels() {
  const settings = requireBackendSettings();
  const ctx = clientContext();
  try {
    const data = await postJson(joinUrl(settings.backendUrl, "/api/client/models/config"), {
      licenseKey: ctx.licenseKey,
      usbId: ctx.usbId,
      clientVersion: ctx.clientVersion,
    });
    const merged = mergeRemoteModels(data || {});
    writeLog("backend model sync success", merged);
    await reportEvent({ eventType: "models_sync_success", level: "info", message: "Backend model config synced.", details: merged });
    return { ok: true, data, merged };
  } catch (error) {
    writeLog("backend model sync failed", { message: error.message });
    await reportEvent({ eventType: "models_sync_failed", level: "warn", message: error.message, details: {} });
    return { ok: false, message: error.message };
  }
}

module.exports = {
  checkBackendLicense,
  devicePing,
  readBackendSettings,
  reportEvent,
  requireBackendSettings,
  syncBackendModels,
};

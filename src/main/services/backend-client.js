/**
 * 后台客户端：授权校验、模型配置同步、设备事件上报。
 * 设备身份 = U 盘指纹（usbId）+ 本机标识（machineId），后台地址与授权码来自应用配置。
 */
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { getPaths } = require("../paths");
const { getAppConfig } = require("../app-config");
const { getUsbId, getDriveInfo } = require("./fingerprint");
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

/** 后台接入信息：应用配置 backend 段 + 产品版本。 */
function readBackendSettings() {
  const backend = getAppConfig().backend || {};
  const product = getAppConfig().product || {};
  const licenseKey = String(backend.licenseKey || "").trim();
  const backendUrl = String(backend.url || "").trim().replace(/\/+$/, "");
  return {
    enabled: Boolean(backendUrl && licenseKey),
    licenseKey,
    backendUrl,
    channel: String(backend.channel || "stable").trim(),
    clientVersion: String(product.version || "unknown").trim(),
    reportOnly: backend.reportOnly !== false,
  };
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

/** 本机标识：首次生成后持久化，跨次启动稳定。 */
function getMachineId() {
  const { stateDir } = getPaths();
  const file = path.join(stateDir, "machine-id.txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch { /* 首次生成 */ }
  const seed = [os.hostname(), os.userInfo().username, os.platform(), os.arch(), crypto.randomUUID()].join("|");
  const id = `MACHINE-${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24).toUpperCase()}`;
  fs.writeFileSync(file, id + "\n", "utf8");
  return id;
}

function clientContext() {
  const settings = readBackendSettings();
  return {
    licenseKey: settings.licenseKey,
    usbId: getUsbId(),
    machineId: getMachineId(),
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    driveFs: String(getDriveInfo().fileSystem || ""),
    clientVersion: settings.clientVersion,
    channel: settings.channel,
  };
}

async function reportEvent(event) {
  const settings = readBackendSettings();
  if (!settings.enabled) return { ok: false, skipped: true };
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

/** 后台授权校验：reportOnly 模式仅上报不拦截。 */
async function checkBackendLicense() {  const settings = readBackendSettings();
  if (!settings.enabled) {
    writeLog("backend license check skipped", { reason: "backend.url 或 backend.licenseKey 未配置" });
    return { ok: true, skipped: true, reportOnly: true };
  }
  const ctx = clientContext();
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
    return { ok: true, data, reportOnly: settings.reportOnly };
  } catch (error) {
    const result = {
      ok: false,
      reportOnly: settings.reportOnly,
      message: error.message,
      code: error.code || "BACKEND_LICENSE_FAILED",
    };
    writeLog("backend license check failed", result);
    return result;
  }
}

/** 设备心跳：刷新后台"最近在线"，让运营侧能看到客户端当前是否在跑（失败静默，下个周期重试）。 */
async function devicePing() {
  const settings = readBackendSettings();
  if (!settings.enabled) return { ok: false, skipped: true };
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

/** 判断某个 provider 是否来自后台下发（早期写入的没有标记，用后台必带的 requiresClientKey 兜底识别）。 */
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

  // 回收：曾经由后台写入、这次不再下发的 provider（含运营在后台关掉的）。
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

/** 拉取后台模型配置并合并到本地；后台未配置时静默跳过。 */
async function syncBackendModels(reason) {
  const settings = readBackendSettings();
  if (!settings.enabled) {
    writeLog("backend model sync skipped", { reason: "backend 未配置" });
    return { ok: true, skipped: true };
  }
  const ctx = clientContext();
  try {
    const data = await postJson(joinUrl(settings.backendUrl, "/api/client/models/config"), {
      licenseKey: ctx.licenseKey,
      usbId: ctx.usbId,
      clientVersion: ctx.clientVersion,
      channel: ctx.channel,
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
  reportEvent,
  syncBackendModels,
};

/**
 * OAuth / OIDC 服务：Authorization Code + PKCE（S256）的公共客户端（public client）。
 * 桌面端藏不住密钥，因此不使用 client_secret——凭据安全由 PKCE 的 code_verifier 提供：
 * 授权码即使被截获，没有 verifier 也换不出令牌。
 * 登录在系统默认浏览器完成，回调落在本地临时监听器（oauth-listener.js）。
 * 会话令牌写入 U 盘数据目录并按敏感字段加密。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const { getAppConfig } = require("../app-config");
const timing = require("../../shared/timing.json");
const { encryptConfigSecrets, decryptConfigSecrets } = require("./secret-crypto");

function trimTrailingSlash(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function joinUrl(base, suffix) {
  return `${trimTrailingSlash(base)}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function safeText(value, fallback = "") {
  const text = String(value == null ? "" : value).trim();
  return text || fallback;
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 15000);
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
      signal: controller.signal,
      redirect: "manual",
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
    if (!response.ok) {
      const detail = safeText(data?.error_description || data?.error || data?.message);
      const error = new Error(`OAuth 服务请求失败（HTTP ${response.status}${detail ? "：" + detail : ""}）`);
      error.status = response.status;
      error.response = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function formBody(values) {
  return new URLSearchParams(Object.entries(values).filter(([, value]) => value != null && value !== "")).toString();
}

function publicUser(user) {
  if (!user || typeof user !== "object") return null;
  const result = {};
  for (const key of ["sub", "name", "nickname", "preferred_username", "email", "picture"]) {
    if (user[key] != null && user[key] !== "") result[key] = user[key];
  }
  return Object.keys(result).length ? result : null;
}

function displayName(user) {
  return safeText(user?.name || user?.nickname || user?.preferred_username || user?.email || user?.sub, "已登录");
}

function sessionPath() {
  return path.join(getPaths().stateDir, "oauth-session.json");
}

function readSession() {
  try {
    if (!fs.existsSync(sessionPath())) return null;
    const value = decryptConfigSecrets(JSON.parse(fs.readFileSync(sessionPath(), "utf8")));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function writeSession(session) {
  fs.mkdirSync(path.dirname(sessionPath()), { recursive: true });
  fs.writeFileSync(sessionPath(), `${JSON.stringify(encryptConfigSecrets(session), null, 2)}\n`, "utf8");
  try { fs.chmodSync(sessionPath(), 0o600); } catch { /* POSIX 权限 */ }
}

const sessionListeners = new Set();

/** 订阅令牌轮换事件（登录、刷新都会触发）：保活模块据此把新令牌回写到 provider。 */
function onSessionRotated(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function emitSessionRotated(session) {
  for (const listener of [...sessionListeners]) {
    try { listener(session); } catch { /* 单个订阅者异常不影响登录 */ }
  }
}

const loginSuccessListeners = new Set();

/** 订阅"授权成功"事件（入口模块用来把客户端窗口唤到前台）。 */
function onLoginSuccess(listener) {
  loginSuccessListeners.add(listener);
  return () => loginSuccessListeners.delete(listener);
}

function emitLoginSuccess() {
  for (const listener of [...loginSuccessListeners]) {
    try { listener(); } catch { /* 单个订阅者异常不影响登录 */ }
  }
}

/** 当前会话的令牌到期时间戳（未登录返回 0）。 */
function sessionExpiry() {
  return Number(readSession()?.expiresAt || 0);
}

function clearSession() {
  try { fs.rmSync(sessionPath(), { force: true }); } catch { /* 文件可能不存在 */ }
}

function oauthSettings() {
  const oauth = getAppConfig().oauth || {};
  return {
    issuer: trimTrailingSlash(oauth.issuer || ""),
    authorizationOrigin: trimTrailingSlash(oauth.authorizationOrigin || oauth.issuer || ""),
    clientId: safeText(oauth.clientId),
    scopes: safeText(oauth.scopes),
  };
}

function endpoints(settings) {
  return {
    authorization: joinUrl(settings.authorizationOrigin, "/oauth/authorize"),
    token: joinUrl(settings.issuer, "/oauth/token"),
    revoke: joinUrl(settings.issuer, "/oauth/revoke"),
    userinfo: joinUrl(settings.issuer, "/oauth/userinfo"),
    subscription: joinUrl(settings.issuer, "/oauth/api/v1/subscription"),
    models: joinUrl(settings.issuer, "/oauth/api/v1/models"),
  };
}

const pending = new Map();
// 最近一次浏览器授权回调的结果（供登录页区分"取消授权"与"登录成功"）。
let lastCallback = null;
let refreshPromise = null;

function cleanPending() {
  const now = Date.now();
  for (const [state, item] of pending) {
    if (now - item.createdAt > 10 * 60 * 1000) pending.delete(state);
  }
}

/** 生成授权跳转地址（PKCE），由渲染层用系统浏览器打开。 */
async function beginLogin() {
  lastCallback = null;
  cleanPending();
  const settings = oauthSettings();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const state = crypto.randomBytes(24).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pending.set(state, { verifier, createdAt: Date.now() });
  const url = new URL(endpoints(settings).authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", getAppConfig().oauth.redirectUri);
  url.searchParams.set("scope", settings.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { ok: true, authorizationUrl: url.toString() };
}

/** 浏览器回调页统一模板：品牌化卡片 + 状态图标，不展示原始错误码与内部提示。 */
function brandPage(title, message, ok) {
  const icon = ok
    ? '<svg width="40" height="40" viewBox="0 0 52 52"><circle cx="26" cy="26" r="25" fill="#20c878"/><path d="m15 27 7.5 7.5L38 20" stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="40" height="40" viewBox="0 0 52 52"><circle cx="26" cy="26" r="25" fill="#ff4d4f"/><path d="M17 17l18 18M35 17 17 35" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>';
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - ZgyClaw</title><style>
* {margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f9f9f9;font-family:"PingFang SC","Microsoft YaHei",sans-serif;color:#1f1f1f}
.card{width:400px;background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.08);padding:40px 36px 34px;text-align:center}
.logo{font-size:26px;font-weight:800;letter-spacing:-.5px;margin-bottom:24px}
.logo em{font-style:normal;color:#e8452c}
.icon{display:flex;justify-content:center;margin-bottom:16px}
h1{font-size:18px;font-weight:600;margin-bottom:10px}
p{font-size:14px;line-height:1.7;color:#6b7280}
</style></head><body><div class="card"><div class="logo">Zgy<em>Claw</em></div><div class="icon">${icon}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
}

/** 把 OAuth 错误码转成面向用户的中文说明。 */
function friendlyAuthError(code) {
  const normalized = String(code || "").toLowerCase();
  if (normalized.includes("access_denied")) return "你取消了授权，如需继续请返回小龙虾重新登录。";
  if (normalized.includes("timeout")) return "授权等待超时，请返回小龙虾重新登录。";
  return "授权未完成，请返回小龙虾客户端重新登录。";
}

/** 处理授权回调：换令牌、写会话。由 oauth-listener 收到回调后调用。 */
async function handleCallback(params = {}) {
  const error = safeText(params.error);
  const state = safeText(params.state);
  const item = pending.get(state);
  if (error) {
    if (state) pending.delete(state);
    lastCallback = { ok: false, reason: String(error || params.error_description || "auth_failed"), at: Date.now() };
    return { ok: false, html: brandPage("登录未完成", friendlyAuthError(error || params.error_description), false) };
  }
  if (!item || !safeText(params.code)) {
    lastCallback = { ok: false, reason: "invalid_callback", at: Date.now() };
    return { ok: false, html: brandPage("登录回调无效", "授权状态已过期，请返回小龙虾客户端重新登录。", false) };
  }
  pending.delete(state);
  const settings = oauthSettings();
  const token = await fetchJson(endpoints(settings).token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: formBody({
      grant_type: "authorization_code",
      client_id: settings.clientId,
      code: params.code,
      redirect_uri: getAppConfig().oauth.redirectUri,
      code_verifier: item.verifier,
    }),
  });
  if (!safeText(token.access_token)) throw new Error("OAuth 服务未返回 access_token");
  let user = null;
  try {
    user = await fetchJson(endpoints(settings).userinfo, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } });
  } catch { /* userinfo 失败不阻塞登录 */ }
  writeSession({
    accessToken: token.access_token,
    refreshToken: token.refresh_token || "",
    idToken: token.id_token || "",
    expiresAt: Date.now() + Math.max(0, Number(token.expires_in || 3600) - 30) * 1000,
    scope: token.scope || settings.scopes,
    user: publicUser(user),
    loggedInAt: new Date().toISOString(),
  });
  lastCallback = { ok: true, at: Date.now() };
  emitLoginSuccess();
  return { ok: true, html: brandPage("登录成功", `欢迎，${displayName(user)}。授权已完成，小龙虾客户端已就绪，关闭本页即可继续配置。`, true) };
}

/** 判断是否属于"授权已失效"类错误（刷新令牌吊销 / invalid_grant），需要清除本地登录态。 */
function isRevokedError(error) {
  const description = String(error?.response?.error_description || error?.message || "");
  return (
    error?.status === 400
    && (/invalid_grant/i.test(String(error?.response?.error || "")) || /吊销|已被使用|已失效|invalid_grant/i.test(description))
  );
}

/** 移除配置里由订阅同步写入的提供商（含令牌），并刷新派生凭证文件。 */
function purgeSyncedProvider() {
  try {
    const configStore = require("./config-store");
    const config = configStore.readConfig();
    const providers = config?.models?.providers || {};
    let changed = false;
    for (const providerId of Object.keys(providers)) {
      if (providers[providerId]?.keyMode === "server") {
        delete providers[providerId];
        changed = true;
        const current = String(config?.agents?.defaults?.model || "");
        if (current.startsWith(providerId + "/")) config.agents.defaults.model = "";
      }
    }
    if (changed) configStore.writeConfig(config);
  } catch { /* 清理失败不阻塞登出 */ }
}

/** 清空本地登录会话（含配置里的订阅令牌等派生凭证），回到未登录状态。 */
function dropSession() {
  clearSession();
  refreshPromise = null;
  purgeSyncedProvider();
}

/** 用户主动取消登录：放弃待处理授权并停止回调监听。 */
function cancelLogin() {
  pending.clear();
  lastCallback = null;
  return { ok: true };
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const session = readSession();
    if (!session?.refreshToken) throw new Error("登录已过期，请重新登录");
    const settings = oauthSettings();
    let token;
    try {
      token = await fetchJson(endpoints(settings).token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formBody({
          grant_type: "refresh_token",
          client_id: settings.clientId,
          refresh_token: session.refreshToken,
        }),
      });
    } catch (error) {
      // 服务端判定刷新令牌被重复使用并吊销授权：本地会话已失效，清除后要求重新登录。
      if (isRevokedError(error)) {
        dropSession();
        throw new Error("登录已失效，请重新登录");
      }
      throw error;
    }
    if (!safeText(token.access_token)) throw new Error("刷新登录凭证失败，请重新登录");
    const updated = {
      ...session,
      accessToken: token.access_token,
      refreshToken: token.refresh_token || session.refreshToken,
      idToken: token.id_token || session.idToken || "",
      expiresAt: Date.now() + Math.max(0, Number(token.expires_in || 3600) - 30) * 1000,
      scope: token.scope || session.scope || settings.scopes,
    };
    writeSession(updated);
    emitSessionRotated(updated);
    return updated;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function validSession() {
  let session = readSession();
  if (!session?.accessToken) throw new Error("请先登录平台账号");
  // 令牌剩余时间不足阈值就先换新，避免请求打到已过期令牌上（阈值与保活共用同一配置）。
  if (Number(session.expiresAt || 0) <= Date.now() + timing.oauth.tokenRefreshAheadMs) session = await refresh();
  return session;
}

async function accountRequest(kind) {
  const settings = oauthSettings();
  const url = endpoints(settings)[kind];
  if (!url) throw new Error("OAuth 接口地址未配置");
  let session = await validSession();
  const request = (accessToken) => fetchJson(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  try {
    return await request(session.accessToken);
  } catch (error) {
    // 服务端可能在本地 expiresAt 之前吊销令牌：刷新一次并重试。
    if (error?.status !== 401 || !session.refreshToken) throw error;
    session = await refresh();
    return request(session.accessToken);
  }
}

/** 套餐入口的 OpenAI 兼容模型列表：只返回该用户在套餐下真正可调用的模型，
 * 并在平台启用时额外包含虚拟模型 auto（由平台按对话自动挑选真实模型）。 */
async function planEntryModels(accessToken) {
  const settings = oauthSettings();
  const url = joinUrl(settings.issuer, "/api/token-plan/v1/models");
  const payload = await fetchJson(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const ids = list.map((item) => (typeof item === "string" ? item.trim() : String(item?.id || "").trim())).filter(Boolean);
  return { ids, hasAuto: ids.includes("auto") };
}

/** 订阅模型配置：解析 Coding Plan 订阅、套餐可调用模型与 Auto 选项。 */
async function subscriptionModelConfig(preferredModelId = "") {
  const session = await validSession();
  const settings = oauthSettings();
  const [subscription, models] = await Promise.all([
    accountRequest("subscription"),
    accountRequest("models"),
  ]);

  const subscriptionData = subscription?.data && typeof subscription.data === "object" ? subscription.data : subscription || {};
  const detail = subscriptionData.detail && typeof subscriptionData.detail === "object" ? subscriptionData.detail : {};
  if (subscriptionData.subscribed !== true && String(detail.status || "").toLowerCase() !== "active") {
    throw new Error("当前没有生效的 Coding Plan 订阅");
  }

  const modelData = models?.data && typeof models.data === "object" ? models.data : models || {};
  const list = Array.isArray(modelData.list)
    ? modelData.list
    : Array.isArray(modelData.models)
      ? modelData.models
      : Array.isArray(modelData.data) ? modelData.data : [];
  const modelId = (item) => typeof item === "string" ? item.trim() : String(item?.id || item?.model_id || item?.modelId || item?.model || "").trim();
  const enabledValues = Array.isArray(detail.enabled_models)
    ? detail.enabled_models
    : Array.isArray(modelData.enabled_models) ? modelData.enabled_models : [];
  const enabled = enabledValues.map((item) => modelId(item) || String(item || "").trim()).filter(Boolean);

  // 真正可调用的模型以套餐入口列表为准（enabled_models 为空表示不限制）；
  // /oauth/api/v1/models 只用于补充展示信息（名称 / 输入类型 / 上下文长度）。
  let planIds = [];
  let hasAuto = false;
  try {
    const planEntry = await planEntryModels(session.accessToken);
    planIds = planEntry.ids;
    hasAuto = planEntry.hasAuto;
  } catch { /* 套餐入口不可用时回落到订阅 enabled_models */ }
  const callable = (planIds.length ? planIds : enabled).filter((id) => id !== "auto");
  const usable = enabled.length ? callable.filter((id) => enabled.includes(id)) : callable;

  const catalogById = new Map(list.map((item) => [modelId(item), item].filter(Boolean)).map(([id, item]) => [id, item]));
  const toModel = (id, extra = {}) => {
    const meta = catalogById.get(id) || {};
    const input = (Array.isArray(meta.input_types) ? meta.input_types : ["文本"])
      .map((value) => {
        const normalized = String(value || "").trim().toLowerCase();
        if (["text", "文本"].includes(normalized)) return "text";
        if (["image", "图片", "图像"].includes(normalized)) return "image";
        if (["video", "视频"].includes(normalized)) return "video";
        if (["audio", "音频"].includes(normalized)) return "audio";
        return "";
      })
      .filter(Boolean);
    return {
      id,
      name: String(meta.name || meta.display_name || meta.displayName || id),
      reasoning: Array.isArray(meta.capabilities) && meta.capabilities.some((value) => /思考|reason/i.test(String(value))),
      input: input.length ? input : ["text"],
      contextWindow: Number(meta.context_window || meta.max_input_tokens || 0) || undefined,
      maxTokens: Number(meta.max_output_tokens || 0) || undefined,
      ...extra,
    };
  };

  const available = usable.map((id) => toModel(id));
  // 平台启用 Auto 时作为首选：由平台按对话内容自动挑选真实模型。
  if (hasAuto) {
    available.unshift(toModel("auto", { name: "Auto（平台自动选择）" }));
  }
  if (!available.length) throw new Error("订阅有效，但后台没有返回可用模型");

  const currentValues = [modelData.current_model, modelData.currentModel, modelData.active_model, modelData.activeModel, detail.current_model, detail.currentModel]
    .map((item) => modelId(item) || String(item || "").trim()).filter(Boolean);
  const chosen = String(preferredModelId || "").trim();
  const defaultModel =
    (chosen && available.some((item) => item.id === chosen) && chosen)
    || currentValues.find((id) => available.some((item) => item.id === id))
    || available[0].id;

  return {
    providerId: "zgy",
    providerName: String(modelData.provider_name || modelData.providerName || modelData.service_name || "中广云"),
    baseUrl: joinUrl(settings.issuer, "/api/token-plan/v1"),
    accessToken: session.accessToken,
    defaultModel,
    autoModelId: hasAuto ? "auto" : "",
    models: available,
    plan: {
      name: String(detail.plan_name || detail.plan_tier || "Coding Plan"),
      status: String(detail.status || ""),
      quotaRemaining: Number(detail.quota_remaining ?? 0),
      quotaTotal: Number(detail.quota_total ?? 0),
      startAt: String(detail.start_at || ""),
      endAt: String(detail.end_at || ""),
    },
  };
}

async function status() {
  cleanPending();
  const session = readSession();
  return {
    ok: true,
    loggedIn: Boolean(session?.accessToken),
    pending: pending.size > 0,
    user: publicUser(session?.user),
    expiresAt: session?.expiresAt || 0,
    scope: session?.scope || "",
  };
}

async function logout() {
  const session = readSession();
  pending.clear();
  lastCallback = null;
  dropSession();
  if (!session) return { ok: true };
  const settings = oauthSettings();
  try {
    for (const token of [session.refreshToken, session.accessToken]) {
      if (!token) continue;
      try {
        await fetchJson(endpoints(settings).revoke, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: formBody({ token, client_id: settings.clientId }),
        });
      } catch { /* 逐个吊销失败不阻塞登出 */ }
    }
  } catch { /* 吊销失败不阻塞登出 */ }
  return { ok: true };
}

module.exports = {
  authCallbackResult: () => lastCallback,
  ensureSession: validSession,
  onLoginSuccess,
  onSessionRotated,
  sessionExpiry,
  beginLogin,
  cancelLogin,
  brandPage,
  handleCallback,
  logout,
  refresh: async () => { await refresh(); return status(); },
  status,
  subscription: () => accountRequest("subscription"),
  subscriptionModelConfig,
};

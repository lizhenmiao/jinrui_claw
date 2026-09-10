/**
 * OAuth / OIDC 服务：Authorization Code + PKCE（S256）。
 * 登录在系统默认浏览器完成，回调落在本地临时监听器（oauth-listener.js）。
 * 会话令牌写入 U 盘数据目录并按敏感字段加密。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const { getAppConfig } = require("../app-config");
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

function clearSession() {
  try { fs.rmSync(sessionPath(), { force: true }); } catch { /* 文件可能不存在 */ }
}

function oauthSettings() {
  const oauth = getAppConfig().oauth || {};
  return {
    issuer: trimTrailingSlash(oauth.issuer || ""),
    authorizationOrigin: trimTrailingSlash(oauth.authorizationOrigin || oauth.issuer || ""),
    clientId: safeText(oauth.clientId),
    clientSecret: safeText(oauth.clientSecret),
    clientType: safeText(oauth.clientType, "confidential"),
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
    codingPlanKey: joinUrl(settings.issuer, "/api/v1/coding-plan-key"),
  };
}

const pending = new Map();
let refreshPromise = null;

function cleanPending() {
  const now = Date.now();
  for (const [state, item] of pending) {
    if (now - item.createdAt > 10 * 60 * 1000) pending.delete(state);
  }
}

/** 生成授权跳转地址（PKCE），由渲染层用系统浏览器打开。 */
async function beginLogin() {
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

/** 处理授权回调：换令牌、写会话。由 oauth-listener 收到回调后调用。 */
async function handleCallback(params = {}) {
  const error = safeText(params.error);
  const errorDescription = safeText(params.error_description || params.error);
  const state = safeText(params.state);
  const item = pending.get(state);
  if (error) {
    if (state) pending.delete(state);
    return { ok: false, html: `<html><body><h2>登录未完成</h2><p>${escapeHtml(errorDescription || "OAuth 授权被取消")}</p><p>可以关闭此页面并返回小龙虾。</p></body></html>` };
  }
  if (!item || !safeText(params.code)) {
    return { ok: false, html: "<html><body><h2>登录回调无效</h2><p>授权状态已过期，请返回小龙虾重新登录。</p></body></html>" };
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
      client_secret: settings.clientType === "confidential" ? settings.clientSecret : "",
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
  return { ok: true, html: `<html><body><h2>登录成功</h2><p>欢迎，${escapeHtml(displayName(user))}。</p><p>可以关闭此页面并返回小龙虾。</p><script>setTimeout(() => window.close(), 800)</script></body></html>` };
}

async function refresh() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const session = readSession();
    if (!session?.refreshToken) throw new Error("登录已过期，请重新登录");
    const settings = oauthSettings();
    const token = await fetchJson(endpoints(settings).token, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: formBody({
        grant_type: "refresh_token",
        client_id: settings.clientId,
        refresh_token: session.refreshToken,
        client_secret: settings.clientType === "confidential" ? settings.clientSecret : "",
      }),
    });
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
    return updated;
  })().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function validSession() {
  let session = readSession();
  if (!session?.accessToken) throw new Error("请先登录平台账号");
  if (Number(session.expiresAt || 0) <= Date.now() + 60 * 1000) session = await refresh();
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

/** 订阅模型配置：解析 Coding Plan 订阅与 Auto 生效模型。 */
async function subscriptionModelConfig() {
  const session = await validSession();
  const settings = oauthSettings();
  const [subscription, models] = await Promise.all([
    accountRequest("subscription"),
    accountRequest("models"),
  ]);
  let codingPlanKey = null;
  try {
    codingPlanKey = await accountRequest("codingPlanKey");
  } catch { /* 旧后台可能没有该端点，回落 models 响应 */ }

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
  const available = list.filter((item) => {
    const id = modelId(item);
    return id && (!enabled.length || enabled.includes(id));
  });

  const codingPlanData = codingPlanKey?.data && typeof codingPlanKey.data === "object" ? codingPlanKey.data : codingPlanKey || {};
  const effectiveModel = modelId(codingPlanData.auto_effective_model);
  // Auto 生效模型是订阅页展示与保存的唯一来源。
  const effectiveSelection = effectiveModel
    ? available.find((item) => modelId(item) === effectiveModel) || { id: effectiveModel, name: effectiveModel }
    : null;
  if (effectiveSelection && !available.some((item) => modelId(item) === effectiveModel)) {
    available.push(effectiveSelection);
  }
  if (!available.length) throw new Error("订阅有效，但后台没有返回可用模型");

  const explicitlySelected = [modelData.selected_model, modelData.selectedModel, detail.selected_model, detail.selectedModel]
    .map((item) => modelId(item) || String(item || "").trim()).filter(Boolean);
  const currentValues = [modelData.current_model, modelData.currentModel, modelData.active_model, modelData.activeModel, detail.current_model, detail.currentModel, detail.model_id, detail.modelId]
    .map((item) => modelId(item) || String(item || "").trim()).filter(Boolean);
  const fallbackValues = [modelData.default_model, modelData.defaultModel, modelData.model, modelData.default?.id, modelData.current?.id, modelData.selected?.id, detail.default_model, detail.defaultModel, detail.model]
    .map((item) => modelId(item) || String(item || "").trim()).filter(Boolean);

  const preferred = effectiveSelection
    || available.find((item) => item.selected === true || item.is_selected === true || item.active === true || item.is_active === true)
    || explicitlySelected.map((id) => available.find((item) => modelId(item) === id)).find(Boolean)
    || currentValues.map((id) => available.find((item) => modelId(item) === id)).find(Boolean)
    || fallbackValues.map((id) => available.find((item) => modelId(item) === id)).find(Boolean)
    || available.find((item) => item.default === true || item.is_default === true)
    || available[0];
  const defaultModel = modelId(preferred);

  const input = (Array.isArray(preferred.input_types) ? preferred.input_types : ["text"])
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
    providerId: "zgy",
    providerName: String(modelData.provider_name || modelData.providerName || modelData.service_name || "中广云 Auto"),
    baseUrl: joinUrl(settings.issuer, "/api/token-plan/v1"),
    accessToken: session.accessToken,
    defaultModel,
    models: [{
      id: modelId(preferred),
      name: String(preferred.name || preferred.display_name || preferred.displayName || preferred.model || preferred.id),
      reasoning: Array.isArray(preferred.capabilities) && preferred.capabilities.some((value) => /思考|reason/i.test(String(value))),
      input: input.length ? input : ["text"],
      contextWindow: Number(preferred.context_window || preferred.max_input_tokens || 0) || undefined,
      maxTokens: Number(preferred.max_output_tokens || 0) || undefined,
    }],
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
  clearSession();
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
  beginLogin,
  handleCallback,
  logout,
  refresh: async () => { await refresh(); return status(); },
  status,
  subscription: () => accountRequest("subscription"),
  subscriptionModelConfig,
};

/**
 * 定时维护任务：客户端与后台/授权平台之间的"续命"动作，统一在这里调度。
 * ① 后台心跳：定时打 /api/client/device/ping，让后台的"最近在线"保持新鲜；
 * ② 订阅令牌保活：access_token 到期前用 refresh_token 换新（refresh_token 同时轮转），换到新令牌后由轮换事件立刻回写 provider 的 apiKey，必要时重启网关读取新令牌。
 * 只有 refresh_token 也失效（invalid_grant）时才算登录失效：oauth 层已清登录态，界面下一次调用会收到"登录已失效"并回到登录页。
 */
const timing = require("../../shared/timing.json");
const oauth = require("./oauth");
const processManager = require("./process-manager");
const { readConfig, writeConfig, writeSubscriptionProvider } = require("./config-store");
const { devicePing } = require("./backend-client");
const { appendLogLine } = require("./logs");

let heartbeatTimer = null;
let tokenTimer = null;
let unsubscribeRotation = null;

/** 订阅 provider：按 keyMode 判定（不要求已经有 Key，否则丢了 Key 就永远修不回来）。 */
function subscriptionProvider(config) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return null;
  const entry = Object.entries(providers).find(([, provider]) => provider && provider.keyMode === "server");
  return entry ? entry[1] : null;
}

/** 令牌轮换后回写 provider：网关在跑就重启一次，否则它仍在用已失效的令牌。 */
async function applyRotatedToken(session) {
  try {
    const config = readConfig();
    const provider = subscriptionProvider(config);
    if (!provider || provider.apiKey === session.accessToken) return;
    provider.apiKey = session.accessToken;
    writeConfig(config);
    const gatewayRunning = await processManager.isGatewayRunning();
    if (gatewayRunning) await processManager.restartGateway("oauth-token-refresh");
    appendLogLine("oauth.log", `token rotated; provider key updated; gatewayRestarted=${gatewayRunning}`);
  } catch (error) {
    appendLogLine("oauth.log", `token rotation handling failed: ${error.message}`);
  }
}

/** 心跳一轮：失败只记日志，下个周期自然重试。 */
async function heartbeatOnce() {
  try {
    await devicePing();
  } catch { /* 心跳失败不影响任何本地功能 */ }
}

/**
 * 订阅 Key 自愈：provider 标着 server 却没有 Key（配置被写坏、换机器带了旧配置）时，用当前登录态重新同步一次，把 Key 补回去；网关在跑则重启读取新 Key。
 */
async function repairSubscriptionKey() {
  try {
    const config = readConfig();
    const provider = subscriptionProvider(config);
    if (!provider || provider.apiKey) return;
    // 保留用户之前选的模型（默认模型形如 "zgy/deepseek-v4-flash"）。
    const currentDefault = String(config?.agents?.defaults?.model || "");
    const preferred = currentDefault.includes("/") ? currentDefault.split("/").pop() : "";
    const synced = await oauth.subscriptionModelConfig(preferred);
    writeSubscriptionProvider(synced);
    appendLogLine("oauth.log", "subscription key repaired from session");
    if (await processManager.isGatewayRunning()) await processManager.restartGateway("subscription-key-repaired");
  } catch { /* 未登录或平台不可达：保持原状，下次启动再试 */ }
}

/** 令牌保活一轮：距过期还早就什么都不做；到点了主动刷新（失败保留登录态等下一轮）。 */
async function refreshTokenOnce() {
  try {
    const expiry = oauth.sessionExpiry();
    if (!expiry) return;
    if (expiry - Date.now() > timing.oauth.tokenRefreshAheadMs) return;
    await oauth.ensureSession();
  } catch { /* 授权真正失效时由业务调用回到登录页 */ }
}

/** 启动定时维护（幂等）。 */
function start() {
  if (!unsubscribeRotation) unsubscribeRotation = oauth.onSessionRotated(applyRotatedToken);
  if (!heartbeatTimer) {
    void heartbeatOnce();
    heartbeatTimer = setInterval(heartbeatOnce, timing.backend.heartbeatIntervalMs);
  }
  void repairSubscriptionKey();
  if (!tokenTimer) tokenTimer = setInterval(refreshTokenOnce, timing.oauth.tokenCheckIntervalMs);
  return true;
}

/** 停止定时维护（退出前调用）。 */
function stop() {
  clearInterval(heartbeatTimer);
  clearInterval(tokenTimer);
  heartbeatTimer = null;
  tokenTimer = null;
  if (unsubscribeRotation) unsubscribeRotation();
  unsubscribeRotation = null;
}

module.exports = { start, stop };

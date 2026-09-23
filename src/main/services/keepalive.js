/**
 * 定时维护任务：客户端与后台/授权平台之间的"续命"动作，统一在这里调度。
 * ① 后台心跳：定时打 /api/client/device/ping，让后台的"最近在线"保持新鲜；
 * ② 订阅令牌保活：access_token 到期前用 refresh_token 换新（refresh_token 同时轮转），换到新令牌后由轮换事件立刻回写 provider 的 apiKey，必要时重启网关读取新令牌。
 * 只有 refresh_token 也失效（invalid_grant）时才算登录失效：oauth 层已清登录态，界面下一次调用会收到"登录已失效"并回到登录页。
 */
const timing = require("../../shared/timing.json");
const oauth = require("./oauth");
const processManager = require("./process-manager");
const { readConfig, writeConfig } = require("./config-store");
const { devicePing } = require("./backend-client");
const { appendLogLine } = require("./logs");

let heartbeatTimer = null;
let tokenTimer = null;
let unsubscribeRotation = null;
// 一轮失败只允许一次自动恢复，并发错误共用同一任务，成功聊天后才允许下一轮。
let recoveryPromise = null;
let recoveryAttempted = false;
let preparingGateway = false;

/** 订阅 provider：按 keyMode 判定（不要求已经有 Key，否则丢了 Key 就永远修不回来）。 */
function subscriptionProvider(config) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return null;
  const entry = Object.entries(providers).find(([, provider]) => provider && provider.keyMode === "server");
  return entry ? entry[1] : null;
}

/** 同步所有订阅提供商的访问令牌，保留手动 API Key 与模型配置。 */
function syncSubscriptionToken(session) {
  const config = readConfig();
  let changed = false;
  for (const provider of Object.values(config.models?.providers || {})) {
    if (provider?.keyMode !== "server" || provider.apiKey === session.accessToken) continue;
    provider.apiKey = session.accessToken;
    changed = true;
  }
  if (changed) writeConfig(config);
  return changed;
}

/** 令牌轮换后回写 provider：网关在跑就重启一次，否则它仍在用已失效的令牌。 */
async function applyRotatedToken(session) {
  try {
    if (!syncSubscriptionToken(session)) return;
    const gatewayRunning = await processManager.isGatewayRunning();
    if (gatewayRunning && !preparingGateway && !recoveryPromise) await processManager.restartGateway("oauth-token-refresh");
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

/** 启动网关前确保所有订阅提供商使用当前有效令牌，读盘后同步以避免覆盖并发配置。 */
async function prepareGatewayAuth() {
  if (!subscriptionProvider(readConfig())) return;
  preparingGateway = true;
  try {
    const session = await oauth.ensureSession();
    syncSubscriptionToken(session);
  } finally { preparingGateway = false; }
}

/** 明确的订阅 OAuth 401 才触发恢复；不重放可能已产生副作用的聊天消息。 */
function observeGatewayLine(line) {
  if (!/\[model-fetch\] response .*status=200\b|rawError=401.*OAuth.*(?:无效|过期)/.test(line)) return;
  const providerId = line.match(/\bprovider=([^\s]+)/)?.[1];
  if (!providerId || readConfig().models?.providers?.[providerId]?.keyMode !== "server") return;
  if (/\[model-fetch\] response .*status=200\b/.test(line)) { recoveryAttempted = false; return; }
  if (!/rawError=401.*OAuth.*(?:无效|过期)/.test(line) || recoveryPromise || recoveryAttempted) return;
  if (!subscriptionProvider(readConfig())) return;
  recoveryAttempted = true;
  // 异步串行恢复；同一轮日志的重复报错不能重复消耗刷新令牌。
  recoveryPromise = Promise.resolve().then(async () => {
    await oauth.refresh();
    await prepareGatewayAuth();
    if (await processManager.isGatewayRunning()) await processManager.restartGateway("oauth-auth-recovery");
    appendLogLine("gateway.err.log", "订阅令牌已刷新，网关已重新加载，请重新发送刚才的消息。");
  }).catch((error) => {
    appendLogLine("gateway.err.log", `订阅授权自动恢复失败：${error.message}。请在客户端重新登录或检查网络。`);
  }).finally(() => { recoveryPromise = null; });
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
  void refreshTokenOnce();
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

module.exports = { start, stop, prepareGatewayAuth, observeGatewayLine };

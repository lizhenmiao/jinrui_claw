/**
 * OAuth 本地回调监听器：仅在登录流程期间监听 127.0.0.1 的回调端口，
 * 收到授权回调后转交 oauth 服务并自动关闭监听。
 * 平时不存在任何对外监听；端口冲突时给出明确错误。
 */
const http = require("http");
const { URL } = require("url");
const { getAppConfig } = require("../app-config");
const timing = require("../../shared/timing.json");
const oauth = require("./oauth");

let server = null;

function callbackPort() {
  const redirectUri = String(getAppConfig().oauth.redirectUri || "");
  try {
    return Number(new URL(redirectUri).port) || (redirectUri.startsWith("https") ? 443 : 80);
  } catch {
    return 18790;
  }
}

/** 页面模板：统一走 oauth 的品牌化卡片（登录回调场景默认失败样式）。 */
function pageHtml(title, message) {
  return oauth.brandPage(title, message, false);
}

function start() {
  // 已在监听时直接复用，避免重复 listen 造成端口占用错误。
  if (server) return Promise.resolve(callbackPort());
  return new Promise((resolve, reject) => {
    const port = callbackPort();
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== "/api/auth/callback") {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageHtml("页面不存在", "该地址仅用于登录回调。"));
        return;
      }
      let result;
      try {
        result = await oauth.handleCallback(Object.fromEntries(url.searchParams.entries()));
      } catch (error) {
        result = { ok: false, html: pageHtml("登录失败", String(error.message || "OAuth 服务请求失败")) };
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(result.html);
      // 回调只消费一次，处理完成即关闭监听。
      setTimeout(stop, timing.oauth.callbackStopDelayMs);
    });
    server.once("error", (error) => {
      server = null;
      reject(new Error(`登录回调端口 ${port} 监听失败：${error.message}。若端口被占用请关闭占用程序后重试。`));
    });
    server.listen(port, "127.0.0.1", () => resolve(port));
  });
}

function stop() {
  if (!server) return;
  const current = server;
  server = null;
  try { current.close(() => current.closeAllConnections?.()); } catch { /* 监听器可能已关闭 */ }
}

function isRunning() {
  return Boolean(server);
}

module.exports = { isRunning, start, stop };

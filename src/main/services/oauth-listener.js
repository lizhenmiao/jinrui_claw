/**
 * OAuth 本地回调监听器：仅在登录流程期间监听 127.0.0.1 的回调端口，
 * 收到授权回调后转交 oauth 服务并自动关闭监听。
 * 平时不存在任何对外监听；端口冲突时给出明确错误。
 */
const http = require("http");
const { URL } = require("url");
const { getAppConfig } = require("../app-config");
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

/** 页面 HTML 模板：提示用户返回客户端。 */
function pageHtml(title, message) {
  return `<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2>${title}</h2><p>${message}</p><p>可以关闭此页面并返回小龙虾。</p></body></html>`;
}

function start() {
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
        result = { ok: false, html: pageHtml("登录失败", String(error.message || "OAuth 服务请求失败").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])) };
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(result.html);
      // 回调只消费一次，处理完成即关闭监听。
      setTimeout(stop, 500);
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

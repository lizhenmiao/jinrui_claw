/**
 * QQ 机器人扫码绑定：二维码与回调由官方连接器（@tencent-connect/qqbot-connector）提供，状态推进、过期自动重建、等待与通知交给通用扫码会话（qr-session），绑定成功后把凭据写进通道配置。
 */
const path = require("path");
const { pathToFileURL } = require("url");
const timing = require("../../shared/timing.json");
const { getPaths } = require("../paths");
const { findQQBotConnectorEntry } = require("./modules");
const { applyQQBotCredentials, readQQBotBinding } = require("./channels");
const { createQrSession } = require("./qr-session");
const gateway = require("./process-manager");

/**
 * 加载 ESM 形态的官方连接器。
 * 不能在这里直接写 import()：安装包内主进程是 V8 字节码，bytenode 用 vm.Script 加载、没有 dynamic import 回调，直接 import() 会抛 "A dynamic import callback was not specified."，表现是面板一直"生成中..."。改由随 resources 明文分发、不参与字节码编译的助手代为 import。
 */
function importConnector(entry) {
  const importEsm = require(path.join(getPaths().bridgeDir, "esm-import.cjs"));
  return importEsm(pathToFileURL(entry).href);
}

/** 当前连接器的清理函数；重新发起或绑定成功时清掉，避免上一个会话继续回调。 */
let cleanupCurrent = null;

const session = createQrSession({
  messages: { waiting: "请用手机 QQ 扫码绑定" },
  start: () => startConnector(),
  stop: () => cleanupConnector(),
});

function cleanupConnector() {
  if (!cleanupCurrent) return;
  try { cleanupCurrent(); } catch { /* 旧连接可能已断开 */ }
  cleanupCurrent = null;
}

/** 调一次官方连接器生成二维码；回调把结果报给会话。 */
function startConnector() {
  const entry = findQQBotConnectorEntry();
  if (!entry) throw new Error("QQBot 插件未安装，请先安装官方 @openclaw/qqbot 插件。");
  importConnector(entry)
    .then(({ startQrConnect }) => {
      cleanupCurrent = startQrConnect({
        onQrDisplayed: (qrUrl) => session.reportQr(qrUrl),
        onSuccess: (accounts) => {
          try {
            const saved = applyQQBotCredentials(accounts);
            session.reportStatus("success", saved ? `QQBot 已绑定，AppID: ${saved.appId}` : "QQBot 已绑定");
            // 只标记待重启：由界面的"重启生效"按钮统一加载（网关没跑则等下次启动自然加载）。
            if (saved) gateway.markConfigPendingRestart("qqbot-bound");
          } catch (error) {
            session.reportStatus("failed", `QQBot 已扫码，但保存配置失败: ${error.message}`);
          } finally {
            cleanupCurrent = null;
          }
        },
        onFailure: (error) => {
          cleanupConnector();
          session.reportStatus("failed", `QQBot 绑定失败: ${error?.message || String(error)}`);
        },
        onQrExpired: () => session.reportStatus("expired", "二维码已过期"),
      }, { displayQrCodeToConsole: false, source: "openclaw" });
    })
    .catch((error) => session.reportStatus("failed", `QQBot 连接器加载失败：${error.message}`));
}

/** 发起一次扫码（用户点"生成绑定二维码/重新绑定"，会重置自动重建额度）。 */
function begin() {
  cleanupConnector();
  return session.begin({});
}

/** 完全停掉扫码会话（出厂重置用）：断开连接器并复位，之后不会再自动重建。 */
function stop() {
  session.reset();
}

/** 状态快照：附上落盘的绑定信息，面板切页、重启后仍能显示已绑定。 */
function snapshot() {
  return { ...session.snapshot(), ...readQQBotBinding() };
}

/** 等二维码可用（已经拿到码时立即返回）。 */
function waitForQr() {
  return session.waitForQr(timing.qqBind.qrWaitTimeoutMs);
}

module.exports = { begin, stop, snapshot, waitForQr };

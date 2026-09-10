#!/usr/bin/env node
/**
 * 钉钉 Stream 桥接进程：
 * - 在网关进程之外维持钉钉 Stream 长连接（比网关内循环更稳定）
 * - 收到机器人消息后调用本地 OpenClaw /v1/chat/completions 获取回复
 * - 通过 sessionWebhook 回帖，并立即 ACK 防止钉钉约 60 秒后重投
 * 由主进程（process-manager）启动；凭证与网关令牌经环境变量注入，
 * 日志写到数据目录 logs/dingtalk-stream-bridge.log。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const stateDir = process.env.OPENCLAW_STATE_DIR || "";
const logPath = path.join(stateDir, "logs", "dingtalk-stream-bridge.log");
const GATEWAY_CHAT_COMPLETIONS_URL = "http://127.0.0.1:18789/v1/chat/completions";

// 钉钉会对同一条 CALLBACK 重投，按 msgId 去重防止重复回复。
const recentMsgIds = new Map();
const MSG_DEDUP_TTL_MS = 10 * 60 * 1000;

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(String).join(" ")}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + "\n", "utf8");
  } catch { /* 日志失败不阻塞桥接 */ }
}

function pruneRecentMsgIds(now = Date.now()) {
  for (const [id, ts] of recentMsgIds) {
    if (now - ts > MSG_DEDUP_TTL_MS) recentMsgIds.delete(id);
  }
}

function seenOrMarkMsgId(msgId) {
  if (!msgId) return false;
  pruneRecentMsgIds();
  if (recentMsgIds.has(msgId)) return true;
  recentMsgIds.set(msgId, Date.now());
  return false;
}

async function askOpenClaw(text, sessionKey) {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
  if (!token) throw new Error("gateway token missing");
  const res = await fetch(GATEWAY_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "x-openclaw-session-key": sessionKey,
      "x-openclaw-message-channel": "openclaw-dingtalk-channel",
    },
    body: JSON.stringify({
      model: "openclaw",
      messages: [{ role: "user", content: text }],
      stream: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`OpenClaw HTTP ${res.status}: ${body.slice(0, 300)}`);
  const json = JSON.parse(body);
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenClaw empty reply: ${body.slice(0, 300)}`);
  return String(content);
}

async function replyDingTalk(sessionWebhook, text) {
  const chunks = [];
  const source = String(text || " ");
  for (let index = 0; index < source.length; index += 1800) chunks.push(source.slice(index, index + 1800));
  for (const chunk of chunks) {
    const res = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content: chunk || " " } }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.text();
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { /* 非 JSON 响应按 HTTP 状态判断 */ }
    if (!res.ok) throw new Error(`DingTalk reply HTTP ${res.status}: ${body.slice(0, 200)}`);
    if (json && json.errcode !== 0) {
      throw new Error(`DingTalk reply error ${json.errcode}: ${json.errmsg || body}`);
    }
  }
}

async function handleRobotPayload(robotMsg) {
  const text = String(robotMsg?.text?.content || "").trim();
  const sessionWebhook = String(robotMsg?.sessionWebhook || "").trim();
  const sender = robotMsg?.senderNick || robotMsg?.senderStaffId || "user";
  const conversationId = String(robotMsg?.conversationId || "unknown");
  const msgId = String(robotMsg?.msgId || robotMsg?.msgids || "").trim();
  if (!text || !sessionWebhook) {
    log("skip message missing text/sessionWebhook");
    return;
  }
  if (msgId && seenOrMarkMsgId(msgId)) {
    log(`skip duplicate msgId=${msgId} from=${sender}`);
    return;
  }
  log(`inbound from=${sender} body=${text.slice(0, 80)}${msgId ? ` msgId=${msgId}` : ""}`);
  const sessionKey = `agent:main:openclaw-dingtalk-channel:direct:${conversationId}`;
  try {
    const answer = await askOpenClaw(text, sessionKey);
    await replyDingTalk(sessionWebhook, answer);
    log(`replied to ${sender}, chars=${answer.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`handle failed: ${message}`);
    try {
      await replyDingTalk(sessionWebhook, `消息处理失败：${message}`);
    } catch { /* 回帖失败仅记录 */ }
  }
}

async function main() {
  const clientId = process.env.DINGTALK_BRIDGE_CLIENT_ID || "";
  const clientSecret = process.env.DINGTALK_BRIDGE_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    log("dingtalk-channel credentials missing; bridge idle exit");
    process.exit(0);
  }
  log(`starting bridge clientId=${clientId}`);

  // dingtalk-stream SDK 随 openclaw 模块缓存分发，从模块目录解析。
  const streamEntry = path.join(process.env.OPENCLAW_MODULES_DIR || "", "dingtalk-stream", "dist", "index.mjs");
  if (!fs.existsSync(streamEntry)) {
    throw new Error(`dingtalk-stream SDK not found: ${streamEntry}`);
  }
  const { DWClient, TOPIC_ROBOT } = await import(pathToFileURL(streamEntry).href);

  const client = new DWClient({
    clientId,
    clientSecret,
    keepAlive: true,
    debug: process.env.DINGTALK_BRIDGE_DEBUG === "1",
    ua: "zgyclaw-dingtalk-bridge/1.0.0",
  });
  // 仅订阅机器人 CALLBACK 消息，EVENT 通道会产生无关噪音。
  client.config.subscriptions = [{ type: "CALLBACK", topic: TOPIC_ROBOT }];
  client.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
    try {
      const messageId = downstream?.headers?.messageId;
      if (messageId) client.socketCallBackResponse(messageId, { status: "SUCCESS" });
    } catch (error) {
      log(`ack failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    void (async () => {
      try {
        let data = downstream?.data;
        if (typeof data === "string") data = JSON.parse(data);
        if (!data || typeof data !== "object") return;
        await handleRobotPayload(data);
      } catch (error) {
        log(`callback error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  await client.connect();
  log(`stream connected=${client.connected}`);

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try { client.disconnect(); } catch { /* 连接可能已断开 */ }
      process.exit(0);
    });
  }
}

main().catch((error) => {
  log(`fatal: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});

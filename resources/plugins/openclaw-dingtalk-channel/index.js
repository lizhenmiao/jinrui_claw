import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// This plugin lives outside the openclaw package. Resolve its SDK from the
// portable module cache explicitly; a bare ESM import cannot see the sibling
// node_modules directory.
const moduleRoot = process.env.OPENCLAW_MODULES_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../app/node_modules");
const require = createRequire(import.meta.url);
const dingtalkStreamPath = require.resolve("dingtalk-stream", { paths: [moduleRoot] });
const { DWClient, EventAck, TOPIC_ROBOT } = require(dingtalkStreamPath);
// openclaw 未导出 plugin-sdk 子路径，按包根定位文件；延迟到首次使用时加载，
// 避免与网关自身的动态 import 并发触发 ERR_REQUIRE_ESM_RACE_CONDITION。
let sdkCache = null;
function loadSdk() {
  if (sdkCache) return sdkCache;
  const openclawDist = path.dirname(require.resolve("openclaw", { paths: [moduleRoot] }));
  sdkCache = {
    buildChannelConfigSchema: require(path.join(openclawDist, "plugin-sdk", "channel-config-schema.js")).buildChannelConfigSchema,
    createTypingCallbacks: require(path.join(openclawDist, "plugin-sdk", "channel-runtime.js")).createTypingCallbacks,
  };
  return sdkCache;
}

const CHANNEL_ID = "openclaw-dingtalk-channel";
const DEFAULT_ACCOUNT_ID = "default";
const MAX_TEXT_CHARS = 1800;

const dingtalkChannelAccountSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    enabled: { type: "boolean", default: false },
    accountId: { type: "string", default: DEFAULT_ACCOUNT_ID },
    clientId: { type: "string" },
    clientSecret: { type: "string" },
    robotCode: { type: "string" },
    debug: { type: "boolean", default: false },
    allowConversationIds: { type: "array", items: { type: "string" } },
    allowSenderStaffIds: { type: "array", items: { type: "string" } },
    replyPrefix: { type: "string" },
  },
};

function pluginRootDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function stateDir() {
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  if (process.env.OPENCLAW_HOME) return path.join(process.env.OPENCLAW_HOME, ".openclaw");
  return path.resolve(pluginRootDir(), "..", "..", "data", ".openclaw");
}

function channelConfigFile() {
  return path.join(stateDir(), "dingtalk-channel.json");
}

function sessionsFile() {
  return path.join(stateDir(), "dingtalk-channel.sessions.json");
}

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonFile(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(stripBom(fs.readFileSync(filePath, "utf8")));
  } catch {
    return fallback;
  }
}

function readExternalConfig() {
  const cfg = readJsonFile(channelConfigFile(), {});
  if (!cfg || typeof cfg !== "object") return {};
  return cfg;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : [];
}

function resolveAccount(_cfg, requestedAccountId) {
  const fileCfg = readExternalConfig();
  const accountId = String(fileCfg.accountId || requestedAccountId || DEFAULT_ACCOUNT_ID).trim() || DEFAULT_ACCOUNT_ID;
  const enabled = fileCfg.enabled === true;
  const clientId = String(fileCfg.clientId || "").trim();
  const clientSecret = String(fileCfg.clientSecret || "").trim();
  const robotCode = String(fileCfg.robotCode || "").trim();
  return {
    accountId,
    name: fileCfg.name || "DingTalk",
    enabled,
    configured: enabled && Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    robotCode,
    debug: fileCfg.debug === true,
    allowConversationIds: normalizeArray(fileCfg.allowConversationIds),
    allowSenderStaffIds: normalizeArray(fileCfg.allowSenderStaffIds),
    replyPrefix: typeof fileCfg.replyPrefix === "string" ? fileCfg.replyPrefix : "",
  };
}

function listAccountIds(cfg) {
  const account = resolveAccount(cfg);
  return account.enabled ? [account.accountId] : [];
}

function saveSessionWebhook(conversationId, sessionWebhook, meta = {}) {
  if (!conversationId || !sessionWebhook) return;
  const filePath = sessionsFile();
  const current = readJsonFile(filePath, {});
  current[conversationId] = {
    sessionWebhook,
    updatedAt: Date.now(),
    ...meta,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2) + "\n", "utf8");
}

function loadSessionWebhook(to) {
  const raw = String(to || "").trim();
  if (!raw) return "";
  if (raw.startsWith("https://")) return raw;
  const conversationId = raw.startsWith("conversation:") ? raw.slice("conversation:".length) : raw;
  const sessions = readJsonFile(sessionsFile(), {});
  return sessions?.[conversationId]?.sessionWebhook || "";
}

function splitText(text, limit = MAX_TEXT_CHARS) {
  const source = String(text || "");
  if (source.length <= limit) return [source];
  const chunks = [];
  for (let i = 0; i < source.length; i += limit) chunks.push(source.slice(i, i + limit));
  return chunks;
}

async function postDingTalkText(sessionWebhook, text) {
  if (!sessionWebhook) throw new Error("DingTalk sessionWebhook is missing.");
  const chunks = splitText(text);
  let lastResult = null;
  for (const chunk of chunks) {
    const response = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msgtype: "text",
        text: { content: chunk || " " },
      }),
    });
    const body = await response.text();
    let json = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new Error(`DingTalk reply HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    if (json && json.errcode !== 0) {
      throw new Error(`DingTalk reply error ${json.errcode}: ${json.errmsg || body}`);
    }
    lastResult = json || body;
  }
  return lastResult;
}

function parseRobotMessage(downstream) {
  if (!downstream || downstream.headers?.topic !== TOPIC_ROBOT) return null;
  if (!downstream.data) return null;
  const parsed = typeof downstream.data === "string" ? JSON.parse(downstream.data) : downstream.data;
  return parsed && typeof parsed === "object" ? parsed : null;
}

function cleanText(text, account) {
  let value = String(text || "").trim();
  if (account.name) {
    value = value.replace(new RegExp(`^@${escapeRegExp(account.name)}\\s*`), "").trim();
  }
  return value;
}

function escapeRegExp(value) {
  return String(value)
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/[{}]/g, "\\$&");
}

function buildInboundContext(robotMsg, account) {
  const isDirect = String(robotMsg.conversationType || "") === "1";
  const chatType = isDirect ? "direct" : "group";
  const conversationId = String(robotMsg.conversationId || "").trim();
  const senderId = String(robotMsg.senderId || robotMsg.senderStaffId || robotMsg.senderNick || "unknown").trim();
  const peerId = isDirect ? `user:${senderId}` : `conversation:${conversationId || senderId}`;
  const body = cleanText(robotMsg.text?.content || "", account);
  return {
    Body: body,
    From: senderId,
    To: peerId,
    AccountId: account.accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: peerId,
    MessageSid: String(robotMsg.msgId || `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    Timestamp: Number(robotMsg.createAt) || Date.now(),
    Provider: CHANNEL_ID,
    ChatType: chatType,
    SenderName: robotMsg.senderNick,
    ConversationId: conversationId,
    CommandBody: body,
    CommandAuthorized: true,
  };
}

function isAllowed(robotMsg, account) {
  if (account.robotCode && robotMsg.robotCode && account.robotCode !== robotMsg.robotCode) return false;
  if (account.allowConversationIds.length > 0 && !account.allowConversationIds.includes(String(robotMsg.conversationId || ""))) return false;
  if (account.allowSenderStaffIds.length > 0 && !account.allowSenderStaffIds.includes(String(robotMsg.senderStaffId || ""))) return false;
  return true;
}

async function dispatchRobotMessage(robotMsg, gatewayCtx, account) {
  const channelRuntime = gatewayCtx.channelRuntime;
  if (!channelRuntime) throw new Error("OpenClaw channelRuntime is missing.");
  if (!robotMsg || robotMsg.msgtype !== "text") return;
  if (!isAllowed(robotMsg, account)) return;

  const body = String(robotMsg.text?.content || "").trim();
  if (!body) return;

  saveSessionWebhook(robotMsg.conversationId, robotMsg.sessionWebhook, {
    conversationType: robotMsg.conversationType,
    senderStaffId: robotMsg.senderStaffId,
    senderNick: robotMsg.senderNick,
    expiresAt: robotMsg.sessionWebhookExpiredTime,
  });

  const inbound = buildInboundContext(robotMsg, account);
  const route = channelRuntime.routing.resolveAgentRoute({
    cfg: gatewayCtx.cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: inbound.ChatType, id: inbound.To },
  });
  inbound.SessionKey = route.sessionKey;

  const storePath = channelRuntime.session.resolveStorePath(gatewayCtx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const finalized = channelRuntime.reply.finalizeInboundContext(inbound);

  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized,
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: CHANNEL_ID,
      to: inbound.To,
      accountId: account.accountId,
    },
    onRecordError: (err) => gatewayCtx.log?.error?.(`[dingtalk] recordInboundSession: ${String(err)}`),
  });

  const humanDelay = channelRuntime.reply.resolveHumanDelayConfig(gatewayCtx.cfg, route.agentId);
  const typingCallbacks = createTypingCallbacks({
    start: async () => {},
    stop: async () => {},
    keepaliveIntervalMs: 5000,
  });

  const { dispatcher, replyOptions, markDispatchIdle } =
    channelRuntime.reply.createReplyDispatcherWithTyping({
      humanDelay,
      typingCallbacks,
      deliver: async (payload) => {
        const text = [account.replyPrefix, payload.text || ""].filter(Boolean).join("");
        await postDingTalkText(robotMsg.sessionWebhook, text);
      },
      onError: (err, info) => {
        gatewayCtx.log?.error?.(`[dingtalk] reply ${info.kind}: ${String(err)}`);
        void postDingTalkText(robotMsg.sessionWebhook, `消息处理失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {});
      },
    });

  try {
    await channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg: gatewayCtx.cfg,
          dispatcher,
          replyOptions: { ...replyOptions, disableBlockStreaming: true },
        }),
    });
  } finally {
    markDispatchIdle();
  }
}

async function startDingTalkAccount(ctx) {
  // Portable mode: Stream connection is owned by launcher/dingtalk-stream-bridge.mjs
  // because in-gateway DWClient reconnects unstably on this host.
  // Keep channel registered for metadata, but do not open a competing Stream socket.
  const account = ctx.account;
  ctx.log?.info?.(
    `[dingtalk] channel start delegated to portable stream bridge account=${account.accountId} configured=${account.configured}`,
  );
  ctx.setStatus?.({
    accountId: account.accountId,
    running: account.configured === true,
    lastStartAt: Date.now(),
    lastError: account.configured
      ? "managed-by-portable-bridge"
      : "not-configured",
  });
  return new Promise((resolve) => {
    const stop = () => {
      ctx.setStatus?.({ accountId: account.accountId, running: false });
      resolve();
    };
    if (ctx.abortSignal?.aborted) return stop();
    ctx.abortSignal?.addEventListener("abort", stop, { once: true });
  });
}

const dingtalkChannelPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "DingTalk Channel",
    selectionLabel: "DingTalk Stream",
    docsLabel: "DingTalk Stream",
    blurb: "DingTalk robot messages via Stream mode.",
    order: 76,
  },
  configSchema: {
    schema: dingtalkChannelAccountSchema,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 200,
      idleMs: 2500,
    },
  },
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => String(raw || "").startsWith("conversation:") || String(raw || "").startsWith("user:"),
    },
  },
  agentPrompt: {
    messageToolHints: () => [
      "You are replying inside DingTalk. Keep answers concise unless the user asks for details.",
      "DingTalk replies are text-only in this channel. Do not promise to send local files through this channel.",
    ],
  },
  reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
  config: {
    listAccountIds,
    resolveAccount,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: MAX_TEXT_CHARS,
    sendText: async (ctx) => {
      const sessionWebhook = loadSessionWebhook(ctx.to);
      await postDingTalkText(sessionWebhook, ctx.text);
      return { channel: CHANNEL_ID, messageId: `dingtalk-${Date.now()}` };
    },
  },
  status: {
    defaultRuntime: {
      accountId: "",
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    },
    collectStatusIssues: () => [],
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      lastError: snapshot.lastError ?? null,
      lastInboundAt: snapshot.lastInboundAt ?? null,
      lastOutboundAt: snapshot.lastOutboundAt ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...runtime,
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
  },
  gateway: {
    startAccount: startDingTalkAccount,
    stopAccount: async () => {},
  },
};

export default {
  id: CHANNEL_ID,
  name: "DingTalk Channel",
  description: "Receive DingTalk robot messages via Stream mode and reply through OpenClaw.",
  // 惰性求值：加载期 SDK 可能尚未就绪，此时退回宽松 schema，不阻塞插件加载。
  get configSchema() {
    try {
      return loadSdk().buildChannelConfigSchema(dingtalkChannelAccountSchema);
    } catch {
      return dingtalkChannelAccountSchema;
    }
  },
  register(api) {
    api.registerChannel({ plugin: dingtalkChannelPlugin });
  },
};

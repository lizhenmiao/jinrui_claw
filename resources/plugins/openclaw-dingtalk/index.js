import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { defineToolPlugin } from "../../app/node_modules/openclaw/dist/plugin-sdk/tool-plugin.js";

const require = createRequire(import.meta.url);

const configSchema = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

const sendParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: {
      type: "string",
      description: "Message body to send to DingTalk.",
    },
    title: {
      type: "string",
      description: "Markdown title. Used only when format is markdown.",
    },
    format: {
      type: "string",
      enum: ["text", "markdown"],
      default: "text",
      description: "DingTalk message format.",
    },
    webhook: {
      type: "string",
      description: "Optional temporary webhook override. Omit for normal use; the plugin reads data/.openclaw/dingtalk.json automatically.",
    },
    secret: {
      type: "string",
      description: "Optional temporary signing secret override. Omit for normal use; the plugin reads data/.openclaw/dingtalk.json automatically.",
    },
    atMobiles: {
      type: "array",
      items: { type: "string" },
      description: "Optional phone numbers to mention.",
    },
    isAtAll: {
      type: "boolean",
      default: false,
      description: "Mention everyone in the DingTalk group.",
    },
  },
  required: ["text"],
};

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function candidateConfigFiles() {
  const files = [];
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const homeDir = process.env.OPENCLAW_HOME;
  if (stateDir) files.push(path.join(stateDir, "dingtalk.json"));
  if (homeDir) files.push(path.join(homeDir, ".openclaw", "dingtalk.json"));
  const pluginDir = path.dirname(fileURLToPath(import.meta.url));
  files.push(path.resolve(pluginDir, "..", "..", "data", ".openclaw", "dingtalk.json"));
  return [...new Set(files)];
}

function decryptStoredConfig(config) {
  try {
    const pluginDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(pluginDir, "..", "..");
    const { decryptConfigSecrets } = require("../../launcher/xlx-secret-crypto.cjs");
    return decryptConfigSecrets(config, rootDir);
  } catch {
    return config;
  }
}

function fileConfig() {
  for (const file of candidateConfigFiles()) {
    const cfg = readJsonFile(file);
    if (cfg && typeof cfg === "object") return decryptStoredConfig(cfg);
  }
  return {};
}

function readConfigValue(config, key) {
  config = decryptStoredConfig(config || {});
  const direct = config?.[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = config?.config?.[key];
  if (typeof nested === "string" && nested.trim()) return nested.trim();
  const fromFile = fileConfig()?.[key];
  if (typeof fromFile === "string" && fromFile.trim()) return fromFile.trim();
  const envKey = key === "webhook" ? "DINGTALK_WEBHOOK" : "DINGTALK_SECRET";
  const fromEnv = process.env[envKey];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  return "";
}

function buildWebhookUrl(webhook, secret) {
  if (!secret) return webhook;
  const timestamp = Date.now();
  const stringToSign = `${timestamp}\n${secret}`;
  const sign = crypto
    .createHmac("sha256", secret)
    .update(stringToSign)
    .digest("base64");
  const url = new URL(webhook);
  url.searchParams.set("timestamp", String(timestamp));
  url.searchParams.set("sign", sign);
  return url.toString();
}

function buildPayload(params) {
  const at = {
    atMobiles: Array.isArray(params.atMobiles) ? params.atMobiles : [],
    isAtAll: params.isAtAll === true,
  };
  if (params.format === "markdown") {
    return {
      msgtype: "markdown",
      markdown: {
        title: params.title || "OpenClaw",
        text: params.text,
      },
      at,
    };
  }
  return {
    msgtype: "text",
    text: { content: params.text },
    at,
  };
}

async function sendDingTalk(params, config, context) {
  const webhook = params.webhook || readConfigValue(config, "webhook");
  const secret = params.secret || readConfigValue(config, "secret");
  if (!webhook) {
    throw new Error(
      "DingTalk webhook is missing. Set data/.openclaw/dingtalk.json or pass webhook.",
    );
  }

  const url = buildWebhookUrl(webhook, secret);
  const payload = buildPayload(params);
  context.onUpdate?.({
    status: "running",
    message: `Sending DingTalk ${payload.msgtype} message...`,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: context.signal,
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = null;
  }

  if (!response.ok) {
    throw new Error(`DingTalk HTTP ${response.status}: ${responseText.slice(0, 500)}`);
  }
  if (responseJson && responseJson.errcode !== 0) {
    throw new Error(
      `DingTalk API error ${responseJson.errcode}: ${responseJson.errmsg || responseText}`,
    );
  }

  return {
    ok: true,
    format: payload.msgtype,
    dingtalk: responseJson || responseText,
  };
}

export default defineToolPlugin({
  id: "openclaw-dingtalk",
  name: "DingTalk",
  description: "Send text or markdown messages to DingTalk group robot webhooks.",
  activation: { onStartup: true },
  configSchema,
  tools: (tool) => [
    tool({
      name: "dingtalk_send",
      label: "DingTalk Send",
      description: "Send a text or markdown message to the configured DingTalk group robot. The default webhook/secret are read from data/.openclaw/dingtalk.json; do not pass secrets unless using a temporary override.",
      parameters: sendParamsSchema,
      execute: sendDingTalk,
    }),
  ],
});


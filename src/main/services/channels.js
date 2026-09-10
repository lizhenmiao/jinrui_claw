/**
 * 聊天通道配置服务：企业微信、飞书、钉钉对话、微信、QQ 通道的
 * 凭证读写、插件路径登记、通道激活与飞书配对审批。
 * 凭证字段落盘前统一加密。
 */
const fs = require("fs");
const path = require("path");
const { getPaths } = require("../paths");
const { readConfig, writeConfig, ensurePluginLoadPath } = require("./config-store");
const { readJsonFile } = require("./config-utils");
const { decryptConfigSecrets, encryptConfigSecrets, writeJsonAtomic } = require("./secret-crypto");
const { bundledPluginPath, findQQBotPluginPaths, ensureQQBotDependencyPayload } = require("./modules");

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

function dingtalkChannelFile() {
  return path.join(getPaths().dataDir, "dingtalk-channel.json");
}

function stripChannelKeys(channel) {
  // 通道 schema 拒绝仅产品 UI 使用的展示字段。
  const { name, channelConfigUpdatedAt, ...safe } = channel || {};
  return safe;
}

// ---- 企业微信（长连接） ----

function readWecomConfig() {
  const config = readConfig();
  const channel = config.channels && typeof config.channels.wecom === "object" ? config.channels.wecom : {};
  const pluginPath = path.join(getPaths().modulesCacheDir, "@wecom", "wecom-openclaw-plugin");
  const botId = typeof channel.botId === "string" ? channel.botId : "";
  const secret = typeof channel.secret === "string" ? channel.secret : "";
  return {
    enabled: channel.enabled === true,
    connectionMode: channel.connectionMode || "websocket",
    name: channel.name || "企业微信",
    botId,
    secret,
    configured: Boolean(botId && secret),
    pluginInstalled: fileExists(pluginPath),
    pluginPath,
  };
}

function writeWecomConfig(input) {
  const pluginPath = path.join(getPaths().modulesCacheDir, "@wecom", "wecom-openclaw-plugin");
  const botId = typeof input.botId === "string" ? input.botId.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "企业微信";
  const enabled = typeof input.enabled === "boolean" ? input.enabled : Boolean(botId && secret);
  if (enabled && (!botId || !secret)) throw new Error("启用企业微信需要同时填写 Bot ID 和 Secret");

  const config = readConfig();
  ensurePluginLoadPath(config, path.join(getPaths().modulesCacheDir, "@wecom", "wecom-openclaw-plugin"));
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries["wecom-openclaw-plugin"] = { enabled: true };
  config.channels = config.channels || {};
  config.channels.wecom = {
    ...stripChannelKeys(config.channels.wecom),
    enabled,
    connectionMode: "websocket",
    name,
    botId,
    secret,
    dmPolicy: config.channels.wecom?.dmPolicy || "open",
    groupPolicy: config.channels.wecom?.groupPolicy || "open",
    channelConfigUpdatedAt: new Date().toISOString(),
  };
  writeConfig(config);
  return readWecomConfig();
}

// ---- 飞书 / Lark（长连接 + 配对审批） ----

function readFeishuConfig() {
  const config = readConfig();
  const channel = config.channels && typeof config.channels.feishu === "object" ? config.channels.feishu : {};
  const pluginPath = path.join(getPaths().modulesCacheDir, "@openclaw", "feishu");
  const appId = typeof channel.appId === "string" ? channel.appId : "";
  const appSecret = typeof channel.appSecret === "string" ? channel.appSecret : "";
  return {
    enabled: channel.enabled === true,
    connectionMode: channel.connectionMode || "websocket",
    domain: channel.domain || "feishu",
    name: "飞书",
    appId,
    appSecret,
    dmPolicy: channel.dmPolicy || "pairing",
    groupPolicy: channel.groupPolicy || "allowlist",
    requireMention: typeof channel.requireMention === "boolean" ? channel.requireMention : true,
    configured: Boolean(appId && appSecret),
    pluginInstalled: fileExists(pluginPath),
    pluginPath,
  };
}

function writeFeishuConfig(input) {
  const pluginPath = path.join(getPaths().modulesCacheDir, "@openclaw", "feishu");
  const appId = typeof input.appId === "string" ? input.appId.trim() : "";
  const appSecret = typeof input.appSecret === "string" ? input.appSecret.trim() : "";
  const domain = typeof input.domain === "string" && input.domain.trim() ? input.domain.trim() : "feishu";
  const enabled = typeof input.enabled === "boolean" ? input.enabled : Boolean(appId && appSecret);
  if (enabled && (!appId || !appSecret)) throw new Error("启用飞书需要同时填写 App ID 和 App Secret");

  const config = readConfig();
  ensurePluginLoadPath(config, pluginPath);
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries.feishu = { enabled: true };
  config.channels = config.channels || {};
  config.channels.feishu = {
    ...stripChannelKeys(config.channels.feishu),
    enabled,
    connectionMode: "websocket",
    domain: domain === "lark" ? "lark" : "feishu",
    appId,
    appSecret,
    dmPolicy: config.channels.feishu?.dmPolicy || "pairing",
    groupPolicy: config.channels.feishu?.groupPolicy || "allowlist",
    requireMention: typeof config.channels.feishu?.requireMention === "boolean" ? config.channels.feishu.requireMention : true,
    streaming: typeof config.channels.feishu?.streaming === "boolean" ? config.channels.feishu.streaming : false,
    blockStreaming: typeof config.channels.feishu?.blockStreaming === "boolean" ? config.channels.feishu.blockStreaming : false,
    renderMode: config.channels.feishu?.renderMode || "raw",
  };
  writeConfig(config);
  return readFeishuConfig();
}

function feishuPairingPath() {
  return path.join(getPaths().dataDir, "credentials", "feishu-pairing.json");
}

function feishuAllowFromPath() {
  return path.join(getPaths().dataDir, "credentials", "feishu-default-allowFrom.json");
}

function listFeishuPairingRequests() {
  const store = readJsonFile(feishuPairingPath(), { version: 1, requests: [] });
  const requests = Array.isArray(store.requests) ? store.requests : [];
  return requests
    .filter((item) => item && typeof item === "object" && item.code && item.id)
    .map((item) => ({
      code: String(item.code || "").toUpperCase(),
      userId: String(item.id || ""),
      name: item.meta?.name ? String(item.meta.name) : "",
      accountId: item.meta?.accountId ? String(item.meta.accountId) : "default",
      createdAt: item.createdAt || "",
      lastSeenAt: item.lastSeenAt || "",
    }));
}

function listFeishuAllowFrom() {
  const store = readJsonFile(feishuAllowFromPath(), { version: 1, allowFrom: [] });
  return Array.isArray(store.allowFrom) ? store.allowFrom.map(String) : [];
}

/** 批准配对码：从待审批列表移入 allowFrom。 */
function approveFeishuPairing(codeRaw) {
  const code = String(codeRaw || "").trim().toUpperCase();
  if (!code) throw new Error("请提供配对码");
  const store = readJsonFile(feishuPairingPath(), { version: 1, requests: [] });
  const requests = Array.isArray(store.requests) ? store.requests : [];
  const index = requests.findIndex((item) => String(item?.code || "").toUpperCase() === code);
  if (index < 0) throw new Error(`未找到配对码 ${code}，请让对方在飞书里再发一条消息后刷新列表`);
  const entry = requests[index];
  const userId = String(entry.id || "").trim();
  if (!userId) throw new Error("配对请求缺少用户 ID");
  requests.splice(index, 1);
  writeJsonAtomic(feishuPairingPath(), { version: 1, requests });

  const allowFrom = listFeishuAllowFrom();
  if (!allowFrom.includes(userId)) allowFrom.push(userId);
  writeJsonAtomic(feishuAllowFromPath(), { version: 1, allowFrom });
  return { code, userId, name: entry.meta?.name ? String(entry.meta.name) : "", allowFrom };
}

function setFeishuDmPolicy(policyRaw) {
  const policy = String(policyRaw || "").trim();
  if (!["pairing", "open", "allowlist", "disabled"].includes(policy)) {
    throw new Error("dmPolicy 仅支持 pairing / open / allowlist / disabled");
  }
  const config = readConfig();
  config.channels = config.channels || {};
  const next = { ...stripChannelKeys(config.channels.feishu), dmPolicy: policy };
  if (policy === "open") {
    const allowFrom = Array.isArray(config.channels.feishu?.allowFrom) ? config.channels.feishu.allowFrom.map(String) : [];
    if (!allowFrom.includes("*")) allowFrom.push("*");
    next.allowFrom = allowFrom;
  }
  config.channels.feishu = next;
  writeConfig(config);
  return readFeishuConfig();
}

// ---- 钉钉对话（Stream 模式，由桥接进程承载连接） ----

function readDingTalkChannelConfig() {
  const fileConfig = decryptConfigSecrets(readJsonFile(dingtalkChannelFile()));
  const pluginPath = bundledPluginPath("openclaw-dingtalk-channel");
  const clientId = typeof fileConfig.clientId === "string" ? fileConfig.clientId : "";
  const clientSecret = typeof fileConfig.clientSecret === "string" ? fileConfig.clientSecret : "";
  return {
    enabled: fileConfig.enabled === true,
    accountId: typeof fileConfig.accountId === "string" && fileConfig.accountId.trim() ? fileConfig.accountId.trim() : "default",
    name: typeof fileConfig.name === "string" && fileConfig.name.trim() ? fileConfig.name.trim() : "钉钉对话",
    clientId,
    clientSecret,
    robotCode: typeof fileConfig.robotCode === "string" ? fileConfig.robotCode : "",
    configured: Boolean(clientId && clientSecret),
    pluginInstalled: fileExists(pluginPath),
    pluginPath,
  };
}

function writeDingTalkChannelConfig(input) {
  const pluginPath = bundledPluginPath("openclaw-dingtalk-channel");
  if (!fileExists(pluginPath)) {
    throw new Error("未找到钉钉对话通道插件，请确认安装包包含 plugins/openclaw-dingtalk-channel");
  }
  const clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
  const clientSecret = typeof input.clientSecret === "string" ? input.clientSecret.trim() : "";
  const enabled = typeof input.enabled === "boolean" ? input.enabled : Boolean(clientId && clientSecret);
  if (enabled && (!clientId || !clientSecret)) throw new Error("启用钉钉完整对话需要同时填写 Client ID 和 Client Secret");

  const fileConfig = {
    enabled,
    accountId: typeof input.accountId === "string" && input.accountId.trim() ? input.accountId.trim() : "default",
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : "钉钉对话",
    clientId,
    clientSecret,
    robotCode: typeof input.robotCode === "string" ? input.robotCode.trim() : "",
    allowConversationIds: Array.isArray(input.allowConversationIds) ? input.allowConversationIds.map((item) => String(item).trim()).filter(Boolean) : [],
    allowSenderStaffIds: Array.isArray(input.allowSenderStaffIds) ? input.allowSenderStaffIds.map((item) => String(item).trim()).filter(Boolean) : [],
  };
  writeJsonAtomic(dingtalkChannelFile(), encryptConfigSecrets(fileConfig));

  const config = readConfig();
  ensurePluginLoadPath(config, pluginPath);
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries["openclaw-dingtalk-channel"] = { enabled: true };
  config.channels = config.channels || {};
  config.channels["openclaw-dingtalk-channel"] = {
    ...(config.channels["openclaw-dingtalk-channel"] && typeof config.channels["openclaw-dingtalk-channel"] === "object" ? config.channels["openclaw-dingtalk-channel"] : {}),
    enabled: enabled && Boolean(clientId && clientSecret),
  };
  writeConfig(config);
  return readDingTalkChannelConfig();
}

// ---- 微信通道激活与整体通道预载 ----

/**
 * 激活便携通道：登记插件路径并打开通道开关。
 * 返回配置是否发生变更。
 */
function activatePortableChannel(channel) {
  const { modulesCacheDir } = getPaths();
  const config = readConfig();
  let changed = false;
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};

  if (channel === "openclaw-weixin") {
    const weixinPluginPath = path.join(modulesCacheDir, "@tencent-weixin", "openclaw-weixin");
    changed = ensurePluginLoadPath(config, weixinPluginPath) || changed;
    const entryWasEnabled = config.plugins.entries["openclaw-weixin"]?.enabled === true;
    config.plugins.entries["openclaw-weixin"] = { enabled: true };
    config.channels = config.channels || {};
    const current = config.channels["openclaw-weixin"] && typeof config.channels["openclaw-weixin"] === "object" ? config.channels["openclaw-weixin"] : {};
    const channelWasEnabled = current.enabled === true && Boolean(current.channelConfigUpdatedAt);
    config.channels["openclaw-weixin"] = {
      ...current,
      enabled: true,
      channelConfigUpdatedAt: current.channelConfigUpdatedAt || new Date().toISOString(),
    };
    changed = changed || !entryWasEnabled || !channelWasEnabled;
  } else if (channel === "qqbot") {
    for (const pluginPath of findQQBotPluginPaths()) changed = ensurePluginLoadPath(config, pluginPath) || changed;
    const entryWasEnabled = config.plugins.entries.qqbot?.enabled === true;
    config.plugins.entries.qqbot = { enabled: true };
    changed = changed || !entryWasEnabled;
  } else if (channel === "wecom") {
    const wecomPluginPath = path.join(modulesCacheDir, "@wecom", "wecom-openclaw-plugin");
    changed = ensurePluginLoadPath(config, wecomPluginPath) || changed;
    const entryWasEnabled = config.plugins.entries["wecom-openclaw-plugin"]?.enabled === true;
    config.plugins.entries["wecom-openclaw-plugin"] = { enabled: true };
    config.channels = config.channels || {};
    const current = config.channels.wecom && typeof config.channels.wecom === "object" ? config.channels.wecom : {};
    const shouldEnable = Boolean(String(current.botId || "").trim() && String(current.secret || "").trim());
    config.channels.wecom = {
      ...current,
      enabled: shouldEnable,
      connectionMode: current.connectionMode || "websocket",
      name: current.name || "企业微信",
      channelConfigUpdatedAt: current.channelConfigUpdatedAt || new Date().toISOString(),
    };
    changed = changed || !entryWasEnabled || current.enabled === true !== shouldEnable;
  } else if (channel === "feishu") {
    const feishuPluginPath = path.join(modulesCacheDir, "@openclaw", "feishu");
    changed = ensurePluginLoadPath(config, feishuPluginPath) || changed;
    const entryWasEnabled = config.plugins.entries.feishu?.enabled === true;
    config.plugins.entries.feishu = { enabled: true };
    config.channels = config.channels || {};
    const current = config.channels.feishu && typeof config.channels.feishu === "object" ? config.channels.feishu : {};
    const shouldEnable = Boolean(String(current.appId || "").trim() && String(current.appSecret || "").trim());
    config.channels.feishu = {
      ...stripChannelKeys(current),
      enabled: shouldEnable,
      connectionMode: current.connectionMode || "websocket",
      domain: current.domain || "feishu",
      dmPolicy: current.dmPolicy || "pairing",
      groupPolicy: current.groupPolicy || "allowlist",
      requireMention: typeof current.requireMention === "boolean" ? current.requireMention : true,
      streaming: typeof current.streaming === "boolean" ? current.streaming : false,
      blockStreaming: typeof current.blockStreaming === "boolean" ? current.blockStreaming : false,
      renderMode: current.renderMode || "raw",
    };
    changed = changed || !entryWasEnabled || current.enabled === true !== shouldEnable;
  } else if (channel === "openclaw-dingtalk-channel") {
    changed = ensurePluginLoadPath(config, bundledPluginPath("openclaw-dingtalk-channel")) || changed;
    const entryWasEnabled = config.plugins.entries["openclaw-dingtalk-channel"]?.enabled === true;
    config.plugins.entries["openclaw-dingtalk-channel"] = { enabled: true };
    config.channels = config.channels || {};
    const current = config.channels["openclaw-dingtalk-channel"] && typeof config.channels["openclaw-dingtalk-channel"] === "object"
      ? config.channels["openclaw-dingtalk-channel"]
      : {};
    const fileConfig = decryptConfigSecrets(readJsonFile(dingtalkChannelFile()));
    const shouldEnable = fileConfig.enabled === true && Boolean(fileConfig.clientId && fileConfig.clientSecret);
    config.channels["openclaw-dingtalk-channel"] = { ...current, enabled: shouldEnable };
    changed = changed || !entryWasEnabled || current.enabled === true !== shouldEnable;
  }
  writeConfig(config);
  return changed;
}

/** 启动向导保存时的通道预载：微信优先，其余通道按已配置状态激活。 */
function preloadChannelsForStart() {
  const changed = [];
  try { if (activatePortableChannel("openclaw-weixin")) changed.push("openclaw-weixin"); } catch { /* 通道激活失败不阻塞启动 */ }
  for (const channel of ["wecom", "feishu", "openclaw-dingtalk-channel"]) {
    try { if (activatePortableChannel(channel)) changed.push(channel); } catch { /* 单个通道失败不影响其余 */ }
  }
  return changed;
}

// ---- QQ 插件安装与凭证 ----

async function installQQBotPlugin() {
  let installed = findQQBotPluginPaths().length > 0;
  if (!installed) installed = ensureQQBotDependencyPayload();
  if (!installed) throw new Error("QQBot 插件安装包不存在，请重新获取客户端更新包。");
  const config = readConfig();
  for (const pluginPath of findQQBotPluginPaths()) ensurePluginLoadPath(config, pluginPath);
  writeConfig(config);
  return { ok: true, installed: true, message: "QQ 插件安装完成，请点击扫码绑定。" };
}

/** 把扫码得到的机器人账号写入通道配置。 */
function applyQQBotCredentials(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const config = readConfig();
  config.channels = config.channels || {};
  const current = config.channels.qqbot && typeof config.channels.qqbot === "object" ? config.channels.qqbot : {};
  const first = accounts[0];
  const next = {
    ...current,
    enabled: true,
    allowFrom: Array.isArray(current.allowFrom) ? current.allowFrom : ["*"],
    appId: String(first.appId || "").trim(),
    clientSecret: String(first.appSecret || "").trim(),
  };
  delete next.clientSecretFile;
  if (accounts.length > 1) {
    const existingAccounts = current.accounts && typeof current.accounts === "object" ? current.accounts : {};
    next.accounts = { ...existingAccounts };
    for (let index = 1; index < accounts.length; index++) {
      const account = accounts[index];
      const accountId = String(account.appId || "").trim();
      if (!accountId) continue;
      next.accounts[accountId] = {
        ...(existingAccounts[accountId] && typeof existingAccounts[accountId] === "object" ? existingAccounts[accountId] : {}),
        enabled: true,
        allowFrom: ["*"],
        appId: accountId,
        clientSecret: String(account.appSecret || "").trim(),
      };
    }
  }
  config.channels.qqbot = next;
  for (const pluginPath of findQQBotPluginPaths()) ensurePluginLoadPath(config, pluginPath);
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries.qqbot = { enabled: true };
  writeConfig(config);
  return { appId: next.appId, count: accounts.length };
}

/** 通道运行时残留进程清理由 process-manager 的看护进程承担。 */

module.exports = {
  activatePortableChannel,
  applyQQBotCredentials,
  installQQBotPlugin,
  listFeishuAllowFrom,
  listFeishuPairingRequests,
  approveFeishuPairing,
  preloadChannelsForStart,
  readDingTalkChannelConfig,
  readFeishuConfig,
  readWecomConfig,
  setFeishuDmPolicy,
  writeDingTalkChannelConfig,
  writeFeishuConfig,
  writeWecomConfig,
};

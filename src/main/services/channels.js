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
const { bundledPluginPath, ensurePayload, findQQBotPluginPaths } = require("./modules");

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
  const botId = typeof channel.botId === "string" ? channel.botId : "";
  const secret = typeof channel.secret === "string" ? channel.secret : "";
  return {
    enabled: channel.enabled === true,
    connectionMode: channel.connectionMode || "websocket",
    name: channel.name || "企业微信",
    botId,
    secret,
    configured: Boolean(botId && secret),
  };
}

/**
 * 安装企业微信官方插件（openclaw 官方安装布局）：payload 解压到 state 的 extensions 目录，
 * openclaw 依赖按本机模块缓存重建链接——官方安装器就是这么做链接的，但链接目标含
 * 机器相关的缓存哈希，不随包分发，换机器激活时重建。
 */
function installWecomPlugin() {
  const target = ensurePayload("wecom");
  if (!target) throw new Error("企业微信插件安装包缺失，请重新获取客户端更新包。");
  const linkPath = path.join(target, "node_modules", "openclaw");
  if (!fs.existsSync(linkPath)) {
    try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* 没有旧链接 */ }
    fs.symlinkSync(path.join(getPaths().modulesCacheDir, "openclaw"), linkPath, "junction");
  }
  return { ok: true, installed: true, target };
}

function writeWecomConfig(input) {
  const botId = typeof input.botId === "string" ? input.botId.trim() : "";
  const secret = typeof input.secret === "string" ? input.secret.trim() : "";
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "企业微信";
  const enabled = typeof input.enabled === "boolean" ? input.enabled : Boolean(botId && secret);
  if (enabled && (!botId || !secret)) throw new Error("启用企业微信需要同时填写 Bot ID 和 Secret");

  installWecomPlugin();
  const config = readConfig();
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries["wecom-openclaw-plugin"] = { enabled: true };
  // extensions 目录发现的插件按 openclaw 建议显式加白名单，避免"allow 为空自动加载"的告警。
  config.plugins.allow = [...new Set([...(Array.isArray(config.plugins.allow) ? config.plugins.allow.map(String) : []), "wecom-openclaw-plugin"])];
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
  const pluginPath = channelPluginPath("feishu", ["@openclaw", "feishu"]);
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
  const pluginPath = channelPluginPath("feishu", ["@openclaw", "feishu"]);
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

// openclaw 的 pairing-store 把配对与 allowFrom 都放在 state 目录的 credentials 下
// （data/.openclaw/credentials，带账号键），读写必须跟插件同目录。
function feishuPairingPath() {
  return path.join(getPaths().stateDir, "credentials", "feishu-pairing.json");
}

function feishuAllowFromPath() {
  return path.join(getPaths().stateDir, "credentials", "feishu-default-allowFrom.json");
}

/** 已批准用户的名字备注（侧车文件）：allowFrom 本体是插件读取的纯 ID 列表，名字只能另存。 */
function feishuApprovedNamesPath() {
  return path.join(getPaths().stateDir, "credentials", "feishu-approved-names.json");
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

/** 批准配对码：从待审批列表移入 allowFrom，并记下名字备注供已批准列表展示。 */
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

  const name = entry.meta?.name ? String(entry.meta.name) : "";
  if (name) {
    const namesStore = readJsonFile(feishuApprovedNamesPath(), { version: 1, names: {} });
    namesStore.names = { ...(namesStore.names || {}), [userId]: name };
    writeJsonAtomic(feishuApprovedNamesPath(), namesStore);
  }
  return { code, userId, name, allowFrom };
}

/** 已批准可私聊的用户：allowFrom 存储与配置两处合并（去掉通配），附审批时记下的名字。 */
function listApprovedFeishuUsers() {
  const names = readJsonFile(feishuApprovedNamesPath(), { version: 1, names: {} }).names || {};
  const config = readConfig();
  const channel = config.channels && typeof config.channels.feishu === "object" ? config.channels.feishu : {};
  const configList = Array.isArray(channel.allowFrom) ? channel.allowFrom.map(String) : [];
  const ids = [...new Set([...listFeishuAllowFrom(), ...configList])].filter((entry) => entry && entry !== "*");
  return ids.map((id) => ({ id, name: typeof names[id] === "string" ? names[id] : "" }));
}

/**
 * 取消批准：从 allowFrom 存储与配置里移除该用户（存储部分即时生效，配置部分需网关重启）。
 * 返回 configChanged 供调用方决定是否标记待重启。
 */
function revokeFeishuUser(userIdRaw) {
  const userId = String(userIdRaw || "").trim();
  if (!userId) throw new Error("请提供用户 ID");
  const store = readJsonFile(feishuAllowFromPath(), { version: 1, allowFrom: [] });
  const allowFrom = Array.isArray(store.allowFrom) ? store.allowFrom.map(String) : [];
  writeJsonAtomic(feishuAllowFromPath(), { version: 1, allowFrom: allowFrom.filter((entry) => entry !== userId) });

  const namesStore = readJsonFile(feishuApprovedNamesPath(), { version: 1, names: {} });
  if (namesStore.names && namesStore.names[userId]) {
    delete namesStore.names[userId];
    writeJsonAtomic(feishuApprovedNamesPath(), namesStore);
  }

  const config = readConfig();
  const channel = config.channels && typeof config.channels.feishu === "object" ? config.channels.feishu : {};
  if (Array.isArray(channel.allowFrom) && channel.allowFrom.includes(userId)) {
    channel.allowFrom = channel.allowFrom.filter((entry) => entry !== userId);
    writeConfig(config);
    return { ok: true, userId, configChanged: true };
  }
  return { ok: true, userId, configChanged: false };
}

/** 切换飞书私聊策略；开放模式用通配 "*" 放行所有人，切回受限策略时收回通配（保留已批准的用户）。 */
function setFeishuDmPolicy(policyRaw) {
  const policy = String(policyRaw || "").trim();
  if (!["pairing", "open", "allowlist", "disabled"].includes(policy)) {
    throw new Error("dmPolicy 仅支持 pairing / open / allowlist / disabled");
  }
  const config = readConfig();
  config.channels = config.channels || {};
  const previous = config.channels.feishu && typeof config.channels.feishu === "object" ? config.channels.feishu : {};
  const allowFrom = Array.isArray(previous.allowFrom) ? previous.allowFrom.map(String) : [];
  const kept = policy === "open"
    ? (allowFrom.includes("*") ? allowFrom : [...allowFrom, "*"])
    : allowFrom.filter((entry) => entry !== "*");
  // allowFrom 必须显式写回目标列表（可为空表）：writeConfig 是合并语义，输入里缺省的键删不掉磁盘旧值。
  const next = { ...stripChannelKeys(previous), dmPolicy: policy, allowFrom: kept };
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
 * 通道插件目录：优先随包分发的 resources/plugins/<name>（自包含），
 * 没有再用模块包解压出来的同名副本（如飞书：只随模块包分发）。
 * 只登记一条，避免同一插件被两个路径重复加载。
 */
function channelPluginPath(bundledName, cacheSegments) {
  const bundled = bundledPluginPath(bundledName);
  if (fileExists(bundled)) return bundled;
  const cached = path.join(getPaths().modulesCacheDir, ...cacheSegments);
  return fileExists(cached) ? cached : bundled;
}

/**
 * 激活便携通道：登记插件路径并打开通道开关。
 * 返回配置是否发生变更。
 */
function activatePortableChannel(channel) {
  const config = readConfig();
  let changed = false;
  config.plugins = config.plugins || {};
  config.plugins.entries = config.plugins.entries || {};

  if (channel === "openclaw-weixin") {
    changed = ensurePluginLoadPath(config, channelPluginPath("openclaw-weixin", ["@tencent-weixin", "openclaw-weixin"])) || changed;
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
    installWecomPlugin();
    const entryWasEnabled = config.plugins.entries["wecom-openclaw-plugin"]?.enabled === true;
    config.plugins.entries["wecom-openclaw-plugin"] = { enabled: true };
    // extensions 目录发现的插件按 openclaw 建议显式加白名单（allow 为空时它会以告警方式自动加载）。
    if (!(Array.isArray(config.plugins.allow) ? config.plugins.allow : []).includes("wecom-openclaw-plugin")) {
      config.plugins.allow = [...(config.plugins.allow || []), "wecom-openclaw-plugin"];
      changed = true;
    }
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
    // 飞书只随模块包分发（resources 里没有），落在本机缓存里，加载路径白名单允许缓存目录。
    changed = ensurePluginLoadPath(config, channelPluginPath("feishu", ["@openclaw", "feishu"])) || changed;
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
  if (!installed) installed = Boolean(ensurePayload("qqbot"));
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

/**
 * 删除不再使用的微信账号数据：索引去掉该账号，并清掉它的凭据、同步缓存、
 * 上下文令牌与授权名单（布局见 openclaw-weixin/src/auth/accounts.ts 的 clearWeixinAccount）。
 * 重新绑定到另一个微信号后调用，避免新旧两个号同时在线收消息。
 */
function dropWeixinAccounts(accountIds) {
  const targets = (Array.isArray(accountIds) ? accountIds : []).map(String).filter(Boolean);
  if (!targets.length) return [];
  const { stateDir } = getPaths();
  const accountsDir = path.join(stateDir, "openclaw-weixin", "accounts");
  const removed = [];
  for (const accountId of targets) {
    for (const name of [`${accountId}.json`, `${accountId}.sync.json`, `${accountId}.context-tokens.json`]) {
      try { fs.rmSync(path.join(accountsDir, name), { force: true }); } catch { /* 不存在即忽略 */ }
    }
    try { fs.rmSync(path.join(stateDir, "credentials", `openclaw-weixin-${accountId}-allowFrom.json`), { force: true }); } catch { /* 不存在即忽略 */ }
    removed.push(accountId);
  }
  const kept = listWeixinAccounts().filter((id) => !targets.includes(id));
  try {
    fs.writeFileSync(path.join(stateDir, "openclaw-weixin", "accounts.json"), `${JSON.stringify(kept, null, 2)}
`, "utf8");
  } catch { /* 索引写入失败时账号文件已删，下次绑定会重建 */ }
  return removed;
}

/** 微信已绑定账号 ID 列表（插件把绑定结果写在 .openclaw/openclaw-weixin/accounts.json）。 */
function listWeixinAccounts() {
  try {
    const file = path.join(getPaths().stateDir, "openclaw-weixin", "accounts.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 各通道连接状态摘要：向导据此判断"已经接入了一个平台"，确认页/运行页的"聊天工具"清单也按它列
 * （以已配置为准——扫码绑上或凭据填全，向导里仅选中未配置的不算）。微信看插件落盘的账号文件
 * （内存态重启即丢），其余通道看本地配置是否填全。
 * 键名与渲染层通道目录的工具 id 一致（如 dingtalk-channel），否则"聊天工具"清单会漏通道。
 */
function channelSummary() {
  const weixinAccounts = listWeixinAccounts();
  const feishu = readFeishuConfig();
  return {
    wechat: { connected: weixinAccounts.length > 0, accounts: weixinAccounts.length },
    wecom: { connected: readWecomConfig().configured },
    feishu: { connected: feishu.configured, domain: feishu.domain },
    "dingtalk-channel": { connected: readDingTalkChannelConfig().configured },
    qqbot: { connected: readQQBotBinding().bound },
  };
}

/** QQ bot 已绑定的落盘信息：面板据此在切页、重启后仍显示绑定态。 */
function readQQBotBinding() {
  const config = readConfig();
  const qqbot = config.channels && typeof config.channels.qqbot === "object" ? config.channels.qqbot : {};
  const appId = String(qqbot.appId || "").trim();
  return { bound: qqbot.enabled === true && Boolean(appId), appId };
}

module.exports = {
  activatePortableChannel,
  applyQQBotCredentials,
  channelSummary,
  dropWeixinAccounts,
  installQQBotPlugin,
  installWecomPlugin,
  listApprovedFeishuUsers,
  listFeishuAllowFrom,
  listFeishuPairingRequests,
  listWeixinAccounts,
  approveFeishuPairing,
  preloadChannelsForStart,
  readDingTalkChannelConfig,
  readFeishuConfig,
  readQQBotBinding,
  readWecomConfig,
  revokeFeishuUser,
  setFeishuDmPolicy,
  writeDingTalkChannelConfig,
  writeFeishuConfig,
  writeWecomConfig,
};

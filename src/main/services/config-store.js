/**
 * openclaw 配置存取：openclaw.json 的读取、深合并写入、敏感字段加密、出厂模板、agent 凭证同步与插件加载路径治理。
 * 全部写入使用原子写，数据目录固定在 U 盘 data/。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const { decryptConfigSecrets, encryptConfigSecrets, normalizeProviderModels, writeJsonAtomic } = require("./secret-crypto");
const { appendLogLine } = require("./logs");

/**
 * 出厂模板：重置与首次读取时使用，网关 token 每次生成随机值。
 * 不带任何 provider 与默认模型：模型由订阅同步、后台下发或向导里手填三者之一写入，模板里预置一个会出现"后台已停用但客户端仍显示"的幽灵模型。
 */
function buildFactoryConfig() {
  return {
    gateway: { mode: "local", port: 18789, bind: "loopback", auth: { mode: "token", token: crypto.randomBytes(32).toString("hex") } },
    session: { dmScope: "per-channel-peer" },
    agents: { defaults: { thinkingDefault: "off", compaction: { reserveTokensFloor: 20000 } } },
    models: { providers: {} },
    plugins: {
      entries: {
        "openclaw-weixin": { enabled: false },
        "openclaw-dingtalk": { enabled: false },
        qqbot: { enabled: false },
        "wecom-openclaw-plugin": { enabled: false },
        feishu: { enabled: false },
      },
      load: { paths: [] },
    },
    channels: { "openclaw-weixin": { enabled: false } },
    update: { checkOnStart: false, auto: { enabled: false } },
  };
}

function fileExists(file) {
  try { return fs.existsSync(file); } catch { return false; }
}

/** 读取配置（自动解密敏感字段）；文件缺失时生成出厂模板。 */
function readConfig() {
  const { configPath } = getPaths();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const config = decryptConfigSecrets(JSON.parse(stripBom(raw)));
    if (!config.gateway?.auth?.token) {
      config.gateway = config.gateway || {};
      config.gateway.auth = config.gateway.auth || { mode: "token" };
      config.gateway.auth.token = crypto.randomBytes(32).toString("hex");
      writeConfig(config);
    }
    return config;
  } catch (error) {
    if (fileExists(configPath)) throw error;
    const factory = buildFactoryConfig();
    writeConfig(factory);
    return factory;
  }
}

/**
 * 向导配置是否已保存过：以 U 盘上的向导完成标记为准（出厂重置会删除），不依赖本机 localStorage，也不以出厂模板自带的 provider 误判。
 */
function isConfigured() {
  return fileExists(path.join(getPaths().dataDir, "wizard-completed.flag"));
}

/**
 * 写入配置。默认与现有配置深合并（UI 只发送当前选中的 provider，其余保留），replace 为 true 时整体替换（出厂重置使用，防止旧密钥残留）。
 */
/** 调用点（文件:行），用于排查"这次配置是谁改的"。 */
function callerSite() {
  const frames = String(new Error().stack || "").split("\n").slice(2);
  const frame = frames.find((line) => line.includes(".js") && !line.includes("config-store.js"));
  const match = frame && frame.match(/([^()\s]+:\d+):\d+/);
  return match ? match[1] : "unknown";
}

/** provider 概览：id(keyMode,key=长度)；key 显示为 enc 表示仍是加密包络。 */
function describeProviders(config) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return "-";
  const parts = Object.entries(providers).map(([id, provider]) => {
    const key = provider?.apiKey;
    const size = typeof key === "string" ? key.length : key ? "enc" : 0;
    return `${id}(${provider?.keyMode || "-"},key=${size})`;
  });
  return parts.length ? parts.join(" ") : "-";
}

function writeConfig(input, options = {}) {
  const { configPath } = getPaths();
  const keyPreserved = [];
  let merged = input;
  if (!options.replace) {
    let existing = {};
    try {
      if (fileExists(configPath)) {
        existing = decryptConfigSecrets(JSON.parse(stripBom(fs.readFileSync(configPath, "utf8"))));
      }
    } catch { /* 读取失败按空配置合并 */ }
    merged = deepMerge(existing, input);
    if (merged.models?.providers && input.models?.providers) {
      const incomingKeys = new Set(Object.keys(input.models.providers));
      for (const key of Object.keys(merged.models.providers)) {
        if (!incomingKeys.has(key)) delete merged.models.providers[key];
      }
    }
    // 订阅 provider（keyMode=server）的 Key 就是登录令牌，正常不该为空：
    // 若某次写入没带上它，沿用磁盘上已有的 Key，避免把网关鉴权写坏（退出登录会整条删掉 provider）。
    const existingProviders = (existing.models && existing.models.providers) || {};
    for (const [id, provider] of Object.entries(merged.models?.providers || {})) {
      if (!provider || typeof provider !== "object" || provider.keyMode !== "server") continue;
      if (provider.apiKey) continue;
      const previous = existingProviders[id];
      if (previous && typeof previous.apiKey === "string" && previous.apiKey) {
        provider.apiKey = previous.apiKey;
        keyPreserved.push(id);
      }
    }
  }
  // 写配置来源日志：谁改的、provider 与 Key 变成什么样、有没有被护栏保住。
  const incomingIds = Object.keys(input?.models?.providers || {});
  const mergedIds = Object.keys(merged.models?.providers || {});
  const droppedIds = incomingIds.length && options.replace !== true
    ? mergedIds.filter((id) => !incomingIds.includes(id))
    : [];
  appendLogLine(
    "config-writes.log",
    `via ${callerSite()} providers=[${describeProviders(input)}] => [${describeProviders(merged)}]`
    + `${droppedIds.length ? ` provider-dropped=[${droppedIds.join(",")}]` : ""}`
    + `${keyPreserved.length ? ` key-preserved=[${keyPreserved.join(",")}]` : ""}`
    + `${options.replace ? " replace=true" : ""}`,
  );

  normalizePortableFields(merged);
  // 已启用的插件条目：打包插件目录存在时自动注册加载路径，避免网关因插件缺失拒绝启动。
  const { pluginsDir: bundleDir } = getPaths();
  for (const [key, entry] of Object.entries(merged.plugins?.entries || {})) {
    if (entry?.enabled !== true) continue;
    ensurePluginLoadPath(merged, path.join(bundleDir, key));
  }
  normalizeProviderModels(merged);
  reconcilePluginLoadPaths(merged);
  writeJsonAtomic(configPath, encryptConfigSecrets(merged));
  syncAgentAuthProfilesFromConfig(merged);
  return { ok: true };
}

/**
 * 便携版约定字段的兜底修正：锦锐端点、各 provider 的模型展示名、思考默认值与压缩保留下限。
 * 放在写入路径上做，任何一次改配置都会补齐（含升级前写好的旧配置），且都是幂等的。
 */
function normalizePortableFields(config) {
  try {
    const providers = config?.models?.providers;
    if (providers && typeof providers === "object" && !Array.isArray(providers)) {
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
        provider.models = brandModelNames(provider.models, provider.displayName);
      }
    }
    const provider = config?.models?.providers?.["jinrui-deepseek"];
    if (provider && typeof provider === "object") {
      const baseUrl = String(provider.baseUrl || "").trim().replace(/\/+$/, "");
      if (!baseUrl || /^http:\/\/192\.168\.0\.212:13000(?:\/v1)?$/i.test(baseUrl)) {
        provider.baseUrl = "https://cloud.tejinrui.com/api/balance/v1";
      } else if (/192\.168\.0\.212:13000/.test(baseUrl) && !/\/v1$/i.test(baseUrl)) {
        provider.baseUrl = baseUrl + "/v1";
      }
      if (!provider.api) provider.api = "openai-completions";
      if (!provider.keyMode) provider.keyMode = "client";
      if (Array.isArray(provider.models)) {
        provider.models = provider.models.map((item) => (item && typeof item === "object" ? { ...item, reasoning: item.reasoning === true } : item));
      }
    }
    if (config?.agents?.defaults) {
      if (!config.agents.defaults.thinkingDefault) config.agents.defaults.thinkingDefault = "off";
      config.agents.defaults.compaction = config.agents.defaults.compaction && typeof config.agents.defaults.compaction === "object"
        ? config.agents.defaults.compaction
        : {};
      const floor = Number(config.agents.defaults.compaction.reserveTokensFloor || 0);
      if (!Number.isFinite(floor) || floor < 20000) {
        config.agents.defaults.compaction.reserveTokensFloor = 20000;
      }
    }
    // 飞书私聊通配守卫："*" 只允许出现在开放模式；受限策略下残留的通配会让所有人绕过配对审批。
    const feishu = config?.channels?.feishu;
    if (feishu && typeof feishu === "object" && !Array.isArray(feishu) && Array.isArray(feishu.allowFrom) && feishu.dmPolicy !== "open") {
      const filtered = feishu.allowFrom.filter((entry) => entry !== "*");
      if (filtered.length !== feishu.allowFrom.length) feishu.allowFrom = filtered;
    }
  } catch { /* 兜底修正失败不阻塞保存 */ }
}

/**
 * 给模型展示名加品牌前缀（`中广云 · DeepSeek V4 Flash`）。
 * 网关聊天界面的模型列表只显示 `models[].name`，只有重名时才补 provider id，所以品牌前缀是让人一眼看出模型属于哪个提供商的唯一手段；已带同前缀的不重复加。
 * 纯展示字段，不影响实际调用（调用走 `providerId/modelId`）。
 */
function brandModelNames(models, brand) {
  const name = String(brand || "").trim();
  if (!name || !Array.isArray(models)) return models;
  const prefix = `${name} · `;
  return models.map((model) => {
    if (!model || typeof model !== "object" || Array.isArray(model)) return model;
    const current = String(model.name || model.id || "").trim();
    if (!current || current.startsWith(prefix)) return model;
    return { ...model, name: `${prefix}${current}` };
  });
}

/**
 * 把订阅模型信息写进 provider 与默认模型（含 OAuth 令牌）。
 * 向导保存、手动同步、令牌保活三条路径共用，避免各写一份导致字段不一致。
 */
function writeSubscriptionProvider(synced) {
  const config = readConfig();
  config.models = config.models || {};
  config.models.providers = config.models.providers || {};
  config.models.providers[synced.providerId] = {
    ...(config.models.providers[synced.providerId] || {}),
    displayName: synced.providerName,
    api: "openai-completions",
    keyMode: "server",
    baseUrl: synced.baseUrl,
    apiKey: synced.accessToken,
    models: synced.models,
  };
  config.agents = config.agents || {};
  config.agents.defaults = config.agents.defaults || {};
  config.agents.defaults.model = `${synced.providerId}/${synced.defaultModel}`;
  writeConfig(config);
  return config.models.providers[synced.providerId];
}

/**
 * 插件加载路径治理：只保留当前会话真实存在的目录（应用资源内插件目录 + U 盘数据目录里的 QQ 插件工程），其余清掉。
 */
function reconcilePluginLoadPaths(config) {
  const { pluginsDir, npmProjectsDir, modulesCacheDir } = getPaths();
  // 模块缓存也是合法的插件目录：按需解压的插件（飞书）落在那里。
  const allowedRoots = [path.resolve(pluginsDir), path.resolve(npmProjectsDir), path.resolve(modulesCacheDir)];
  const allowed = (candidate) => {
    if (typeof candidate !== "string" || !candidate) return false;
    const resolved = path.resolve(candidate);
    if (!fileExists(resolved)) return false;
    return allowedRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  };
  config.plugins = config.plugins || {};
  config.plugins.load = config.plugins.load || {};
  config.plugins.load.paths = Array.isArray(config.plugins.load.paths)
    ? config.plugins.load.paths.filter(allowed)
    : [];
  return config;
}

/** 在配置中登记一个插件加载目录（去重）。 */
function ensurePluginLoadPath(config, pluginPath) {
  if (!pluginPath || !fileExists(pluginPath)) return false;
  config.plugins = config.plugins || {};
  config.plugins.load = config.plugins.load || {};
  config.plugins.load.paths = Array.isArray(config.plugins.load.paths) ? config.plugins.load.paths : [];
  const resolved = path.resolve(pluginPath);
  if (config.plugins.load.paths.some((item) => path.resolve(item) === resolved)) return false;
  config.plugins.load.paths.push(pluginPath);
  return true;
}

/**
 * 把 provider 的 API Key 同步到 agent 凭证目录，让网关和 agent 直接使用同一份凭证，并清除粘滞的失败状态。
 */
function syncAgentAuthProfilesFromConfig(config) {
  const { stateDir } = getPaths();
  try {
    const providers = config.models && typeof config.models.providers === "object" ? config.models.providers : {};
    const providerIds = new Set(Object.keys(providers));
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    const authPath = path.join(agentDir, "auth-profiles.json");
    const modelsPath = path.join(agentDir, "models.json");
    const authStatePath = path.join(agentDir, "auth-state.json");

    let store = { version: 1, profiles: {} };
    try {
      const existing = readJsonFile(authPath);
      if (existing?.profiles && typeof existing.profiles === "object") {
        store = { version: Number(existing.version || 1) || 1, profiles: { ...existing.profiles } };
      }
    } catch { /* 首次运行为空 */ }

    // 派生凭证一律重建：先清空 api_key 类型条目，避免已移除 provider 的旧令牌残留。
    for (const [profileId, profile] of Object.entries(store.profiles)) {
      if (profile?.type === "api_key") delete store.profiles[profileId];
    }

    const modelsStore = { providers: {} };
    for (const [providerId, providerConfig] of Object.entries(providers)) {
      if (!providerConfig || typeof providerConfig !== "object") continue;
      const apiKey = typeof providerConfig.apiKey === "string" ? providerConfig.apiKey.trim() : "";
      if (apiKey) {
        store.profiles[providerId] = { type: "api_key", provider: providerId, key: apiKey, copyToAgents: true };
      }
      modelsStore.providers[providerId] = {
        baseUrl: providerConfig.baseUrl || "",
        api: providerConfig.api || "openai-completions",
        models: Array.isArray(providerConfig.models) ? providerConfig.models : [],
      };
      if (apiKey) modelsStore.providers[providerId].apiKey = apiKey;
    }

    writeJsonAtomic(authPath, store);
    writeJsonAtomic(modelsPath, modelsStore);
    writeJsonAtomic(authStatePath, { version: 1, lastGood: {}, usageStats: {} });
  } catch (error) {
    console.error("[config-store] 同步 agent 凭证失败:", error.message);
  }
}

/**
 * 删除单个路径；Windows 下被进程占用的句柄释放有延迟，失败时稍等重试。
 * 必须用异步的 fs.promises.rm：同步递归删除一棵几千文件的树会堵住主进程事件循环，
 * 窗口不重绘、IPC 不返回，用户看到的就是"点了恢复出厂直接卡死"。
 * 返回是否删除成功（目标本就不存在也算成功）。
 */
async function removePathWithRetry(target, attempts = 6, waitMs = 300) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt >= attempts - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** 出厂重置：清空用户痕迹（保留通道依赖的包缓存目录），写入干净模板。
 * 有数据因占用删不掉时如实报错给界面，不静默留残数据（半清状态会让界面显示错的绑定态）。 */
async function resetAll() {
  const { dataDir, logsDir, configPath } = getPaths();
  const keepItems = new Set(["openclaw.json", "secret.key", "extensions", "npm", "plugin-skills", "license.json"]);
  const failed = [];
  for (const item of await fs.promises.readdir(dataDir)) {
    if (keepItems.has(item)) continue;
    if (!(await removePathWithRetry(path.join(dataDir, item)))) failed.push(item);
  }
  if (failed.length) {
    throw new Error(`部分数据被进程占用，未能清除：${failed.join("、")}。请稍候重试恢复出厂设置`);
  }
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "credentials"), { recursive: true });
  writeConfig(buildFactoryConfig(), { replace: true });
  return { ok: true, configPath };
}

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readJsonFile(file) {
  try {
    if (!fileExists(file)) return {};
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch {
    return {};
  }
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

module.exports = {
  deepMerge,
  ensurePluginLoadPath,
  isConfigured,
  readConfig,
  resetAll,
  writeConfig,
  writeSubscriptionProvider,
};

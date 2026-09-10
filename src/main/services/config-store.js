/**
 * openclaw 配置存取：openclaw.json 的读取、深合并写入、敏感字段加密、
 * 出厂模板、agent 凭证同步与插件加载路径治理。
 * 全部写入使用原子写，数据目录固定在 U 盘 data/。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const { decryptConfigSecrets, encryptConfigSecrets, writeJsonAtomic } = require("./secret-crypto");

const LAZY_CHANNEL_PLUGIN_KEYS = ["openclaw-weixin", "@openclaw/qqbot", "@wecom/wecom-openclaw-plugin", "@openclaw/feishu", "openclaw-dingtalk-channel"];

/** 出厂模板：重置与首次读取时使用，网关 token 每次生成随机值。 */
function buildFactoryConfig() {
  return {
    gateway: { mode: "local", port: 18789, bind: "loopback", auth: { mode: "token", token: crypto.randomBytes(32).toString("hex") } },
    session: { dmScope: "per-channel-peer" },
    agents: { defaults: { model: "jinrui-deepseek/deepseek-v4-flash", thinkingDefault: "off", compaction: { reserveTokensFloor: 20000 } } },
    models: {
      providers: {
        "jinrui-deepseek": {
          baseUrl: "https://cloud.tejinrui.com/api/balance/v1",
          keyMode: "client",
          api: "openai-completions",
          models: [
            { id: "deepseek-v4-flash", name: "deepseek-v4-flash", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
            { id: "deepseek-v4-pro", name: "deepseek-v4-pro", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192 },
          ],
        },
      },
    },
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
 * 向导配置是否已保存过：以 U 盘上的向导完成标记为准（出厂重置会删除），
 * 不依赖本机 localStorage，也不以出厂模板自带的 provider 误判。
 */
function isConfigured() {
  return fileExists(path.join(getPaths().dataDir, "wizard-completed.flag"));
}

/**
 * 写入配置。默认与现有配置深合并（UI 只发送当前选中的 provider，其余保留），
 * replace 为 true 时整体替换（出厂重置使用，防止旧密钥残留）。
 */
function writeConfig(input, options = {}) {
  const { configPath } = getPaths();
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
  }
  normalizePortableFields(merged);
  reconcilePluginLoadPaths(merged);
  writeJsonAtomic(configPath, encryptConfigSecrets(merged));
  syncAgentAuthProfilesFromConfig(merged);
  return { ok: true };
}

/** 便携版约定字段的兜底修正：锦锐端点、思考默认值与压缩保留下限。 */
function normalizePortableFields(config) {
  try {
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
  } catch { /* 兜底修正失败不阻塞保存 */ }
}

/**
 * 插件加载路径治理：只保留当前会话真实存在的目录
 * （应用资源内插件目录 + U 盘数据目录里的 QQ 插件工程），其余清掉。
 */
function reconcilePluginLoadPaths(config) {
  const { pluginsDir, npmProjectsDir } = getPaths();
  const allowedRoots = [path.resolve(pluginsDir), path.resolve(npmProjectsDir)];
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
 * 把 provider 的 API Key 同步到 agent 凭证目录，
 * 让网关和 agent 直接使用同一份凭证，并清除粘滞的失败状态。
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

    for (const [profileId, profile] of Object.entries(store.profiles)) {
      const provider = profile && typeof profile.provider === "string" ? profile.provider : profileId;
      if (providerIds.has(provider) && profile?.type === "api_key") delete store.profiles[profileId];
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

/** 出厂重置：清空用户痕迹（保留通道依赖的包缓存目录），写入干净模板。 */
function resetAll() {
  const { dataDir, stateDir, logsDir, configPath } = getPaths();
  const keepItems = new Set(["openclaw.json", "secret.key", "extensions", "npm", "plugin-skills"]);
  for (const item of fs.readdirSync(dataDir)) {
    if (keepItems.has(item)) continue;
    try { fs.rmSync(path.join(dataDir, item), { recursive: true, force: true }); } catch { /* 忽略占用 */ }
  }
  for (const stale of ["openclaw-weixin", "dingtalk.json", "dingtalk-channel.json", "dingtalk-channel.sessions.json", "credentials", "devices", "agents", "media", "state"]) {
    try { fs.rmSync(path.join(dataDir, stale), { recursive: true, force: true }); } catch { /* 忽略占用 */ }
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
  LAZY_CHANNEL_PLUGIN_KEYS,
  deepMerge,
  ensurePluginLoadPath,
  isConfigured,
  readConfig,
  resetAll,
  writeConfig,
};

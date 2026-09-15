/**
 * 应用配置装载：内置默认配置（resources/app.config.json）叠加 U 盘根目录的
 * 可选覆盖文件（app.config.json），运营参数全部通过配置文件调整，不在代码中硬编码。
 */
const fs = require("fs");
const path = require("path");
const { getPaths } = require("./paths");

let cached = null;

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
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

function readConfigFile(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`配置文件解析失败 ${file}: ${error.message}`);
  }
}

/** 读取合并后的完整配置（含密钥字段），仅限主进程内部使用。 */
function getAppConfig() {
  if (!cached) {
    const { resourcesDir, productRoot } = getPaths();
    const defaults = readConfigFile(path.join(resourcesDir, "app.config.json"));
    const override = readConfigFile(path.join(productRoot, "app.config.json"));
    cached = deepMerge(defaults, override);
  }
  return cached;
}

/** 渲染进程可见的配置视图：剔除 clientSecret 等敏感字段。 */
function getPublicConfig() {
  const config = getAppConfig();
  return {
    product: config.product,
    ports: config.ports,
    channels: { docs: config.channels?.docs || {} },
    oauth: {
      authorizationOrigin: config.oauth.authorizationOrigin,
      redirectUri: config.oauth.redirectUri,
      clientType: config.oauth.clientType,
    },
    models: config.models,
    subscription: config.subscription,
    ui: config.ui,
  };
}

module.exports = { getAppConfig, getPublicConfig };

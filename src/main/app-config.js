/**
 * 应用配置装载：运营参数全部来自配置文件，不在代码里硬编码。
 *
 * - 开发模式：读 `resources/app.config.json`（不入库，填你自己的联调地址，一次配好长期有效），没有这份文件时回落到入库的 `resources/app.config.example.json`（本地开发默认值）；
 * - 打包后：只读 asar 内的 `resources/app.config.json`（构建时注入的线上配置），受 asar 完整性校验保护，外部改包内文件应用拒绝启动，没有任何运行期覆盖入口（后台地址若可被用户改写，伪造一个本地后台就能架空授权联检）。
 *
 * 真实配置不入库（.gitignore 挡住 app.config.json），CI 打包时从仓库 Secrets 注入。
 */
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { getPaths } = require("./paths");

let cached = null;

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function readConfigFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`配置文件解析失败 ${file}: ${error.message}`);
  }
}

/** 按运行形态列出配置查找位置（顺序即优先级）。 */
function configCandidatePaths() {
  const { resourcesDir } = getPaths();
  if (app.isPackaged) {
    return [path.join(resourcesDir, "app.asar", "resources", "app.config.json")];
  }
  return [
    path.join(resourcesDir, "app.config.json"),
    path.join(resourcesDir, "app.config.example.json"),
  ];
}

/** 读不到配置时给出一行现场信息：实际探测了哪些路径、是否存在、运行环境是什么。 */
function configLookupHint() {
  const probed = configCandidatePaths()
    .map((file) => `${file}（${fs.existsSync(file) ? "存在" : "不存在"}）`)
    .join("；");
  return `已查找：${probed}；isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`;
}

/** 读取完整配置（含敏感字段），仅限主进程内部使用。 */
function getAppConfig() {
  if (!cached) {
    const candidates = configCandidatePaths();
    if (app.isPackaged) {
      cached = readConfigFile(candidates[0]) || {};
    } else {
      cached = readConfigFile(candidates[0]) || readConfigFile(candidates[1]) || {};
    }
  }
  return cached;
}

/** 渲染进程可见的配置视图：只给界面真正用到的块，敏感字段一律不出主进程。 */
function getPublicConfig() {
  const config = getAppConfig();
  return {
    ui: config.ui,
    channels: { docs: config.channels?.docs || {} },
    oauth: { authorizationOrigin: config.oauth.authorizationOrigin },
    models: config.models,
    subscription: config.subscription,
  };
}

module.exports = { getAppConfig, getPublicConfig, configLookupHint };

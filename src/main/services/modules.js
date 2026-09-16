/**
 * 运行时模块引导：把 openclaw 模块压缩包解压到本机缓存（仅首次），后续启动直接命中缓存，U 盘只保留压缩包。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { getPaths } = require("../paths");

/** 解压临时目录名前缀（后缀是进程号+时间戳），残留清理按它识别。 */
const STAGING_PREFIX = "_extracting-";
/** 正在进行的模块解压，用于并发单飞。 */
let extracting = null;

function log(message) {
  try {
    const { logsDir } = getPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, "modules-bootstrap.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch { /* 日志失败不阻塞引导 */ }
}

function moduleEntryPath() {
  return path.join(getPaths().modulesCacheDir, "openclaw", "openclaw.mjs");
}

function isReady() {
  const { modulesCacheDir } = getPaths();
  return fs.existsSync(path.join(modulesCacheDir, ".zgy-extract-ready")) && fs.existsSync(moduleEntryPath());
}

/**
 * 本机是否已经把 openclaw 组件跑起来过一次。
 * 刚解压出来的模块树第一次执行要付冷启动代价（实测约 1 分钟：Windows 首次读取扫描 + 冷文件缓存），标记与模块缓存同目录，模块重新解压时随 node_modules 一起消失，冷启动代价随之重来。
 */
function isRuntimeWarm() {
  return fs.existsSync(path.join(getPaths().modulesCacheDir, ".zgy-warm"));
}

/** 组件首次成功跑起来后落标记，之后的启动不再按"首次"提示。 */
function markRuntimeWarm() {
  try {
    fs.writeFileSync(path.join(getPaths().modulesCacheDir, ".zgy-warm"), `warmedAt=${new Date().toISOString()}\n`, "utf8");
  } catch { /* 标记写不进去只影响提示文案，不影响功能 */ }
}

/**
 * 删目录：Windows 上句柄释放有延迟，带重试再判失败。
 * 用异步删除，别用 rmSync——这里删的可能是几万文件的模块树（换模块包时要先清旧树），
 * 同步删会把主进程事件循环堵住，加载页也跟着不重绘。
 */
async function removeDir(target) {
  await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** 清掉历史解压残留（上次崩溃或另一个实例留下的）；删不掉说明还有人在写，跳过即可。 */
async function sweepStaleStaging(cacheParent) {
  let entries = [];
  try { entries = await fs.promises.readdir(cacheParent, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    try { await removeDir(path.join(cacheParent, entry.name)); } catch { /* 正被别人写，留给它自己清 */ }
  }
}

/**
 * 用系统 tar 解压模块包到缓存目录：先解到独立临时目录、再原子改名，中途失败不留半个缓存。
 * 就绪标记写在**暂存目录里**、跟着树一起改名落地：树和标记是同一个原子单位，
 * 因此不存在"树已经改名到位、标记却没写成"的中间态，也就不会下次把一棵完整的树白解压一遍。
 * 必须异步：首次解压耗时约 1 分钟，同步会卡死主进程事件循环——窗口的 ready-to-show 事件处理不了，表现为双击后迟迟不弹窗口。
 */
function extractArchive(archive, cacheParent) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(cacheParent, { recursive: true });
    // 残留暂存目录可能很大（上次解压到一半），删它同样不能让主进程卡住。
    sweepStaleStaging(cacheParent).catch(() => { /* 清理失败不阻塞本次解压 */ });
    // 临时目录带进程号与时间戳：既不撞残留目录，也不撞另一个实例正在写的目录。
    const staging = path.join(cacheParent, `${STAGING_PREFIX}${process.pid}-${Date.now().toString(36)}`);
    fs.mkdirSync(staging, { recursive: true });

    log(`extracting modules to ${cacheParent}`);
    const tarExecutable = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const child = spawn(tarExecutable, ["-xzf", archive, "-C", staging], { windowsHide: true });
    let stderrText = "";
    child.stderr.on("data", (chunk) => { stderrText += String(chunk); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error("模块解压失败: " + (stderrText || code)));
        return;
      }
      try {
        const extracted = path.join(staging, "node_modules");
        if (!fs.existsSync(extracted)) throw new Error("压缩包缺少 node_modules");
        fs.writeFileSync(path.join(extracted, ".zgy-extract-ready"), `extractedAt=${new Date().toISOString()}\narchive=${archive}\n`, "utf8");
        const finalDir = path.join(cacheParent, "node_modules");
        await removeDir(finalDir);
        try {
          fs.renameSync(extracted, finalDir);
        } catch (error) {
          // 改名失败时缓存目录里可能留着删了一半的旧树：尽力清掉，别让残缺的树被当成"就绪"用起来。
          try { await removeDir(finalDir); } catch { /* 清不掉就给下次启动重解压 */ }
          throw error;
        }
        try { await removeDir(staging); } catch { /* 临时目录清理失败无害 */ }
        log("extract complete");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * 确保模块缓存就绪并返回模块根目录；压缩包缺失时抛错。
 * 解压单飞：启动链与子进程启动可能同时要求就绪，两次 tar 解到同一个缓存目录会互删中间产物（实测报 ENOTEMPTY），并发调用一律等同一次解压。
 */
async function ensureModules() {
  const { payloadArchive, modulesCacheDir } = getPaths();
  if (isReady()) return modulesCacheDir;
  if (!fs.existsSync(payloadArchive)) {
    throw new Error(`缺少模块压缩包: ${payloadArchive}`);
  }
  if (!extracting) {
    extracting = extractArchive(payloadArchive, path.dirname(modulesCacheDir))
      .finally(() => { extracting = null; });
  }
  await extracting;
  if (!fs.existsSync(moduleEntryPath())) throw new Error("解压后未找到 openclaw.mjs");
  return modulesCacheDir;
}

/**
 * 子进程启动用的模块根目录（同步）。解压由启动链在加载页阶段完成并等待，到这里必然已就绪；未就绪时抛错而不是返回路径，避免把待解压的目录塞进子进程环境变量。
 */
function requireModulesDir() {
  if (!isReady()) throw new Error("运行时组件尚未准备好，请稍候重试");
  return getPaths().modulesCacheDir;
}


/**
 * 按需安装的 payload 包登记表：压缩包放 `resources/payload/`，解压到 target 目录。
 * 只给"不随模块包分发、要单独分发"的插件用；新增平台加一条即可。
 * 压缩包格式不限（tar / tar.gz / zip 都能用系统 tar 解），补齐 manifest 即视为已安装。
 */
const PAYLOADS = {
  qqbot: {
    archive: "qqbot-node_modules.zip",
    target: (p) => path.join(p.npmProjectsDir, "openclaw-qqbot-d3553f72f8"),
    manifest: "node_modules/@openclaw/qqbot/openclaw.plugin.json",
  },
  // 企业微信官方插件按 openclaw 官方安装布局分发（extensions 目录自动发现，无需登记加载路径）；
  // 包里刻意不含 node_modules/openclaw 链接（指向本机模块缓存、随机器变化），激活时代码重建。
  wecom: {
    archive: "wecom-plugin-extensions.zip",
    target: (p) => path.join(p.stateDir, "extensions", "wecom-openclaw-plugin"),
    manifest: "openclaw.plugin.json",
  },
};

/** payload 是否已就位（清单文件存在即认为装好了）。 */
function isPayloadReady(name) {
  const entry = PAYLOADS[name];
  if (!entry) return false;
  return fs.existsSync(path.join(entry.target(getPaths()), entry.manifest));
}

/** 跑一次系统 tar 解压（异步）：企业微信 payload 有几千个文件，同步跑会把主进程事件循环堵住。 */
function runTar(args) {
  return new Promise((resolve, reject) => {
    const tarExecutable = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
      : "tar";
    const child = spawn(tarExecutable, args, { windowsHide: true });
    let stderrText = "";
    child.stderr.on("data", (chunk) => { stderrText += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderrText || `exit ${code}`));
      else resolve();
    });
  });
}

/**
 * 确保某个 payload 已解压到目标目录，返回目标目录路径（失败返回空串）。
 * 解压到临时目录再整体拷贝，避免中途失败留下半个安装；已就位时直接返回。
 * 全程异步：payload 里有几千个文件、目标目录又常在 U 盘上（USB 随机写很慢），
 * 一旦同步执行，主进程会长时间无响应，界面上就是"点保存后卡死"。
 */
async function ensurePayload(name) {
  const entry = PAYLOADS[name];
  if (!entry) return "";
  const paths = getPaths();
  const target = entry.target(paths);
  if (isPayloadReady(name)) return target;

  const archive = path.join(paths.payloadDir, entry.archive);
  if (!fs.existsSync(archive)) {
    log(`payload ${name} missing archive: ${archive}`);
    return "";
  }

  const tmpDir = path.join(paths.payloadDir, `_payload-${name}-${process.pid}`);
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(tmpDir, { recursive: true });
  try {
    // -xf 对 tar / tar.gz / zip 都能自适应（Windows 的 bsdtar 支持 zip）。
    await runTar(["-xf", archive, "-C", tmpDir]);
    if (!fs.existsSync(path.join(tmpDir, entry.manifest))) throw new Error(`payload ${name} 压缩包内容不完整`);
    await fs.promises.mkdir(target, { recursive: true });
    await fs.promises.cp(tmpDir, target, { recursive: true, force: true });
    log(`payload ${name} installed to ${target}`);
  } catch (error) {
    log(`payload ${name} install failed: ${error.message}`);
    return "";
  } finally {
    try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无害 */ }
  }
  return isPayloadReady(name) ? target : "";
}

/** 查找已安装的 QQBot 插件工程目录列表。 */
function findQQBotPluginPaths() {
  const { npmProjectsDir } = getPaths();
  const found = [];
  if (!fs.existsSync(npmProjectsDir)) return found;
  for (const entry of fs.readdirSync(npmProjectsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("openclaw-qqbot")) continue;
    const pluginPath = path.join(npmProjectsDir, entry.name, "node_modules", "@openclaw", "qqbot");
    if (fs.existsSync(path.join(pluginPath, "openclaw.plugin.json"))) found.push(pluginPath);
  }
  return found;
}

/** QQBot 官方连接器入口（扫码绑定使用）。 */
function findQQBotConnectorEntry() {
  for (const project of findQQBotPluginPaths()) {
    const candidate = path.join(project, "node_modules", "@tencent-connect", "qqbot-connector", "dist", "esm", "index.js");
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** 资源目录内的插件路径（随安装包分发）。 */
function bundledPluginPath(name) {
  return path.join(getPaths().pluginsDir, name);
}

module.exports = {
  bundledPluginPath,
  ensureModules,
  ensurePayload,
  findQQBotConnectorEntry,
  findQQBotPluginPaths,
  isModulesReady: isReady,
  isPayloadReady,
  isRuntimeWarm,
  markRuntimeWarm,
  moduleEntryPath,
  requireModulesDir,
};

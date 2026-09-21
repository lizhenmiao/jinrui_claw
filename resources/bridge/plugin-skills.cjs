/** 便携技能发布适配：只替换 OpenClaw 的技能发布函数，以真实文件兼容 U 盘文件系统。 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { registerHooks } = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");

// 内容指纹随技能副本保存，模块更新或换机器后按实际内容决定是否重新复制。
const RECEIPT = ".zgy-skill.json";

/** 遍历可信技能源，只接收普通文件和目录，不把链接或设备文件复制到 U 盘。 */
function skillFiles(root, relative = "", files = []) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) skillFiles(root, name, files);
    else if (entry.isFile()) files.push(name);
    else throw new Error(`技能目录包含不支持的链接或特殊文件：${name}`);
  }
  return files;
}

/** 计算文件名与内容的指纹，避免仅凭源路径或时间戳错过更新。 */
function skillDigest(root, files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest());
  }
  return hash.digest("hex");
}

/** 读取生成副本的指纹；旧目录、损坏标记和目录链接均须重新生成。 */
function readReceipt(directory) {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(path.join(directory, RECEIPT), "utf8"));
  } catch { return null; }
}

/** 判断副本内容完整，损坏或丢文件时自动修复。 */
function isCurrentCopy(directory, digest) {
  if (readReceipt(directory)?.digest !== digest) return false;
  try {
    const files = skillFiles(directory).filter((file) => file !== RECEIPT);
    return skillDigest(directory, files) === digest;
  } catch { return false; }
}

/** 删除生成目录自身；遇到旧符号链接只解除链接，不触碰其源目录。 */
function removeGeneratedEntry(directory) {
  try {
    if (fs.lstatSync(directory).isSymbolicLink()) fs.unlinkSync(directory);
    else fs.rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

/** 暂存完整技能副本后发布；并发进程已发布同一内容时直接复用。 */
function publishCopy(root, name, source) {
  if (path.basename(name) !== name || name === "." || name === "..") throw new Error("技能名称不是合法目录名");
  const files = skillFiles(source);
  const digest = skillDigest(source, files);
  const destination = path.join(root, name);
  if (isCurrentCopy(destination, digest)) return;
  const staging = fs.mkdtempSync(path.join(root, ".zgy-skill-staging-"));
  try {
    for (const file of files) {
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(source, file), target);
    }
    fs.writeFileSync(path.join(staging, RECEIPT), JSON.stringify({ digest }) + "\n", "utf8");
    if (isCurrentCopy(destination, digest)) return;
    removeGeneratedEntry(destination);
    try { fs.renameSync(staging, destination); } catch (error) {
      if (!isCurrentCopy(destination, digest)) throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 使用 OpenClaw 原有筛选结果发布技能，保留其启用状态、名称冲突和路径安全检查。 */
function publishPluginSkills(skillDirs, root, collectSkillTargets) {
  const targets = new Map();
  for (const directory of skillDirs) collectSkillTargets(directory, targets);
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("技能发布根目录不能是符号链接");
  for (const [name, source] of targets) publishCopy(root, name, source);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (targets.has(entry.name) || entry.name.startsWith(".zgy-skill-staging-")) continue;
    const directory = path.join(root, entry.name);
    if (entry.isSymbolicLink() || readReceipt(directory)) removeGeneratedEntry(directory);
  }
}

/** 精确替换受支持的发布实现，上游结构变化时明确失败，避免悄悄退回目录链接。 */
function adaptPluginSkills(source) {
  const start = source.indexOf("function publishPluginSkills(skillDirs, opts) {");
  const end = source.indexOf("//#endregion", start);
  if (start < 0 || end < 0 || !source.slice(start, end).includes("fs.symlinkSync(target, linkPath, resolvePluginSkillLinkType())")) {
    throw new Error("OpenClaw 技能发布实现已变化，需要更新便携适配后再运行");
  }
  const helper = `import portableSkills from ${JSON.stringify(pathToFileURL(__filename).href)};\n`;
  const replacement = "function publishPluginSkills(skillDirs, opts) {\n return portableSkills.publishPluginSkills(skillDirs, opts?.pluginSkillsDir ?? resolveDefaultPluginSkillsDir(), collectSkillTargets);\n}\n";
  return helper + source.slice(0, start).replace(/function resolvePluginSkillLinkType\(platform = process\.platform\) \{[\s\S]*?\n\}\n/, "") + replacement + source.slice(end);
}

/** 仅适配当前模块缓存中技能发布模块的源码，不改磁盘缓存或其它文件系统操作。 */
function install() {
  const modulesRoot = process.env.OPENCLAW_MODULES_DIR;
  if (!modulesRoot) return;
  const dist = path.resolve(modulesRoot, "openclaw", "dist");
  const modules = fs.readdirSync(dist).filter((name) => /^plugin-skills-[\w-]+\.js$/.test(name));
  if (modules.length !== 1) throw new Error("无法唯一定位 OpenClaw 技能发布模块，需要更新便携适配");
  const skillModule = path.join(dist, modules[0]);
  // 子进程启动时就校验兼容性，不能等用户首次聊天才发现模块结构不支持。
  adaptPluginSkills(fs.readFileSync(skillModule, "utf8"));
  registerHooks({
    /** 在 OpenClaw 加载技能模块时注入便携发布实现。 */
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:")) return result;
      const filename = fileURLToPath(url);
      if (filename !== skillModule) return result;
      return { ...result, source: adaptPluginSkills(String(result.source)) };
    },
  });
}

module.exports = { publishPluginSkills, adaptPluginSkills };
install();

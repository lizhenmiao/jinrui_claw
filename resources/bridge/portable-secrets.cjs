/** FAT/exFAT 派生凭据原子写入：保持路径约束，不要求文件系统提供 POSIX 权限或稳定重命名 inode。 */
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// 每个目标文件串行写入，避免模型预热与令牌轮换同时覆盖文件。
const writes = new Map();
const PORTABLE_FILESYSTEMS = new Set(["exfat", "fat32", "fat", "msdos", "vfat"]);

/** 兼容仅限 U 盘 state 内的 agent 派生凭据，其余文件继续执行 OpenClaw 原有安全检查。 */
function supports(params) {
  if (!PORTABLE_FILESYSTEMS.has(String(process.env.ZGY_PORTABLE_FS || "").toLowerCase())) return false;
  const state = process.env.OPENCLAW_STATE_DIR;
  if (!state || typeof params.filePath !== "string") return false;
  const relative = path.relative(path.resolve(state), path.resolve(params.filePath)).split(path.sep).join("/");
  return /^agents\/[a-zA-Z0-9_-]+\/agent\/(?:models|auth-profiles|auth-state)\.json$/.test(relative);
}

/** 逐层拒绝符号链接和特殊文件，现有目标还须拒绝硬链接。 */
async function verifyPath(state, file) {
  let current = state;
  const root = await fs.lstat(current);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("凭据根目录必须是真实目录");
  const relative = path.relative(state, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("凭据路径超出 state 目录");
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("凭据路径不允许符号链接");
      if (index === parts.length - 1) {
        if (!stat.isFile() || stat.nlink > 1) throw new Error("凭据目标必须为无硬链接的普通文件");
      } else if (!stat.isDirectory()) throw new Error("凭据父路径不是目录");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (index < parts.length - 1) {
        try { await fs.mkdir(current, { mode: 0o700 }); } catch (creationError) {
          if (creationError.code !== "EEXIST") throw creationError;
          const created = await fs.lstat(current);
          if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("凭据父目录发生变化");
        }
      }
    }
  }
  const rootReal = await fs.realpath(state);
  const parentReal = await fs.realpath(path.dirname(file));
  const resolved = path.relative(rootReal, parentReal);
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("凭据真实路径超出 state 目录");
}

/** 写入排队后使用独占临时文件替换，失败保留原文件，内容不输出到日志。 */
function writeSecretFile(params) {
  if (!supports(params)) return Promise.reject(new Error("此凭据文件不适用便携写入"));
  const file = path.resolve(params.filePath);
  const run = async () => {
    const state = path.resolve(process.env.OPENCLAW_STATE_DIR);
    const rootRelative = path.relative(path.resolve(params.rootDir), file);
    if (!rootRelative || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) throw new Error("凭据路径超出调用方根目录");
    await verifyPath(state, file);
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${crypto.randomBytes(8).toString("hex")}.tmp`);
    try {
      await fs.writeFile(temporary, params.content, { flag: "wx", mode: 0o600 });
      await verifyPath(state, file);
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  };
  const operation = (writes.get(file) || Promise.resolve()).catch(() => {}).then(run);
  writes.set(file, operation);
  return operation.finally(() => { if (writes.get(file) === operation) writes.delete(file); });
}

module.exports = { supports, writeSecretFile };

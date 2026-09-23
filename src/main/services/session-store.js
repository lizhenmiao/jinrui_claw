/** 便携会话整理：启动网关前修正跨系统路径，并保留、归并因错误路径产生的历史片段。 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getPaths } = require("../paths");
const { writeJsonAtomic } = require("./secret-crypto");
const diagnostics = require("./diagnostics");

/** 只扫描真实目录，迁移过程不沿符号链接跨出 U 盘。 */
function directories(root) {
  try { return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(root, entry.name)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

/** 校验候选路径每一层均为 U 盘内的真实目录或普通文件，拒绝外部引用。 */
function assertLocalFile(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("会话路径超出 U 盘范围");
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`会话迁移拒绝符号链接：${current}`);
  }
  if (!fs.statSync(file).isFile()) throw new Error(`会话不是普通文件：${file}`);
}

/** 将会话原文按内容摘要备份，重复运行不会复制相同内容。 */
function backup(root, contents, extension) {
  const digest = crypto.createHash("sha256").update(contents).digest("hex");
  fs.mkdirSync(root, { recursive: true });
  const target = path.join(root, `${digest}.${extension}`);
  if (!fs.existsSync(target)) fs.writeFileSync(target, contents, { flag: "wx" });
  return digest;
}

/** 归并分散片段，按时间连接消息链；有相同 ID 的冲突记录时停止并保留原文件。 */
function mergeTranscripts(documents, sessionId) {
  const rows = new Map();
  let header = null;
  for (const document of documents) {
    for (const line of document.split(/\r?\n/).filter((item) => item.trim())) {
      const row = JSON.parse(line);
      if (row.type === "session") {
        if (row.id !== sessionId) throw new Error("会话头与索引中的会话 ID 不一致");
        if (!header || String(row.timestamp) < String(header.timestamp)) header = row;
        continue;
      }
      if (!row.id) throw new Error("会话记录缺少 ID，需人工核对，原文件已保留");
      const comparable = { ...row };
      delete comparable.parentId;
      const previous = rows.get(row.id);
      if (previous && JSON.stringify(previous.comparable) !== JSON.stringify(comparable)) throw new Error(`会话记录 ${row.id} 冲突，原文件已保留`);
      if (!previous) rows.set(row.id, { row, comparable });
    }
  }
  if (!header) throw new Error("会话缺少文件头，原文件已保留");
  const ordered = [...rows.values()].sort((a, b) => String(a.row.timestamp || "").localeCompare(String(b.row.timestamp || "")));
  let parentId = null;
  const output = [header];
  for (const { row } of ordered) {
    output.push({ ...row, parentId });
    parentId = row.id;
  }
  return output.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

/** 在网关停止期间整理索引；旧 Volumes 目录只读取，完整备份保存在当前 state 目录。 */
async function preparePortableSessions() {
  const { dataDir, stateDir } = getPaths();
  const volumeRoot = path.dirname(dataDir);
  const agentsRoot = path.join(stateDir, "agents");
  const backupRoot = path.join(stateDir, "session-migration-backups");
  const manifestFile = path.join(backupRoot, "migrated.json");
  // 备份与清单目录也必须受同一 U 盘边界约束。
  if (fs.existsSync(backupRoot) && fs.lstatSync(backupRoot).isSymbolicLink()) throw new Error("会话备份目录不能是符号链接");
  if (fs.existsSync(manifestFile)) assertLocalFile(volumeRoot, manifestFile);
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const legacyRoots = directories(path.join(volumeRoot, "Volumes")).map((mount) => path.join(mount, path.basename(dataDir), ".openclaw", "agents"));
  for (const agent of directories(agentsRoot)) {
    const sessions = path.join(agent, "sessions");
    const indexFile = path.join(sessions, "sessions.json");
    if (!fs.existsSync(indexFile)) continue;
    assertLocalFile(volumeRoot, indexFile);
    const rawIndex = fs.readFileSync(indexFile, "utf8");
    const index = JSON.parse(rawIndex);
    let changed = false;
    for (const entry of Object.values(index)) {
      const id = entry?.sessionId;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) continue;
      const target = path.join(sessions, `${id}.jsonl`);
      const key = `${path.basename(agent)}/${id}`;
      const consumed = new Set(manifest[key] || []);
      const documents = [];
      const imported = [];
      const roots = [sessions, ...legacyRoots.map((root) => path.join(root, path.basename(agent), "sessions"))];
      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        for (const name of fs.readdirSync(root)) {
          if (!name.endsWith(`${id}.jsonl`)) continue;
          const candidate = path.join(root, name);
          assertLocalFile(volumeRoot, candidate);
          const text = fs.readFileSync(candidate, "utf8");
          const digest = crypto.createHash("sha256").update(text).digest("hex");
          if (candidate !== target && consumed.has(digest)) continue;
          if (candidate === target) documents.unshift(text);
          else { documents.push(text); imported.push({ candidate, digest, text }); }
        }
      }
      if (imported.length) {
        backup(backupRoot, rawIndex, "index.json");
        for (const document of documents) backup(backupRoot, document, "jsonl");
        const merged = mergeTranscripts(documents, id);
        const temporary = `${target}.tmp-${process.pid}`;
        fs.writeFileSync(temporary, merged, { flag: "wx" });
        fs.renameSync(temporary, target);
        manifest[key] = [...consumed, ...imported.map((item) => item.digest)];
        writeJsonAtomic(manifestFile, manifest);
        diagnostics.record("session-history-migrated", { sessionId: id, target, sources: imported.map((item) => item.candidate), backupRoot });
      }
      if (entry.sessionFile !== target) { entry.sessionFile = target; changed = true; }
      const pointerFile = path.join(sessions, `${id}.trajectory-path.json`);
      if (fs.existsSync(pointerFile)) {
        assertLocalFile(volumeRoot, pointerFile);
        const rawPointer = fs.readFileSync(pointerFile, "utf8");
        const pointer = JSON.parse(rawPointer);
        const runtimeFile = path.join(sessions, `${id}.trajectory.jsonl`);
        if (pointer.runtimeFile !== runtimeFile) {
          backup(backupRoot, rawPointer, "pointer.json");
          writeJsonAtomic(pointerFile, { ...pointer, runtimeFile });
        }
      }
    }
    if (changed) { backup(backupRoot, rawIndex, "index.json"); writeJsonAtomic(indexFile, index); }
  }
}

module.exports = { preparePortableSessions };

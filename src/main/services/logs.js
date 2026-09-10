/**
 * 日志中心：进程日志的读取与 UI 展示净化。
 * 日志文件全部位于 U 盘 data/.openclaw/logs。
 */
const fs = require("fs");
const path = require("path");
const { getPaths } = require("../paths");

/** 展示净化：压缩空白、剔除二维码链接与块字符画，截断超长行。 */
function sanitizeUiLogLine(message) {
  const text = String(message || "")
    .replace(/\\r\\n|\\n|\\r/g, " ")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (/liteapp\.weixin\.qq\.com|qrcode=|qrlogin|二维码链接/i.test(text)) return "";
  const blockCount = (text.match(/[\u2580-\u259f]/g) || []).length;
  if (blockCount >= 8) return "";
  if (/^(stdout|stderr):\s*$/i.test(text)) return "";
  return text.slice(0, 600);
}

function sanitizeLogsForUi(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map(sanitizeUiLogLine)
    .filter(Boolean)
    .slice(-120)
    .join("\n");
}

/** 读取最近的运行日志（排除微信登录日志，其由通道流程单独消费）。 */
function readRecentLogs() {
  try {
    const { logsDir } = getPaths();
    if (!fs.existsSync(logsDir)) return "暂无日志";
    const files = fs.readdirSync(logsDir)
      .filter((name) => name.endsWith(".log") && name !== "wechat-login.log")
      .map((name) => {
        const file = path.join(logsDir, name);
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch { /* 文件可能刚被删除 */ }
        return { name, file, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return "暂无日志";
    return sanitizeLogsForUi(fs.readFileSync(files[0].file, "utf8"));
  } catch (error) {
    return `读取日志失败: ${error.message}`;
  }
}

/** 追加微信登录日志（净化后落盘，供二维码流程诊断）。 */
function appendWechatLoginLog(message) {
  try {
    const { logsDir } = getPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    const clean = sanitizeUiLogLine(message);
    if (!clean) return;
    fs.appendFileSync(path.join(logsDir, "wechat-login.log"), `[${new Date().toISOString()}] ${clean}\n`, "utf8");
  } catch { /* 日志失败不影响登录流程 */ }
}

module.exports = { appendWechatLoginLog, readRecentLogs };

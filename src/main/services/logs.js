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
    // 去掉终端颜色转义序列；部分日志丢失 ESC 前缀，残留的 [90m 形态一并清理。
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\[\d{1,2}m/g, "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // 不能把字面的 \r、\n 两字符替换成空格：Windows 路径里的 \resources、\node_modules会被吃掉首字母，日志里就变成 " esources" 这种残缺路径。
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

/** 取单个日志文件的末尾若干行（文件不存在或为空返回空数组）。 */
function readLogTail(file, maxLines) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).slice(-maxLines).filter((line) => line.trim());
  } catch {
    return [];
  }
}

/** 解析行首时间戳（ISO 形态，可能带终端颜色前缀）；解析不出返回 null。 */
function logLineTime(line) {
  const match = line.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+-]\d{2}:\d{2})?)/);
  if (!match) return null;
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}

/**
 * 读取最近的运行日志（排除微信登录日志，其由通道流程单独消费）。
 * 固定合并网关主日志与错误日志并按时间戳排序：错误日志（如插件抛错）与主日志一起展示，也不再"哪个文件刚被写入就整个切过去"，避免界面内容来回跳变。
 */
function readRecentLogs() {
  try {
    const { logsDir } = getPaths();
    if (!fs.existsSync(logsDir)) return "暂无日志";
    const lines = [
      ...readLogTail(path.join(logsDir, "gateway.log"), 240),
      ...readLogTail(path.join(logsDir, "gateway.err.log"), 80),
    ];
    if (!lines.length) return "暂无日志";
    const stamped = lines.map((line) => ({ line, time: logLineTime(line) }));
    stamped.sort((a, b) => (a.time ?? Number.MAX_SAFE_INTEGER) - (b.time ?? Number.MAX_SAFE_INTEGER));
    return sanitizeLogsForUi(stamped.map((entry) => entry.line).join("\n"));
  } catch (error) {
    return `读取日志失败: ${error.message}`;
  }
}

/** 追加原始内容到指定日志文件（时间戳与换行由调用方给出）。日志失败不影响业务。 */
function appendRawLog(name, text) {
  try {
    const { logsDir } = getPaths();
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, name), text, "utf8");
  } catch { /* 日志失败不影响主流程 */ }
}

/** 追加一条带时间戳的日志行。 */
function appendLogLine(name, message) {
  appendRawLog(name, `[${new Date().toISOString()}] ${message}\n`);
}

/** 追加微信登录日志（净化后落盘，供二维码流程诊断）。 */
function appendWechatLoginLog(message) {
  const clean = sanitizeUiLogLine(message);
  if (clean) appendLogLine("wechat-login.log", clean);
}

module.exports = { appendLogLine, appendRawLog, appendWechatLoginLog, readRecentLogs };

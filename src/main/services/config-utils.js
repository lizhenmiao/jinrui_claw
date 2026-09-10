/**
 * 配置文件小工具：BOM 剥离与容错 JSON 读取。
 */
const fs = require("fs");

function stripBom(text) {
  return typeof text === "string" && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 读取 JSON 文件，缺失或损坏时返回 fallback。 */
function readJsonFile(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  } catch {
    return fallback;
  }
}

module.exports = { readJsonFile, stripBom };

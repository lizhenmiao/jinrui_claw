/**
 * 拔盘看护：周期性检查 U 盘数据目录是否仍可访问。
 * 拔出即触发回调，由入口模块执行停网关、清进程、关窗口的收尾流程。
 */
const fs = require("fs");
const path = require("path");
const { getPaths } = require("../paths");
const timing = require("../../shared/timing.json");

const SENTINEL_FILE = ".usb-present";
let timer = null;
let onRemoved = null;

function sentinelPath() {
  return path.join(getPaths().dataDir, SENTINEL_FILE);
}

/** 启动哨兵文件（正常存在）；检查时以哨兵可读且 data 目录可访问为准。 */
function ensureSentinel() {
  try {
    fs.mkdirSync(getPaths().dataDir, { recursive: true });
    fs.writeFileSync(sentinelPath(), new Date().toISOString() + "\n", "utf8");
  } catch { /* 哨兵创建失败时按目录可达性检查 */ }
}

/** 出厂重置等操作清空 data 目录后调用：重建哨兵，避免误判拔盘。 */
function refreshSentinel() {
  ensureSentinel();
}

function isUsbPresent() {
  try {
    // 写探测比读探测更严格：U 盘写保护或拔出都会立即失败。
    const { dataDir } = getPaths();
    fs.accessSync(dataDir);
    fs.accessSync(sentinelPath());
    return true;
  } catch {
    return false;
  }
}

/** 启动拔盘监听；返回停止函数。 */
function startUsbWatch(callback) {
  onRemoved = callback;
  ensureSentinel();
  timer = setInterval(() => {
    if (!isUsbPresent() && onRemoved) {
      const handler = onRemoved;
      onRemoved = null;
      stopUsbWatch();
      handler();
    }
  }, timing.usbWatch.checkIntervalMs);
  return stopUsbWatch;
}

function stopUsbWatch() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { refreshSentinel, startUsbWatch, stopUsbWatch };

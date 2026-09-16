/**
 * 看护进程：监控主进程与业务子进程。
 * 主进程消失（正常退出、崩溃或被强杀）时终止全部登记的子进程树，保证 U 盘句柄全部释放。
 * 用法：node process-warden.cjs <childPidsFile> <ownerPid>
 */
const fs = require("fs");
const { execFileSync } = require("child_process");

const childPidsFile = process.argv[2] || "";
const ownerPid = Number(process.argv[3] || 0);

function ownerAlive() {
  if (!ownerPid) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPids() {
  try {
    const parsed = JSON.parse(fs.readFileSync(childPidsFile, "utf8"));
    return Array.isArray(parsed.pids) ? parsed.pids.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

function stopTree(pid) {
  if (!pid || pid === process.pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 8000 });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
  } catch { /* 进程可能已退出 */ }
}

function cleanup() {
  for (const pid of readPids()) stopTree(pid);
  try { fs.rmSync(childPidsFile, { force: true }); } catch { /* 登记文件可能不存在 */ }
  process.exit(0);
}

process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);

// 常驻轮询：主进程消失即清杀子进程。间隔由主进程通过 WARDEN_CHECK_INTERVAL_MS 下发（取值来自 src/shared/timing.json），未下发时退回默认值。
setInterval(() => {
  if (!ownerAlive()) cleanup();
}, Number(process.env.WARDEN_CHECK_INTERVAL_MS) || 1500);

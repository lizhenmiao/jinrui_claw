/**
 * 开发启动器：并行拉起 Vite 开发服务器与 Electron 主进程，
 * 主进程通过 VITE_DEV_SERVER_URL 加载渲染页面；Ctrl+C 一并退出。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import process from "node:process";

const DEV_SERVER_URL = "http://127.0.0.1:5183";
const children = [];

function waitForServer(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const probe = () => {
      http.get(url, (response) => {
        response.resume();
        resolve();
      }).on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error("Vite 开发服务器启动超时"));
          return;
        }
        setTimeout(probe, 400);
      });
    };
    probe();
  });
}

function spawnChild(command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
  children.push(child);
  return child;
}

try {
  spawnChild(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:renderer"], {});
  spawnChild("node", ["node_modules/vite/bin/vite.js"], { VITE_DEV_SERVER_URL: DEV_SERVER_URL });
  await waitForServer(DEV_SERVER_URL);
  spawnChild(process.execPath, ["node_modules/electron/dist/electron.exe", "."], { VITE_DEV_SERVER_URL: DEV_SERVER_URL });
} catch (error) {
  console.error(`[dev] ${error.message}`);
} finally {
  const shutdown = () => {
    for (const child of children) child.kill();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

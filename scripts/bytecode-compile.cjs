/**
 * 主进程脚本字节码编译（在 Electron 的 Node 环境中运行，保证 V8 版本一致）：
 * 把 src/main 下的 .js 编译为 .jsc，并让 bytenode 把加载器存根原地写回原 .js 路径，
 * 使安装包内不再存在明文业务源码。由 scripts/dist.mjs 在备份/还原流程中调用。
 * 注意：preload 不编译——渲染进程在启用 asar 完整性校验的安装包内加载字节码
 * 会触发 0xC0000005 崩溃，preload 仅含 contextBridge 接线、无敏感逻辑，保持源码。
 */
const fs = require("fs");
const path = require("path");
const bytenode = require("bytenode");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const TARGET_DIRS = ["src/main"];

/** 递归编译目录内全部 .js：生成同名 .jsc 并由 bytenode 写回加载器存根。 */
async function compileDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += await compileDir(fullPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    await bytenode.compileFile({
      filename: fullPath,
      output: `${fullPath}c`,
      createLoader: "commonjs",
      loaderFilename: "%.js",
    });
    count += 1;
  }
  return count;
}

(async () => {
  let compiled = 0;
  for (const dir of TARGET_DIRS) {
    const absolute = path.join(PROJECT_ROOT, dir);
    if (!fs.existsSync(absolute)) throw new Error(`待编译目录不存在: ${absolute}`);
    compiled += await compileDir(absolute);
  }
  console.log(`[bytecode] compiled ${compiled} files to V8 bytecode`);
})().catch((error) => {
  console.error(`[bytecode] ${error.stack || error.message}`);
  process.exit(1);
});

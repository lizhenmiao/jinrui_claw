import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rendererRoot = path.resolve("src/renderer");
const isDevServer = Boolean(process.env.VITE_DEV_SERVER_URL);

/** 生产构建注入 CSP 声明（开发服务器需要 HMR 内联脚本，不注入）。 */
const cspMetaPlugin = {
  name: "csp-meta",
  apply: "build",
  transformIndexHtml(html) {
    return html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'">`,
    );
  },
};

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react(), cspMetaPlugin],
  build: {
    outDir: path.resolve("out/renderer"),
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
    // 开发服务器只服务本机渲染页面，Electron 主进程通过环境变量加载它。
    host: "127.0.0.1",
  },
  define: {
    __DEV_SERVER__: JSON.stringify(isDevServer),
  },
});

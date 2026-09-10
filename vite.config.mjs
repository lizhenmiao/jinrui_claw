import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const rendererRoot = path.resolve("src/renderer");
const isDevServer = Boolean(process.env.VITE_DEV_SERVER_URL);

export default defineConfig({
  root: rendererRoot,
  base: "./",
  plugins: [react()],
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

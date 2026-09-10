# 小龙虾 U 盘版（ZgyClaw Desktop）

便携式 AI 助手桌面客户端：单个可执行文件，双击即用，无需安装；
用户数据全部写在可执行文件同目录的 `data/`，随 U 盘插拔迁移。

## 环境要求

- Node.js 18+（开发机当前使用 22）
- Windows（开发与打包 Windows 版）/ macOS（打包 dmg 需在 macOS 上执行）

## 快速开始（开发）

```bash
npm install     # 首次安装依赖（已配置 Electron 镜像源）
npm run dev     # 启动开发环境
```

`npm run dev` 会同时拉起：

- Vite 开发服务器（`http://127.0.0.1:5183`），渲染层 React 代码热更新；
- Electron 主进程窗口，加载开发服务器页面并自动打开 DevTools。

说明：

- 修改渲染层（`src/renderer/`）保存即生效；修改主进程（`src/main/`）需要重启 `npm run dev`；
- 开发模式下产品根目录是工程根目录，运行后会生成 `data/`（配置、日志、凭证，已 gitignore）；
- 未打包状态免授权校验，向导可直接走通；
- 首次启动会把 `resources/payload/openclaw-modules.tar.gz` 解压到本机缓存
  （Windows 在 `%LOCALAPPDATA%\ZgyClaw\cache\`），需要等待几十秒，之后启动直接命中缓存。

## 生产模式预览（不接开发服务器）

```bash
npm run build:renderer
npx electron .
```

## 打包交付

```bash
npm run dist:win     # Windows x64 单文件 portable exe → release/小龙虾U盘版.exe
npm run dist:mac     # macOS arm64 dmg → release/（需在 macOS 上执行）
```

Windows portable exe 每次启动自解压到系统临时目录运行，数据不受影响（始终写在 exe 同目录）。

## 授权绑定

打包发行的副本强制校验 U 盘指纹（开发模式免校验），母本 U 盘与客户 U 盘统一绑定：

```bash
小龙虾U盘版.exe --bind-usb        # 为当前 U 盘生成授权文件 license.dat
小龙虾U盘版.exe --check-license   # 校验当前授权
```

- 授权文件与 U 盘卷序列号指纹绑定，复制到其他 U 盘无法通过校验；
- 客户端内另有后台授权联检（`app.config.json` 的 `backend` 段，`reportOnly` 模式不拦截）。

## 主题调色

页面颜色全部走设计令牌：`src/renderer/src/styles/global.css` 的 `:root` 变量定义，
`tailwind.config.js` 映射为 Tailwind 语义类（`text-ink`、`bg-tint`、`border-hot` 等）。
调整主题只需要改 `:root` 里的变量值，一处生效全站。

## 运营配置

- 内置默认配置：`resources/app.config.json`（OAuth 后台地址、clientId、模型预设、订阅套餐、端口等）；
- U 盘根目录放同名 `app.config.json` 可覆盖默认值，无需重新打包；
- `clientSecret` 等敏感字段不会下发给渲染进程。

## 架构

```
src/main          Electron 主进程：启动链、IPC、全部业务服务
  ├─ services/    配置存取、加解密、授权、后台同步、网关进程、通道、更新、拔盘看护
  └─ index.js     启动编排与生命周期
src/preload       contextBridge 桥接：window.zgy.*（渲染进程唯一入口）
src/renderer      React + TailwindCSS 配置向导与运行页（Vite 构建）
resources/        随包分发的资源：app.config.json、payload 模块压缩包、插件、bridge 脚本
```

关键设计：

- **纯 IPC**：渲染进程与主进程通过类型化 IPC 通信，无本地常驻 HTTP 服务；
  仅 OAuth 登录期间临时监听 127.0.0.1 回调端口；
- **无内置 Node**：网关等子进程使用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）；
- **进程看护**：所有子进程登记到独立看护进程（`resources/bridge/process-warden.cjs`），
  主进程退出或被强杀时整树清杀；拔盘 watchdog 周期探测数据目录，移除即停网关并退出；
- **原子写**：配置落盘一律"临时文件 + rename"，防止拔盘留下半个文件。

## 交付形态

```
U 盘根目录
├── 小龙虾U盘版.exe      # 唯一交付文件（macOS 为 小龙虾macOS版.app）
├── license.dat          # --bind-usb 生成，与该 U 盘绑定
└── data/                # 首次运行自动生成：配置、日志、凭证、会话
```

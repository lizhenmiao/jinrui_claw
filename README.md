# 小龙虾 U 盘版（ZgyClaw Desktop）

便携式 AI 助手桌面客户端：单个可执行文件，双击即用，无需安装；
用户数据全部写在可执行文件同目录的 `data/`，随 U 盘插拔迁移。

## 架构

```
src/main          Electron 主进程：启动链、IPC、全部业务服务（原 config-server 的职责）
  ├─ services/    配置存取、加解密、授权、后台同步、网关进程、通道、更新、拔盘看护
  └─ index.js     启动编排与生命周期
src/preload       contextBridge 桥接：window.zgy.*（渲染进程唯一入口）
src/renderer      React + TailwindCSS 配置向导与运行页（Vite 构建）
resources/        随包分发的资源：app.config.json（运营配置）、payload 模块压缩包、插件、bridge 脚本
```

关键设计：

- **纯 IPC**：渲染进程与主进程通过类型化 IPC 通信，无本地 HTTP 配置服务；
  仅 OAuth 登录期间临时监听 127.0.0.1 回调端口。
- **无内置 Node**：网关等子进程使用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）。
- **进程看护**：所有子进程登记到独立看护进程（`resources/bridge/process-warden.cjs`），
  主进程退出或被强杀时整树清杀；拔盘 watchdog 周期探测数据目录，移除即停网关并退出。
- **原子写**：配置落盘一律"临时文件 + rename"，防止拔盘留下半个文件。
- **配置外置**：运营参数（OAuth、后台地址、模型预设、订阅套餐）在 `resources/app.config.json`，
  U 盘根目录放同名 `app.config.json` 可覆盖，无需重新打包。

## 开发

```bash
npm install
npm run dev          # Vite 开发服务器 + Electron
```

开发模式下产品根目录为工程根目录，运行后会在本目录生成 `data/`（已 gitignore）。

## 打包

```bash
npm run dist:win     # Windows x64 单文件 portable exe → release/
npm run dist:mac     # macOS arm64 dmg（需在 macOS 上执行）
```

## 授权工具（替代旧 Bind-USB.bat / Check-License.bat）

```bash
小龙虾U盘版.exe --bind-usb        # 为当前 U 盘生成授权文件
小龙虾U盘版.exe --check-license   # 校验当前授权
```

母本目录存在 `master-mode.flag` 时跳过授权校验；正式发售放 `license-required.flag`。

## 交付形态

```
U 盘根目录
├── 小龙虾U盘版.exe      # 唯一交付文件（macOS 为 小龙虾macOS版.app）
└── data/                # 首次运行自动生成：配置、日志、凭证、会话
```

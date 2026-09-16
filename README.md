# 小龙虾 U 盘版（ZgyClaw Desktop）

便携式 AI 助手桌面客户端：程序文件夹拷到 U 盘，双击即用、无需安装；
用户数据全部写在可执行文件同级的 `data/`，随 U 盘插拔迁移。

技术栈：Electron 44（主进程内聚全部业务）+ React 18 + TailwindCSS（Vite 构建）+ openclaw 网关。
聊天通道支持微信、QQ、企业微信、飞书 / Lark、钉钉。

---

## 1. 环境要求

| 组件 | 要求 | 用途 |
| --- | --- | --- |
| Node.js | 18+（开发机 22） | 开发与打包 |
| Windows 10/11 x64 | —— | 开发、打包 Windows 目录版 |
| macOS | —— | 打包 dmg（必须在 macOS 上执行） |

Electron 44 不再发布 32 位 Windows 包，原生二进制只有 x64 / arm64，即**不支持 32 位 Windows**。

---

## 2. 本地开发

```bash
npm install     # 首次安装依赖（已配置 Electron 镜像源）
npm run dev     # Vite 开发服务器(127.0.0.1:5183) + Electron 窗口，自动开 DevTools
```

首次在本机跑之前要绑定一次授权码（授权码随盘走，开发环境也一样，见第 6 章）：

```bash
npx electron . --bind-usb --license XLX-DEMO-0001   # 用管理后台里任意一条可用授权码
```

绑定文件落在 `data/license.json`（已 gitignore），恢复出厂设置会保留它，所以只做一次。
不绑定就启动会停在加载页并提示该命令。

生产模式预览（不接开发服务器，等价于打包后的加载方式）：

```bash
npm run build:renderer && npx electron .
```

要点：

- 改渲染层（`src/renderer/`）保存即生效；改主进程（`src/main/`）需重启 `npm run dev`；
- 开发模式下产品根目录就是工程根目录，运行期文件写在工程根的 `data/`（已 gitignore）；
- **未打包状态免本地授权校验**（U 盘指纹那一层），但连后台仍需要本盘绑定的授权码；
- **首次启动较慢、之后很快**：加载页会依次说明在做什么（正在解压运行组件 → 正在校验授权 → 正在连接管理后台 → 正在加载微信组件），
  在本机第一次跑合计约一分钟（解压约 18 秒 + 组件首次启动约 50 秒）；
  这一段只出现在启动加载页，进向导后到 BOT 页直接有二维码，不会有第二次等待；
  解压缓存按模块包本身（大小 + 修改时间）认键，所以换盘符、换 USB 口、改文件夹名都不会重解压；
- **窗口先行**：加载页在启动一开始就可见，模块解压 / 授权校验都在后台跑，不会黑等；
  启动未通过（例如未绑定授权码）不切错误页，加载页停住显示原因并可重试。

---

## 3. 运营配置（app.config.json）

后台地址、OAuth 客户端、模型预设、通道文档链接等运营参数都在这份配置里。
**真实配置不入库**，两个文件分工如下：

- `resources/app.config.example.json`（入库）：模板 + 本地开发默认值（后台 `127.0.0.1:15000`、授权平台 `localhost:8080`）；本机没有真实配置时自动回落到它。
- `resources/app.config.json`（不入库）：真实配置，本机开发填联调地址；
  CI 打包时从仓库 Secret `APP_CONFIG_JSON` 写出。

打包后这份配置进 asar、受完整性校验保护，**交付包没有任何运行期覆盖入口**——
后台地址若能被改，用户指向自己的假后台就架空了授权。
`npm run dist:*` 打包前校验四项：配置存在、`oauth.clientId` 非占位符、无 `oauth.clientSecret`、
`backend.url` 非空，任一不满足立即终止；地址仍是本地回环时警告“只能自测、不可交付”。

关键字段：

```jsonc
{
  "backend": {
    "url": "http://127.0.0.1:15000"    // 管理后台；必填，客户端启动时要联检
  },
  "oauth": {
    "issuer": "http://localhost:8080",            // 授权平台（外部平台，自行维护）
    "authorizationOrigin": "http://localhost:8080",
    "clientId": "jr_client_xxxxxxxx",             // 公共客户端 ID（公开信息）
    "clientType": "public",                       // 桌面端一律 public：只用 PKCE，无 client_secret
    "redirectUri": "http://127.0.0.1:18790/api/auth/callback",   // 端口即本地回调监听端口
    "scopes": "openid profile subscription:read models:read inference"
  },
  "ports": { "gateway": 18789 },
  "ui": { "toastPosition": "top-right" }
}
```

配置里**没有授权码**：它随 U 盘走，由售后在绑定时写入（`--bind-usb --license`，见第 6 章）。
所以一个安装包可以发给不同客户，不用按客户重新打包。`backend.url` 与授权码缺任何一项，
客户端都会停在加载页明确报错而不是静默跳过——否则模型下发、设备记录、更新检查不工作还没人发现。
本地回调监听端口**只有一个来源**：`oauth.redirectUri` 里的端口（须与授权平台的白名单一致）。
`ui.toastPosition` 可选 `top-right`（默认）/ `top-center` / `bottom-center` / `bottom-right`。
不单设端口配置项，免得两处配置各自跑偏。

### 授权平台侧要求

客户端只通过 `oauth` 段与授权平台对话，需要对方满足三件事：

1. `clientId` 注册为 **`public`（公共客户端）**，启用 **PKCE（S256）**。桌面端藏不住密钥（字节码只保护逻辑、字符串常量仍可提取），因此不使用 `client_secret`：授权码被截获也换不出令牌，因为没有本地内存里的 `code_verifier`；
2. 回调白名单包含 `http://127.0.0.1:18790/api/auth/callback`（客户端登录期间临时监听 18790 收 code，登录结束立即停止监听）；
3. 提供套餐入口 `/api/token-plan/v1/*`（取模型 + 聊天消费）与资源接口 `/oauth/api/v1/*`；
  资源接口用于取身份、订阅与模型展示信息。

`oauth.scopes` 会写进授权 URL，客户端**只需要这五个**（多申请的 scope 会在同意页多要一份权限）：

| scope | 客户端用它做什么 |
| --- | --- |
| `openid` | 换 id_token / 调 `/oauth/userinfo` 拿身份（`sub` 作账号绑定键） |
| `profile` | 昵称头像（登录成功页与向导里显示"欢迎，XXX"） |
| `subscription:read` | 查 Coding Plan 是否生效 |
| `models:read` | 取模型展示信息（名称、上下文长度等） |
| `inference` | 套餐入口取可用模型列表 + 聊天消费（核心） |

登录与套餐只影响“用平台算力”这条路；走手动配置模型（自己填 Base URL + Key）时 `oauth` 填错也能用。

---

## 4. 本地联调

管理后台是另一个仓库（`E:\github_data\xlx-admin-run`，Spring Boot + MySQL 8），管授权码、设备记录、
版本更新、内置模型下发、事件日志：

```bash
cd /e/github_data/xlx-admin-run
mvn spring-boot:run      # 看到 Tomcat started on port 15000 即成功
```

后台页面 `http://127.0.0.1:15000/admin/index.html`，账号 `jinrui`，
密码取后台的环境变量 `XLX_ADMIN_PASSWORD`（默认值见后台仓库配置，生产环境必须改掉）。
数据库固定 `xlx_admin`，连接串带 `createDatabaseIfNotExist=true` + Flyway 自动建表，不用手工建库。
首次启动写入演示数据：授权码 `XLX-DEMO-0001`、版本号、内置模型各一条。

> Java / Maven 对中文路径敏感，后台项目必须放在纯英文路径下。

客户端调用的后台接口（供核对）：

| 接口 | 作用 |
| --- | --- |
| `POST /api/client/license/check` | 授权校验 + 首次绑定 U 盘 |
| `POST /api/client/device/ping` | 设备心跳（启动打一次，之后每 5 分钟） |
| `POST /api/client/update/check` | 更新检查 |
| `POST /api/client/models/config` | 内置模型下发 |
| `POST /api/client/event` | 事件上报（启动失败、通道离线、模型认证失败等） |

从零到能聊天的顺序：

1. 起 MySQL 与管理后台，登录后台确认能看到演示授权码；
2. `resources/app.config.json` 的 `backend.url` 指向后台、`oauth.*` 指向授权平台；
3. `npm run dev` → 向导首页登录平台账号（浏览器点同意，客户端 18790 收回调）；
4. 有套餐 → 进模型页选模型；没套餐 → 套餐页买完自动进模型页；也可跳过登录走“手动配置”填自己的 Key；
5. 保存 → BOT 页选通道（微信 / QQ / 企业微信 / 飞书 / 钉钉）→ 扫码或填凭据；
6. 运行页启动网关（18789）→ 聊天页面自动打开；
7. 后台"设备记录"能看到这台机器，"事件日志"能看到运行期上报。

---

## 5. 打包

```bash
npm run dist:win     # → release/zgyclaw-windows-amd64.zip（x64 目录形态，解压得 zgyclaw 文件夹）
npm run dist:mac     # → release/zgyclaw-mac-{arm64,x64}.dmg（须在 macOS 上执行）
```

Windows 用**目录分发**而不是单文件 portable：双击 1~2 秒出窗口，没有单文件每次自解压十几秒的等待；
首次运行的模块解压（约 1 分钟）由应用内加载页承接。数据始终写在 exe 同级的 `data/`，跟着 U 盘走。

流水线（`scripts/dist.mjs`）：vite 构建渲染层 → 备份主进程源码 → 用 Electron 的 V8 编译 `src/main` →
electron-builder（Windows 构建后把 `win-unpacked` 更名 `zgyclaw` 压成交付 zip）→ 无论成败恢复源码
（工作区始终是明文源码状态）。

**主进程源码保护**：`src/main` 下全部 .js 打包时经 bytenode 编译为 `.jsc`，包内只留两行加载器存根，
注释与函数体不可直接阅读；preload 仅含 contextBridge 接线、无敏感逻辑，故保持源码
（渲染进程在启用 asar 完整性校验的包内加载字节码会崩溃）。
边界要清楚：字节码保护逻辑与注释，**字符串常量仍可提取**，强防护依赖后台授权联检。

### GitHub Actions 自动打包

`.github/workflows/build.yml`：**手动触发**（Actions → 打包客户端 → Run workflow）或**推 `v*` 标签**
自动构建。
`windows-latest` 出 `zgyclaw-windows-amd64.zip`，`macos-latest` 出 `zgyclaw-mac-{arm64,x64}.dmg`；
产物在该次运行的 Artifacts 里，**推标签的构建还会自动发到同一个标签的 Release**，正式分发走这条路。

前置条件：仓库 Secret **`APP_CONFIG_JSON`** 必须存在（内容是整份线上 `app.config.json`），
缺失时 workflow 直接失败，不会打出废包。私有仓库 Actions 按 Windows 2 倍、macOS 10 倍计费。

---

## 6. U 盘交付与授权

### 交付形态

```
U 盘根目录
└── zgyclaw/                 # 程序文件夹（zip 解压即得：zgyclaw.exe + resources + 运行库）
    ├── zgyclaw.exe          # 双击启动（macOS 为 小龙虾U盘版.app，dmg 解包即得）
    └── data/                # 首次运行自动生成，跟着 U 盘走
        ├── license.json     # --bind-usb 生成的本地授权
        ├── .openclaw/       # 配置、日志、凭证、会话
        ├── npm/             # 按需安装的插件（如 QQ）
        └── update/          # 更新包下载目录
```

拷盘步骤：

1. 解压 `zgyclaw-windows-amd64.zip`，把 `zgyclaw` 文件夹整个拷到 U 盘根目录（运营配置已固化在包内 asar，无需也无法在 U 盘上改地址）；
2. 插到目标机器双击 `zgyclaw.exe`（首次约 1 分钟的模块解压由加载页承接）；
3. **在目标机器上**、在 `zgyclaw` 文件夹里执行 `zgyclaw.exe --bind-usb --license <码>` 完成绑定；
4. 进向导配好模型与通道，之后换电脑插上即用（可插可拔）。

> `data/` 是跟着盘走的运行期目录，**别把开发机的 `data/` 拷给客户**——里面有你自己的登录态、
> 凭证和会话数据，客户启动会直接继承。

### 两层授权（叠加，别混）

**第一层 · 本地授权文件（离线，管"这个盘能不能跑"）**

```bash
zgyclaw.exe --bind-usb --license XLX-XXXXXXXX   # 正式发货：绑定本盘并写入该盘授权码（一码一盘）
zgyclaw.exe --bind-usb                          # 仅限纯离线单机（配置里没写 backend.url）
zgyclaw.exe --check-license                     # 校验本盘授权，并打印本盘使用的授权码
```

`--license` 是这台机器的授权码来源，**包内不再有缺省值**，所以配了后台时必须带；
命令会先向后台核对，核对通过等于同时在后台把这条授权绑到本盘：

| 核对结果 | 行为 |
| --- | --- |
| 通过 | 写本地绑定文件，退出码 0 |
| 后台没有这个授权码 / 已禁用 / 已过期 | **不写文件**，打印原因与处理建议，退出码 1 |
| 这条授权已绑别的 U 盘（`USB_MISMATCH`） | **不写文件**，提示去后台清空该授权的 U 盘 ID，退出码 1 |
| 后台连不上 | 写文件并警告（客户端首次启动时还会再校验一次），退出码 0 |
| 授权码格式非法 | 不联网直接拒绝，退出码 1 |
| 漏了 `--license` 且配了后台 | **不写文件**并说明原因，退出码 1（写出不能用的绑定只会埋雷） |

- 指纹 = `SHA-256(产品盐 + 平台 + 卷序列号)`，卷序列号读不到时回落到磁盘序列号；
- 授权文件是 `XLX-LICENSE-v1:` + base64（内含签名）：手改报 `BAD_LICENSE_SIGNATURE`，换盘报 `DEVICE_MISMATCH`，拷到别的 U 盘直接跑不起来；授权码也在签名范围内，改不动；
- 母本盘与客户盘用同一条命令，没有区别；开发模式（未打包）跳过校验；
- CLI 命令不参与单实例锁，主窗口停在"缺少授权文件"或"未写入后台授权码"时也能执行，绑完点重试即进入。

**第二层 · 后台授权码（联网，管"账号是否有效、要不要更新、下发什么模型"）**

- 授权码只来自**本盘绑定文件**（`--bind-usb --license` 写入，读取时会验签名与本盘指纹）；
  后台地址、通道、版本始终来自包内配置，不接受外部提供（能被改的后台地址等于架空授权）；
- 启动时带授权码 + U 盘指纹请求 `/api/client/license/check`，**首次校验会把该盘序列号写进去**，之后换盘返回 `USB_MISMATCH`；要换盘就在后台清空该授权的 U 盘 ID；
- 结果分两类：后台**明确拒绝**（带业务错误码，如授权无效 / 已过期 / `USB_MISMATCH`）→ **拒绝启动**，加载页显示后台给的原因；**无法判定**（网络不通、超时、后台 5xx）→ 放过启动并记日志。
  后台故障或客户在离线 / 内网环境时不会集体打不开，把关交给第一层；
- 配了后台地址但本盘没有授权码 → 拒绝启动并提示去执行 `--bind-usb --license`（避免悄悄漏掉联检）；
- 授权码的 `channel` 与 `modelGroup` 决定它拿到哪个版本、哪组模型。

发货流程：**后台新建授权码 → 拷包到 U 盘 → 在目标机器上 `--bind-usb --license <码>` → 双击启动**。
`--check-license` 会把本盘用的是哪个授权码打出来，售后核对时不用翻配置文件。

> 本机开发同样走这条路：`npm run dev` 第一次会停在"未写入后台授权码"，
> 在本机执行一次 `npx electron . --bind-usb --license <码>`（绑定文件在 `data/`，已 gitignore）。
> 恢复出厂设置会保留这个绑定文件，所以只需做一次。

### 运行期维护

- **通道设置**：运行页右下角按钮，打开整窗通道面板（与向导 BOT 页同一套），网关不用停就能改凭据、重新扫码、批准飞书配对。保存只写配置不逐次重启网关，改完在底部点一次「重启生效」统一应用；
- **恢复出厂设置**：清空模型配置、通道绑定与凭据、聊天数据、日志；**保留** U 盘授权与插件缓存（`license.json`、`npm`、`extensions`）。删被占用路径时带重试，仍失败如实报错，不留半清状态。

---

## 7. 更新发布

1. 后台"版本管理"新建版本：版本号、平台 `windows`、架构 `x64`、通道 `stable`、可直链下载地址、`sha256`、更新说明，勾选"发布"；
2. 客户端检查到 `needUpdate: true` → 下载到 `data/update/downloads/` → 校验 sha256 后写替换脚本、退出主进程、由脚本覆盖并重启；
3. sha256 不一致直接删包报错，不会替换。

客户端上报给后台、参与版本比较的版本号取自 `app.config.json` 的 `product.version`（当前 `3.0.0`），
发版时记得跟 `package.json` 的 `version` 一起改。

---

## 8. 通道凭据从哪拿

面板上要填的凭据都来自各平台自己的后台，客户端只是把值存进 `openclaw.json`：

- **微信 Clawbot**：不用填，手机微信扫面板二维码。
- **QQ 机器人**：不用填，QQ 机器人开放平台创建机器人后扫码。
- **企业微信**：Bot ID 与 Secret；管理后台 → 智能机器人 → 新建 → 手动创建 → API 模式 → 长连接。
- **飞书 / Lark**：App ID 与 App Secret；开放平台开发者后台 → 选中应用 → 凭证与基础信息。
- **钉钉对话**：Client ID、Client Secret、Robot Code；钉钉开放平台 → 企业内部应用，开启机器人能力并选 Stream 模式。

面板上的"如何获取…"链接来自 `app.config.json` 的 `channels.docs`（键即通道 id：`wecom` / `feishu` /
`dingtalk-channel`），留空该通道就不显示链接。

通道插件来源：微信、钉钉随包放在 `resources/plugins/`；飞书随模块包分发（模块缓存里的
`@openclaw/feishu`）；
企业微信与 QQ 走**按需 payload**（`resources/payload/*.zip` 首次用到时解压到目标目录）。
企业微信采用 openclaw 官方安装布局，解压到 `data/.openclaw/extensions/` 自动发现，不登记加载路径。
新增平台只需在 `src/main/services/modules.js` 的 `PAYLOADS` 登记表加一条（包名、目录、清单文件），
不用再写解压逻辑；`tar` / `tar.gz` / `zip` 都由系统 tar 解。

> 重建 `openclaw-modules.tar.gz` 时不要用 `--omit=optional`，否则飞书插件及其依赖会丢。

---

## 9. 项目结构与关键设计

```
src/main          Electron 主进程：启动链、IPC、全部业务服务
  ├─ services/    配置存取、加解密、授权、后台同步、网关进程、通道、更新、拔盘看护
  ├─ paths.js     产品根目录与 data/ 布局的唯一来源
  └─ index.js     启动编排与生命周期
src/preload       contextBridge 桥接：window.zgy.*（渲染进程唯一入口）
src/renderer      React + TailwindCSS 配置向导与运行页（Vite 构建）
src/shared        跨层共享：timing.json 等
resources/        随包资源：app.config.json、payload 压缩包、插件、bridge 脚本
scripts/          dev.mjs（开发编排）、dist.mjs（打包流水线）
```

- **纯 IPC**：渲染进程与主进程通过类型化 IPC 通信，无本地常驻 HTTP 服务，仅 OAuth 登录期间临时监听 127.0.0.1:18790；
- **无内置 Node**：网关等子进程复用 Electron 自带 Node（`ELECTRON_RUN_AS_NODE`）；
- **进程看护**：所有子进程登记到独立看护进程（`resources/bridge/process-warden.cjs`），主进程退出或被强杀时整树清杀；
  拔盘 watchdog 周期探测数据目录，移除即停网关并退出；
- **原子写**：配置落盘一律"临时文件 + rename"，防止拔盘留下半个文件；
- **令牌保活**：平台 `access_token` 默认 2 小时且同时是网关调算力的 Bearer，距过期不足 15 分钟自动用`refresh_token`（一次性轮转）换新并回写 provider 的 `apiKey`；只有它也失效（`invalid_grant`）才判定登录失效、回登录页，网络抖动保留登录态下周期重试；
- **节奏单一来源**：所有间隔与超时都取自 `src/shared/timing.json`，业务代码里不写死数字；
- **主题调色**：颜色全部走设计令牌，`src/renderer/src/styles/global.css` 的 `:root` 变量定义，`tailwind.config.js` 映射为语义类（`text-ink`、`bg-tint` 等），改 `:root` 一处全站生效。

---

## 10. 排查

日志都在 `data/.openclaw/logs/`：

| 文件 | 内容 |
| --- | --- |
| `electron-shell.log` | 启动链每一步（授权、模块、服务） |
| `gateway.log` / `gateway.err.log` | 网关标准输出与错误（运行页日志框是这两份的合并视图） |
| `backend-client.log` | 后台联检、心跳、模型下发 |
| `oauth.log` | 登录、令牌刷新与轮换 |
| `wechat-login.log` | 微信登录子进程（`qr ready in Xms` 是出码耗时） |
| `config-writes.log` | 每次写 `openclaw.json` 的调用点与 provider/Key 概览，回答“谁改的配置” |

常见问题（按现象查）：

- **第一次启动加载页要等约一分钟**：本机首次跑 openclaw 组件的冷启动代价（解压约 18 秒 + 组件首次启动约 50 秒），
  属预期，加载页会分步说明；这一段只在启动时出现一次，出码成功后落 `.zgy-warm` 标记，之后启动和扫码都很快。
- **登录时同意页 404**：授权平台前端没在 `oauth.authorizationOrigin` 上托管。
- **登录报 `invalid_client`**：clientId 不是 `public` 类型，或回调白名单缺 `http://127.0.0.1:18790/api/auth/callback`。
- **登录报 `invalid_request`**：平台侧未启用 PKCE。
- **授权检查返回 `USB_MISMATCH`**：这条授权已绑过别的盘，后台清空该授权的 U 盘 ID 后可重绑。
- **客户端连不上后台**：`backend.url` 配置错误（留空或不通会让启动停在加载页，见日志）。
- **模型下发返回 `providers: {}`**：四个条件缺一——`enabled=true`、`channel` 与授权一致、`modelGroup` 与授权一致、`modelsJson` 是非空 JSON 数组。
- **飞书日志报 `99991672`**：应用未开通通讯录只读权限；不影响收发消息，只是配对列表拿不到姓名（日志里带直达开通链接）。
- **飞书日志报 `openKeyedStore` 不可用**：插件退回内存去重，不影响功能。
- **管理后台 `mvn spring-boot:run` 报类找不到、编码错乱**：项目路径含中文，挪到纯英文路径。

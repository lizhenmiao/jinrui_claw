/**
 * IPC 接口注册：渲染进程可调用的全部业务接口。
 * 渠道：向导/运行页/通道配置/授权/更新/账号。
 * 每个接口对应一个服务函数，返回结构与旧 REST API 保持等价语义。
 */
const { ipcMain, shell, BrowserWindow } = require("electron");
const { getAppConfig, getPublicConfig } = require("./app-config");
const { readConfig, writeConfig, writeSubscriptionProvider, isConfigured, resetAll } = require("./services/config-store");
const license = require("./services/license");
const gateway = require("./services/process-manager");
const { findQQBotConnectorEntry, findQQBotPluginPaths, isRuntimeWarm } = require("./services/modules");
const { buildRepairChecks, runPortableRepair } = require("./services/repair");
const { readRecentLogs, appendWechatLoginLog } = require("./services/logs");
const { authCallbackResult, beginLogin, cancelLogin, status: oauthStatus, refresh: oauthRefresh, logout: oauthLogout, subscription, subscriptionModelConfig } = require("./services/oauth");
const oauthListener = require("./services/oauth-listener");
const channels = require("./services/channels");
const qqLogin = require("./services/qq-login");
const updater = require("./services/updater");
const fs = require("fs");
const path = require("path");
const { getPaths } = require("./paths");
const timing = require("../shared/timing.json");

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/**
 * 本地二维码 SVG 生成（复用 openclaw 模块内的 qrcode 包）。
 * 必须用 require：qrcode 本身是 CommonJS，而安装包内的主进程是 V8 字节码，字节码里 import() 没有 host 回调（报 "A dynamic import callback was not specified."），表现就是扫码面板一直停在"生成中..."。
 */
async function renderQrSvg(data) {
  if (!data || data.length > 8192) throw new Error("二维码内容无效或过长");
  const qrcodeEntry = path.join(getPaths().modulesCacheDir, "openclaw", "node_modules", "qrcode", "lib", "index.js");
  const qrcode = require(qrcodeEntry);
  return qrcode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M", width: 138 });
}

/** 注册全部 IPC 接口。 */function registerIpcHandlers() {
  // ---- 应用配置 ----
  ipcMain.handle("app:getPublicConfig", () => getPublicConfig());
  ipcMain.handle("app:getGatewayToken", () => readConfig().gateway?.auth?.token || "");
  ipcMain.handle("app:openExternal", async (_event, rawUrl) => {
    const value = String(rawUrl || "").trim();
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error("只允许打开 HTTP/HTTPS 链接");
    await shell.openExternal(value);
    return true;
  });
  ipcMain.handle("app:quit", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) window.close();
  });

  // ---- 配置读写 ----
  ipcMain.handle("config:load", () => ({ config: readConfig() }));
  ipcMain.handle("config:save", (_event, config) => {
    const result = writeConfig(config);
    // 保存即视为完成向导（出厂重置删除标记回到向导首页）。
    try {
      fs.mkdirSync(getPaths().dataDir, { recursive: true });
      fs.writeFileSync(path.join(getPaths().dataDir, "wizard-completed.flag"), new Date().toISOString() + "\n", "utf8");
    } catch { /* 标记失败不影响保存 */ }
    return result;
  });
  ipcMain.handle("config:isConfigured", () => isConfigured());
  ipcMain.handle("config:reset", async () => {
    // 出厂重置：先停 QQ 扫码会话、网关/微信登录子进程等所有子进程并清微信内存态，再清 data（Windows 下句柄释放有延迟，resetAll 内部带重试，删不掉会如实报错）。
    qqLogin.stop();
    await gateway.shutdownAll();
    gateway.resetWechatLoginState();
    const result = await resetAll();
    // 重置会清空 data 目录，重建拔盘哨兵避免看护误判 U 盘已拔出。
    require("./services/usb-watch").refreshSentinel();
    return result;
  });

  // ---- 网关控制 ----
  ipcMain.handle("gateway:start", async () => {
    await channels.preloadChannelsForStart();
    return gateway.startGateway();
  });
  ipcMain.handle("gateway:startWechatFirst", async () => {
    const changed = await channels.preloadChannelsForStart();
    const result = await gateway.startGateway();
    return { ...result, changed };
  });
  ipcMain.handle("gateway:stop", () => gateway.stopGateway());
  // pendingRestart/pendingReasons：有保存/绑定产生的配置变更等待重启加载，界面据此显示"重启生效"按钮并说明原因。
  ipcMain.handle("gateway:status", async () => ({
    running: await gateway.isGatewayRunning(),
    pendingRestart: gateway.hasPendingRestart(),
    pendingReasons: gateway.listPendingRestartReasons(),
  }));
  // 一次性应用所有待生效的通道配置变更（多个平台的修改攒一次重启）。
  ipcMain.handle("gateway:restart", () => gateway.restartGateway("apply-channel-changes"));
  ipcMain.handle("gateway:openChat", async () => {
    const config = readConfig();
    const token = config.gateway?.auth?.token || "";
    const port = config.gateway?.port || 18789;
    const url = `http://127.0.0.1:${port}/chat?session=main${token ? `#token=${encodeURIComponent(token)}` : ""}`;
    await shell.openExternal(url);
    return { ok: true, url };
  });
  ipcMain.handle("logs:recent", () => readRecentLogs());
  ipcMain.handle("logs:clear", () => {
    try { fs.rmSync(path.join(getPaths().logsDir, "app.log"), { force: true }); } catch { /* 文件可能不存在 */ }
    return { ok: true };
  });
  ipcMain.handle("repair:check", () => buildRepairChecks());
  ipcMain.handle("repair:run", () => runPortableRepair());

  // ---- 授权 ----
  ipcMain.handle("license:bind", () => license.bindUsb());
  ipcMain.handle("license:info", () => license.buildLicenseInfo());
  ipcMain.handle("license:status", () => ({ required: license.shouldRequireLicense(), verification: license.verify() }));

  // ---- 更新 ----
  ipcMain.handle("update:check", () => updater.checkUpdate());
  ipcMain.handle("update:install", async () => {
    const result = await updater.installUpdate();
    // 更新脚本等待本进程退出后替换可执行文件，这里直接触发关闭。
    if (result.installing) {
      setTimeout(() => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window) window.close();
      }, timing.update.quitDelayMs);
    }
    return result;
  });

  // ---- 平台账号（OAuth）----
  ipcMain.handle("account:login", async () => {
    const result = await beginLogin();
    await oauthListener.start();
    return result;
  });
  ipcMain.handle("account:status", () => oauthStatus());
  ipcMain.handle("account:authResult", () => authCallbackResult());
  ipcMain.handle("account:cancelLogin", () => { oauthListener.stop(); return cancelLogin(); });
  ipcMain.handle("account:refresh", () => oauthRefresh());
  ipcMain.handle("account:logout", async () => {
    oauthListener.stop();
    return oauthLogout();
  });
  ipcMain.handle("account:subscription", () => subscription());
  // 只读查询订阅可用模型清单（不写配置），供模型页渲染选择列表。
  ipcMain.handle("account:subscriptionModels", async () => {
    const synced = await subscriptionModelConfig();
    return { ok: true, models: synced.models, autoModelId: synced.autoModelId, defaultModel: synced.defaultModel, plan: synced.plan, providerName: synced.providerName };
  });
  ipcMain.handle("account:syncSubscriptionModel", async (_event, preferredModelId) => {
    const synced = await subscriptionModelConfig(preferredModelId);
    writeSubscriptionProvider(synced);
    return { ok: true, providerId: synced.providerId, providerName: synced.providerName, baseUrl: synced.baseUrl, defaultModel: synced.defaultModel, models: synced.models, plan: synced.plan };
  });

  // ---- 通道：企业微信 ----
  ipcMain.handle("channel:wecom:load", () => ({ config: channels.readWecomConfig() }));
  ipcMain.handle("channel:wecom:save", async (_event, input) => {
    const config = await channels.writeWecomConfig(input);
    gateway.markConfigPendingRestart("wecom-config");
    return { ok: true, config };
  });

  // ---- 通道：飞书 ----
  ipcMain.handle("channel:feishu:load", () => ({ config: channels.readFeishuConfig() }));
  ipcMain.handle("channel:feishu:save", (_event, input) => {
    const config = channels.writeFeishuConfig(input);
    gateway.markConfigPendingRestart("feishu-config");
    return { ok: true, config };
  });
  ipcMain.handle("channel:feishu:pairing", () => ({
    ok: true,
    requests: channels.listFeishuPairingRequests(),
    allowFrom: channels.listFeishuAllowFrom(),
    approved: channels.listApprovedFeishuUsers(),
    dmPolicy: channels.readFeishuConfig().dmPolicy,
  }));
  ipcMain.handle("channel:feishu:approvePairing", (_event, code) => {
    const result = channels.approveFeishuPairing(code);
    return { ok: true, message: `已批准 ${result.name || result.userId}`, ...result };
  });
  ipcMain.handle("channel:feishu:revokeUser", (_event, userId) => {
    const result = channels.revokeFeishuUser(userId);
    // 名单同时在配置里时，移除要等网关重启才生效，登记待重启让界面给出"重启生效"按钮。
    if (result.configChanged) gateway.markConfigPendingRestart("feishu-allowFrom");
    return { ok: true, message: "已取消批准", ...result };
  });
  ipcMain.handle("channel:feishu:setDmPolicy", (_event, policy) => {
    const config = channels.setFeishuDmPolicy(policy);
    gateway.markConfigPendingRestart("feishu-dm-policy");
    return { ok: true, config };
  });

  // ---- 通道：钉钉对话 ----
  ipcMain.handle("channel:dingtalkChannel:load", () => ({ config: channels.readDingTalkChannelConfig() }));
  ipcMain.handle("channel:dingtalkChannel:save", (_event, input) => {
    const config = channels.writeDingTalkChannelConfig(input);
    // 桥接进程随网关启动拉起，一并走"重启生效"。
    gateway.markConfigPendingRestart("dingtalk-config");
    return { ok: true, config };
  });

  // ---- 通道：微信 ----登录进程的启动、输出解析与状态推进都在 process-manager 内完成，这里只做接口映射。
  ipcMain.handle("channel:wechat:login", async (_event, options = {}) => {
    appendWechatLoginLog(`login requested restart=${Boolean(options?.restart)}`);
    // 重新绑定的停进程/复用热码由 waitForWechatQr 统一处理。
    const qr = await gateway.waitForWechatQr({ restart: Boolean(options?.restart) });
    if (qr) return { ok: true, type: "url", qr };
    const snapshot = gateway.getWechatLoginSnapshot();
    return { ok: false, type: "text", qr: "", message: snapshot.message };
  });
  // 状态里附带本机组件预热标记：面板据此在首次冷启动（约 1 分钟）时改盖加载页，而不是干等二维码。
  ipcMain.handle("channel:wechat:status", () => ({ ...gateway.getWechatLoginSnapshot(), runtimeWarm: isRuntimeWarm() }));
  // 面板打开时预热登录会话：让"重新绑定"能立刻拿到二维码（已绑定时也能预热）。
  ipcMain.handle("channel:wechat:prewarm", () => ({ ok: true, prewarmed: gateway.prewarmWechatLogin({ force: true }) }));
  // 各通道连接状态摘要：向导据此判断"已接入至少一个平台"，可以进入下一步。
  ipcMain.handle("channel:summary", () => channels.channelSummary());

  // ---- 通道：QQ ----
  ipcMain.handle("channel:qq:pluginStatus", () => ({ ok: true, installed: findQQBotConnectorEntry() !== "" || findQQBotPluginPaths().length > 0 }));
  ipcMain.handle("channel:qq:install", () => channels.installQQBotPlugin());
  // 扫码会话（状态、过期自动重建）在 services/qq-login.js，这里只做接口映射。
  ipcMain.handle("channel:qq:login", async () => {
    qqLogin.begin();
    const qr = await qqLogin.waitForQr();
    if (qr) return { ok: true, type: "url", qr };
    const snapshot = qqLogin.snapshot();
    return { ok: false, type: "text", qr: "", message: snapshot.message };
  });
  // 绑定态从落盘配置推导，面板切页/重启后仍能显示"已绑定"。
  ipcMain.handle("channel:qq:status", () => qqLogin.snapshot());


  ipcMain.handle("qr:render", (_event, data) => renderQrSvg(String(data || "")));

  // ---- 售后诊断 ----
  ipcMain.handle("diagnostics:runtimeInfo", () => ({
    ok: true,
    info: {
      productId: getAppConfig().product?.displayName,
      version: getAppConfig().product?.version,
      platform: `${process.platform} / ${process.arch}`,
      runtime: `electron ${process.versions.electron} (node ${process.versions.node})`,
      ports: getAppConfig().ports,
      paths: { rootDir: getPaths().productRoot, dataDir: getPaths().dataDir },
      generatedAt: new Date().toISOString(),
    },
  }));
}

module.exports = { registerIpcHandlers };

/**
 * IPC 接口注册：渲染进程可调用的全部业务接口。
 * 渠道：向导/运行页/通道配置/授权/更新/账号。
 * 每个接口对应一个服务函数，返回结构与旧 REST API 保持等价语义。
 */
const { ipcMain, shell, BrowserWindow } = require("electron");
const { getAppConfig, getPublicConfig } = require("./app-config");
const { readConfig, writeConfig, isConfigured, resetAll } = require("./services/config-store");
const license = require("./services/license");
const gateway = require("./services/process-manager");
const { findQQBotConnectorEntry, findQQBotPluginPaths } = require("./services/modules");
const { buildRepairChecks, runPortableRepair } = require("./services/repair");
const { readRecentLogs, appendWechatLoginLog } = require("./services/logs");
const { beginLogin, status: oauthStatus, refresh: oauthRefresh, logout: oauthLogout, subscription, subscriptionModelConfig } = require("./services/oauth");
const oauthListener = require("./services/oauth-listener");
const channels = require("./services/channels");
const updater = require("./services/updater");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { getPaths } = require("./paths");
const { stopProcessTree } = require("./services/process-manager");

let wechatLoginState = { status: "idle", qr: "", message: "", output: "" };
let qqLoginState = { status: "idle", qr: "", message: "" };
let qqConnectorCleanup = null;
let activeWechatLoginChild = null;

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** 本地二维码 SVG 生成（复用 openclaw 模块内 qrcode 包）。 */
async function renderQrSvg(data) {
  if (!data || data.length > 8192) throw new Error("二维码内容无效或过长");
  const qrcodeModule = path.join(getPaths().modulesCacheDir, "openclaw", "node_modules", "qrcode");
  const qrcode = await import(pathToFileURL(path.join(qrcodeModule, "lib", "index.js")).href);
  return qrcode.toString(data, { type: "svg", margin: 1, errorCorrectionLevel: "M", width: 138 });
}

function extractWeixinQrUrl(output) {
  const urls = String(output || "").match(/https?:\/\/[^\s"'<>\\]+/g) || [];
  return urls.find((url) => /liteapp\.weixin\.qq\.com\/q\//i.test(url))
    || urls.find((url) => /qrcode=|bot_type=3/i.test(url))
    || "";
}

function parseWechatStatusText(text) {
  if (text.includes("扫描成功") || text.includes("已扫描") || text.includes("scanned")) {
    wechatLoginState.status = "scanned";
    wechatLoginState.message = "已扫码，请在手机上确认";
  }
  if (text.includes("确认") || text.includes("已确认") || text.includes("confirm")) {
    wechatLoginState.status = "confirming";
    wechatLoginState.message = "确认中...";
  }
  if (text.includes("登录成功") || text.includes("已登录") || text.includes("绑定成功") || text.includes("已绑定") || text.includes("logged in") || text.includes("bound")) {
    wechatLoginState.status = "success";
    wechatLoginState.message = "已绑定！";
  }
  if ((text.includes("失败") || text.includes("错误") || text.includes("error")) && wechatLoginState.status !== "success") {
    wechatLoginState.status = "failed";
    wechatLoginState.message = "登录失败，请重试";
  }
}

/** 注册全部 IPC 接口。 */
function registerIpcHandlers() {
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
  ipcMain.handle("config:reset", () => {
    const result = resetAll();
    // 重置会清空 data 目录，重建拔盘哨兵避免看护误判 U 盘已拔出。
    require("./services/usb-watch").refreshSentinel();
    return result;
  });

  // ---- 网关控制 ----
  ipcMain.handle("gateway:start", async () => {
    channels.preloadChannelsForStart();
    return gateway.startGateway();
  });
  ipcMain.handle("gateway:startWechatFirst", async () => {
    const changed = channels.preloadChannelsForStart();
    const result = await gateway.startGateway();
    return { ...result, changed };
  });
  ipcMain.handle("gateway:stop", () => gateway.stopGateway());
  ipcMain.handle("gateway:status", async () => ({ running: await gateway.isGatewayRunning() }));
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
      }, 800);
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
  ipcMain.handle("account:refresh", () => oauthRefresh());
  ipcMain.handle("account:logout", async () => {
    oauthListener.stop();
    return oauthLogout();
  });
  ipcMain.handle("account:subscription", () => subscription());
  ipcMain.handle("account:syncSubscriptionModel", async () => {
    const synced = await subscriptionModelConfig();
    const config = readConfig();
    config.models = config.models || {};
    config.models.providers = config.models.providers || {};
    config.models.providers[synced.providerId] = {
      ...(config.models.providers[synced.providerId] || {}),
      displayName: synced.providerName,
      api: "openai-completions",
      keyMode: "server",
      baseUrl: synced.baseUrl,
      apiKey: synced.accessToken,
      models: synced.models,
    };
    config.agents = config.agents || {};
    config.agents.defaults = config.agents.defaults || {};
    config.agents.defaults.model = synced.providerId + "/" + synced.defaultModel;
    writeConfig(config);
    return { ok: true, providerId: synced.providerId, providerName: synced.providerName, baseUrl: synced.baseUrl, defaultModel: synced.defaultModel, models: synced.models };
  });

  // ---- 通道：企业微信 ----
  ipcMain.handle("channel:wecom:load", () => ({ config: channels.readWecomConfig() }));
  ipcMain.handle("channel:wecom:save", async (_event, input) => {
    const config = channels.writeWecomConfig(input);
    if ((await gateway.isGatewayRunning()) && config.configured && config.enabled) {
      await gateway.restartGateway("wecom-config");
    }
    return { ok: true, config };
  });

  // ---- 通道：飞书 ----
  ipcMain.handle("channel:feishu:load", () => ({ config: channels.readFeishuConfig() }));
  ipcMain.handle("channel:feishu:save", async (_event, input) => {
    const config = channels.writeFeishuConfig(input);
    if ((await gateway.isGatewayRunning()) && config.configured && config.enabled) {
      await gateway.restartGateway("feishu-config");
    }
    return { ok: true, config };
  });
  ipcMain.handle("channel:feishu:pairing", () => ({
    ok: true,
    requests: channels.listFeishuPairingRequests(),
    allowFrom: channels.listFeishuAllowFrom(),
    dmPolicy: channels.readFeishuConfig().dmPolicy,
  }));
  ipcMain.handle("channel:feishu:approvePairing", (_event, code) => {
    const result = channels.approveFeishuPairing(code);
    return { ok: true, message: `已批准 ${result.name || result.userId}`, ...result };
  });
  ipcMain.handle("channel:feishu:setDmPolicy", async (_event, policy) => {
    const config = channels.setFeishuDmPolicy(policy);
    if (await gateway.isGatewayRunning()) await gateway.restartGateway("feishu-dm-policy");
    return { ok: true, config };
  });

  // ---- 通道：钉钉对话 ----
  ipcMain.handle("channel:dingtalkChannel:load", () => ({ config: channels.readDingTalkChannelConfig() }));
  ipcMain.handle("channel:dingtalkChannel:save", async (_event, input) => {
    const config = channels.writeDingTalkChannelConfig(input);
    if ((await gateway.isGatewayRunning()) && config.configured && config.enabled) {
      await gateway.startDingTalkBridge();
    }
    return { ok: true, config };
  });

  // ---- 通道：微信 ----
  ipcMain.handle("channel:wechat:login", async () => {
    appendWechatLoginLog("login requested");
    if (activeWechatLoginChild && !activeWechatLoginChild.killed) {
      stopProcessTree(activeWechatLoginChild.pid);
      activeWechatLoginChild = null;
    }
    wechatLoginState = { status: "pending", qr: "", message: "正在生成二维码...", output: "" };
    return new Promise((resolve) => {
      const child = gateway.startWechatLoginChild();
      activeWechatLoginChild = child;
      appendWechatLoginLog(`spawned login process pid=${child.pid || "unknown"}`);
      let settled = false;
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };
      const handleOutput = (chunk) => {
        const text = chunk.toString();
        wechatLoginState.output += text;
        const qrUrl = extractWeixinQrUrl(wechatLoginState.output);
        if (qrUrl) {
          wechatLoginState.qr = qrUrl;
          if (["pending", "timeout"].includes(wechatLoginState.status)) {
            wechatLoginState.status = "waiting";
            wechatLoginState.message = "请用微信扫码";
          }
          finish({ ok: true, type: "url", qr: qrUrl });
        } else {
          appendWechatLoginLog(text);
        }
        parseWechatStatusText(text);
      };
      child.stdout.on("data", handleOutput);
      child.stderr.on("data", handleOutput);
      child.on("error", (error) => {
        appendWechatLoginLog(`login process error: ${error.message}`);
        wechatLoginState = { status: "failed", qr: "", message: "微信登录进程启动失败: " + error.message, output: "" };
        finish({ ok: false, error: wechatLoginState.message });
      });
      // U 盘与首次插件加载可能很慢：进程保持后台运行，超时后由 status 接口继续取码。
      setTimeout(() => {
        const qrUrl = extractWeixinQrUrl(wechatLoginState.output);
        if (qrUrl) {
          wechatLoginState.status = "waiting";
          finish({ ok: true, type: "url", qr: qrUrl });
        } else {
          wechatLoginState.status = "timeout";
          wechatLoginState.message = "二维码生成超时，仍在后台继续等待；请稍后查看状态或重试";
          appendWechatLoginLog("response timeout before QR; background process is still running");
          finish({ ok: false, type: "text", qr: "", message: wechatLoginState.message });
        }
      }, 90000);
    });
  });
  ipcMain.handle("channel:wechat:status", () => {
    const qrUrl = wechatLoginState.qr || extractWeixinQrUrl(wechatLoginState.output);
    return { status: wechatLoginState.status, qr: qrUrl, message: wechatLoginState.message };
  });

  // ---- 通道：QQ ----
  ipcMain.handle("channel:qq:pluginStatus", () => ({ ok: true, installed: findQQBotConnectorEntry() !== "" || findQQBotPluginPaths().length > 0 }));
  ipcMain.handle("channel:qq:install", () => channels.installQQBotPlugin());
  ipcMain.handle("channel:qq:login", async () => {
    const connectorEntry = findQQBotConnectorEntry();
    if (!connectorEntry) throw new Error("QQBot 插件未安装，请先安装官方 @openclaw/qqbot 插件。");
    if (qqConnectorCleanup) {
      try { qqConnectorCleanup(); } catch { /* 旧连接可能已断开 */ }
      qqConnectorCleanup = null;
    }
    qqLoginState = { status: "pending", qr: "", message: "正在生成 QQBot 绑定二维码..." };
    return new Promise((resolve) => {
      void (async () => {
        try {
          const { startQrConnect } = await import(pathToFileURL(connectorEntry).href);
          let responded = false;
          const finish = (payload) => {
            if (responded) return;
            responded = true;
            resolve(payload);
          };
          qqConnectorCleanup = startQrConnect({
            onQrDisplayed(qrUrl) {
              qqLoginState = { status: "waiting", qr: qrUrl, message: "请用手机 QQ 扫码绑定" };
              finish({ ok: true, type: "url", qr: qrUrl });
            },
            onSuccess(accounts) {
              try {
                const saved = channels.applyQQBotCredentials(accounts);
                qqLoginState = { status: "success", qr: "", message: saved ? `QQBot 已绑定，AppID: ${saved.appId}` : "QQBot 已绑定" };
              } catch (error) {
                qqLoginState = { status: "failed", qr: "", message: "QQBot 已扫码，但保存配置失败: " + error.message };
              } finally {
                qqConnectorCleanup = null;
              }
            },
            onFailure(error) {
              qqLoginState = { status: "failed", qr: "", message: "QQBot 绑定失败: " + (error?.message || String(error)) };
              qqConnectorCleanup = null;
              finish({ ok: false, error: qqLoginState.message });
            },
            onQrExpired() {
              qqLoginState = { status: "expired", qr: "", message: "二维码已过期，请重新生成" };
            },
          }, { displayQrCodeToConsole: false, source: "openclaw" });
          setTimeout(() => {
            finish({ ok: Boolean(qqLoginState.qr), type: qqLoginState.qr ? "url" : "text", qr: qqLoginState.qr, message: qqLoginState.message });
          }, 15000);
        } catch (error) {
          qqLoginState = { status: "failed", qr: "", message: error.message };
          resolve({ ok: false, error: error.message });
        }
      })();
    });
  });
  ipcMain.handle("channel:qq:status", () => qqLoginState);

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

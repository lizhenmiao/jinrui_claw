/**
 * 渲染进程 API：preload 暴露的 window.zgy 桥接的轻量封装。
 * 统一错误处理与类型提示，页面组件不直接触碰 window.zgy。
 */
let bridge = null;

/** 获取桥接对象；preload 未就绪（如纯浏览器调试）时抛出可读错误。 */
function getBridge() {
  if (bridge) return bridge;
  if (typeof window === "undefined" || !window.zgy) {
    throw new Error("桌面桥接不可用：请通过小龙虾客户端运行，而非浏览器直接打开");
  }
  bridge = window.zgy;
  return bridge;
}

export const desktopApi = {
  app: {
    getPublicConfig: () => getBridge().app.getPublicConfig(),
    getGatewayToken: () => getBridge().app.getGatewayToken(),
    openExternal: (url) => getBridge().app.openExternal(url),
    quit: () => getBridge().app.quit(),
    getBootState: () => getBridge().app.getBootState(),
    retryBoot: () => getBridge().app.retryBoot(),
    onBootState: (callback) => getBridge().app.onBootState(callback),
  },
  config: {
    load: () => getBridge().config.load(),
    save: (config) => getBridge().config.save(config),
    isConfigured: () => getBridge().config.isConfigured(),
    reset: () => getBridge().config.reset(),
  },
  gateway: {
    start: () => getBridge().gateway.start(),
    startWechatFirst: () => getBridge().gateway.startWechatFirst(),
    stop: () => getBridge().gateway.stop(),
    restart: () => getBridge().gateway.restart(),
    status: () => getBridge().gateway.status(),
    openChat: () => getBridge().gateway.openChat(),
  },
  logs: {
    recent: () => getBridge().logs.recent(),
    clear: () => getBridge().logs.clear(),
  },
  repair: {
    check: () => getBridge().repair.check(),
    run: () => getBridge().repair.run(),
  },
  license: {
    bind: () => getBridge().license.bind(),
    info: () => getBridge().license.info(),
    status: () => getBridge().license.status(),
  },
  update: {
    check: () => getBridge().update.check(),
    install: () => getBridge().update.install(),
  },
  account: {
    login: () => getBridge().account.login(),
    status: () => getBridge().account.status(),
    authResult: () => getBridge().account.authResult(),
    cancelLogin: () => getBridge().account.cancelLogin(),
    refresh: () => getBridge().account.refresh(),
    logout: () => getBridge().account.logout(),
    subscription: () => getBridge().account.subscription(),
    subscriptionModels: () => getBridge().account.subscriptionModels(),
    syncSubscriptionModel: (modelId) => getBridge().account.syncSubscriptionModel(modelId),
  },
  channels: {
    summary: () => getBridge().channels.summary(),
    wecom: {
      load: () => getBridge().channels.wecom.load(),
      save: (input) => getBridge().channels.wecom.save(input),
    },
    feishu: {
      load: () => getBridge().channels.feishu.load(),
      save: (input) => getBridge().channels.feishu.save(input),
      pairing: () => getBridge().channels.feishu.pairing(),
      approvePairing: (code) => getBridge().channels.feishu.approvePairing(code),
      revokeUser: (userId) => getBridge().channels.feishu.revokeUser(userId),
      setDmPolicy: (policy) => getBridge().channels.feishu.setDmPolicy(policy),
    },
    dingtalkChannel: {
      load: () => getBridge().channels.dingtalkChannel.load(),
      save: (input) => getBridge().channels.dingtalkChannel.save(input),
    },
    wechat: {
      login: (options) => getBridge().channels.wechat.login(options),
      prewarm: () => getBridge().channels.wechat.prewarm(),
      status: () => getBridge().channels.wechat.status(),
    },
    qq: {
      pluginStatus: () => getBridge().channels.qq.pluginStatus(),
      install: () => getBridge().channels.qq.install(),
      login: () => getBridge().channels.qq.login(),
      status: () => getBridge().channels.qq.status(),
    },
  },
  qr: {
    render: (data) => getBridge().qr.render(data),
  },
  diagnostics: {
    runtimeInfo: () => getBridge().diagnostics.runtimeInfo(),
  },
};

export default desktopApi;

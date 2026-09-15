/**
 * 预加载脚本：通过 contextBridge 向渲染进程暴露类型化 API。
 * 命名空间 channel.app / channel.config / ... 按业务域分组，
 * 渲染进程不接触任何 Node/Electron 原生能力。
 */
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const bridge = {
  app: {
    getPublicConfig: invoke("app:getPublicConfig"),
    getGatewayToken: invoke("app:getGatewayToken"),
    openExternal: invoke("app:openExternal"),
    quit: invoke("app:quit"),
    getBootState: invoke("app:getBootState"),
    retryBoot: invoke("app:retryBoot"),
    // 启动状态变化事件（booting/ready/error）；返回取消订阅函数。
    onBootState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on("boot:state", listener);
      return () => ipcRenderer.removeListener("boot:state", listener);
    },
  },
  config: {
    load: invoke("config:load"),
    save: invoke("config:save"),
    isConfigured: invoke("config:isConfigured"),
    reset: invoke("config:reset"),
  },
  gateway: {
    start: invoke("gateway:start"),
    startWechatFirst: invoke("gateway:startWechatFirst"),
    stop: invoke("gateway:stop"),
    restart: invoke("gateway:restart"),
    status: invoke("gateway:status"),
    openChat: invoke("gateway:openChat"),
  },
  logs: {
    recent: invoke("logs:recent"),
    clear: invoke("logs:clear"),
  },
  repair: {
    check: invoke("repair:check"),
    run: invoke("repair:run"),
  },
  license: {
    bind: invoke("license:bind"),
    info: invoke("license:info"),
    status: invoke("license:status"),
  },
  update: {
    check: invoke("update:check"),
    install: invoke("update:install"),
  },
  account: {
    login: invoke("account:login"),
    status: invoke("account:status"),
    authResult: invoke("account:authResult"),
    cancelLogin: invoke("account:cancelLogin"),
    refresh: invoke("account:refresh"),
    logout: invoke("account:logout"),
    subscription: invoke("account:subscription"),
    subscriptionModels: invoke("account:subscriptionModels"),
    syncSubscriptionModel: invoke("account:syncSubscriptionModel"),
  },
  channels: {
    summary: invoke("channel:summary"),
    wecom: {
      load: invoke("channel:wecom:load"),
      save: invoke("channel:wecom:save"),
    },
    feishu: {
      load: invoke("channel:feishu:load"),
      save: invoke("channel:feishu:save"),
      pairing: invoke("channel:feishu:pairing"),
      approvePairing: invoke("channel:feishu:approvePairing"),
      revokeUser: invoke("channel:feishu:revokeUser"),
      setDmPolicy: invoke("channel:feishu:setDmPolicy"),
    },
    dingtalkChannel: {
      load: invoke("channel:dingtalkChannel:load"),
      save: invoke("channel:dingtalkChannel:save"),
    },
    wechat: {
      login: (options) => ipcRenderer.invoke("channel:wechat:login", options),
      prewarm: invoke("channel:wechat:prewarm"),
      warmup: invoke("channel:wechat:warmup"),
      status: invoke("channel:wechat:status"),
    },
    qq: {
      pluginStatus: invoke("channel:qq:pluginStatus"),
      install: invoke("channel:qq:install"),
      login: invoke("channel:qq:login"),
      status: invoke("channel:qq:status"),
    },
  },
  qr: {
    render: invoke("qr:render"),
  },
  diagnostics: {
    runtimeInfo: invoke("diagnostics:runtimeInfo"),
  },
};

contextBridge.exposeInMainWorld("zgy", bridge);

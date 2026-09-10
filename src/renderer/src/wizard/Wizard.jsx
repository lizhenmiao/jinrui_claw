/**
 * 配置向导：首页 → 登录 → 订阅 → 模型 → BOT → 确认 六步流程。
 * 布局对照设计稿：底部 72px 导航条（返回/前进 + 三步骤连接线 + 下一步按钮）。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import desktopApi from "../api.js";
import { Button, useToast } from "../components/ui.jsx";
import HomePage from "./HomePage.jsx";
import LoginPage from "./LoginPage.jsx";
import SubscriptionPage from "./SubscriptionPage.jsx";
import ModelPage from "./ModelPage.jsx";
import BotPage from "./BotPage.jsx";
import ConfirmPage from "./ConfirmPage.jsx";

const PAGE_ORDER = ["home", "login", "subscription", "model", "bot", "confirm"];

/** 页面在步骤条中的序号（0 表示不显示步骤条）。 */
function pageStep(page) {
  if (["login", "subscription", "model"].includes(page)) return 1;
  if (page === "bot") return 2;
  if (page === "confirm") return 3;
  return 0;
}

const STEP_LABELS = ["订阅模型", "配置BOT", "配置完成"];

const STEP_ICONS = [
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s1"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>,
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s2"><path d="M4 5h11v8H9l-3 3v-3H4z" /><path d="M10 10h10v7h-3v3l-3-3h-4z" /></svg>,
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s3"><path d="m12 3 2 2.1 2.9-.3.6 2.8 2.5 1.5-1.2 2.7 1.2 2.7-2.5 1.5-.6 2.8-2.9-.3-2 2.1-2-2.1-2.9.3-.6-2.8L4 14.5l1.2-2.7L4 9.1l2.5-1.5.6-2.8 2.9.3z" /><path d="m8.5 12 2.2 2.2 4.8-4.8" /></svg>,
];

/** 步骤项：46px 圆形气泡 + 12px 标签，非末项带连接线。 */
function Step({ label, icon, state }) {
  const dark = state === "active" || state === "done";
  return (
    <div className={`relative w-[143px] pt-0 text-center text-xs ${dark ? "text-ink" : "text-[#cfcfcf]"}`}>
      {state !== "last" && (
        <span className={`absolute left-[94px] top-[22px] h-[2px] w-[98px] ${dark ? "bg-[#202020]" : "bg-[#dedede]"}`} />
      )}
      <div className="mx-auto flex h-[46px] w-[46px] items-center justify-center rounded-full border-2 border-current bg-white p-[9px]">
        {icon}
      </div>
      <div className="mt-1.5">{label}</div>
    </div>
  );
}

/** 向导容器：集中管理页面导航、模型选择与保存启动。 */
export default function Wizard({ onConfigured }) {
  const [page, setPage] = useState("home");
  const [publicConfig, setPublicConfig] = useState(null);
  const [account, setAccount] = useState({ loggedIn: false, user: null });
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [modelType, setModelType] = useState("openai");
  const [manualModel, setManualModel] = useState({ modelId: "", baseUrl: "", apiKey: "" });
  const [subscriptionModelMode, setSubscriptionModelMode] = useState(false);
  const [selectedTool, setSelectedTool] = useState("wecom");
  const [config, setConfig] = useState({});
  const toast = useToast();

  useEffect(() => {
    (async () => {
      setPublicConfig(await desktopApi.app.getPublicConfig());
      const { config: loaded } = await desktopApi.config.load();
      setConfig(loaded || {});
      const status = await desktopApi.account.status();
      setAccount({ loggedIn: Boolean(status?.loggedIn), user: status?.user || null });
    })().catch((error) => toast.show(error.message, "err"));
  }, []);

  const saveAndStart = useCallback(async () => {
    try {
      const cfg = JSON.parse(JSON.stringify(config || {}));
      cfg.gateway = { mode: "local", port: 18789, bind: "loopback", ...(cfg.gateway || {}), auth: { mode: "token", ...(cfg.gateway?.auth || {}) } };
      cfg.agents = { ...(cfg.agents || {}), defaults: { ...(cfg.agents?.defaults || {}), thinkingDefault: "off" } };
      cfg.models = { ...(cfg.models || {}), providers: { ...(cfg.models?.providers || {}) } };
      cfg.plugins = { ...(cfg.plugins || {}), entries: { ...(cfg.plugins?.entries || {}) } };

      if (subscriptionModelMode) {
        const synced = await desktopApi.account.syncSubscriptionModel();
        cfg.agents.defaults.model = `${synced.providerId}/${synced.defaultModel}`;
        cfg.models.providers[synced.providerId] = {
          ...(cfg.models.providers[synced.providerId] || {}),
          displayName: synced.providerName,
          api: "openai-completions",
          keyMode: "server",
          baseUrl: synced.baseUrl,
          apiKey: synced.accessToken,
          models: synced.models,
        };
      } else {
        const type = publicConfig.models.typeDefaults[modelType] || publicConfig.models.typeDefaults.openai;
        if (!manualModel.modelId || !manualModel.baseUrl || !manualModel.apiKey) {
          toast.show("请完整填写模型 ID、接口地址和 API Key", "err");
          setPage("model");
          return;
        }
        try {
          const parsed = new URL(manualModel.baseUrl);
          if (!/^https?:$/.test(parsed.protocol)) throw new Error();
        } catch {
          toast.show("接口地址格式不正确", "err");
          setPage("model");
          return;
        }
        cfg.agents.defaults.model = `${type.providerId}/${manualModel.modelId}`;
        cfg.models.providers[type.providerId] = {
          ...(cfg.models.providers[type.providerId] || {}),
          api: type.api,
          keyMode: "client",
          baseUrl: manualModel.baseUrl,
          models: [{ id: manualModel.modelId, name: manualModel.modelId, reasoning: false }],
          apiKey: manualModel.apiKey,
        };
      }

      const pluginKeyByTool = {
        wechat: "openclaw-weixin",
        qqbot: "qqbot",
        "dingtalk-channel": "openclaw-dingtalk-channel",
        wecom: "wecom-openclaw-plugin",
        feishu: "feishu",
      };
      if (selectedTool !== "none") {
        cfg.plugins.entries[pluginKeyByTool[selectedTool]] = { enabled: true };
      }

      await desktopApi.config.save(cfg);
      onConfigured();
    } catch (error) {
      toast.show(error.message, "err");
    }
  }, [config, publicConfig, modelType, manualModel, subscriptionModelMode, selectedTool, onConfigured, toast]);

  /** 前进按钮：登录页且订阅有效时点亮，点击后同步订阅模型进入 BOT 配置。 */
  const goForward = useCallback(async () => {
    if (page !== "login" || !subscriptionActive) return;
    try {
      const status = await desktopApi.account.status();
      if (!status?.loggedIn) {
        setSubscriptionActive(false);
        setPage("login");
        toast.show("请先登录平台账号。", "err");
        return;
      }
      const result = await desktopApi.account.subscription();
      const data = result?.data && typeof result.data === "object" ? result.data : result || {};
      const active = data.active === true || data.subscribed === true || ["active", "trial", "paid", "subscribed", "valid"].includes(String(data.status || "").toLowerCase());
      if (!active) {
        setPage("subscription");
        return;
      }
      await desktopApi.account.syncSubscriptionModel();
      setPage("bot");
    } catch (error) {
      toast.show(`订阅模型同步失败：${error.message}`, "err");
    }
  }, [page, subscriptionActive, toast]);

  const step = pageStep(page);
  const context = useMemo(() => ({
    page,
    setPage,
    publicConfig,
    config,
    account,
    setAccount,
    subscriptionActive,
    setSubscriptionActive,
    modelType,
    setModelType,
    manualModel,
    setManualModel,
    subscriptionModelMode,
    setSubscriptionModelMode,
    selectedTool,
    setSelectedTool,
    saveAndStart,
    toast,
  }), [page, publicConfig, config, account, subscriptionActive, modelType, manualModel, subscriptionModelMode, selectedTool, saveAndStart, toast]);

  const pages = {
    home: <HomePage context={context} />,
    login: <LoginPage context={context} />,
    subscription: <SubscriptionPage context={context} />,
    model: <ModelPage context={context} />,
    bot: <BotPage context={context} />,
    confirm: <ConfirmPage context={context} />,
  };

  const backButtonTarget = { login: "home", subscription: "login", model: "login", bot: subscriptionActive ? "login" : "subscription", confirm: "bot" };

  return (
    <div className="flex h-full flex-col bg-white">
      {pages[page]}

      {page !== "home" && (
        <nav className="relative flex h-[72px] flex-none items-start justify-center bg-white">
          <div className="absolute left-[72px] top-[9px] flex items-center gap-2.5">
            <button
              type="button"
              aria-label="返回上一步"
              className="p-[3px]"
              onClick={() => setPage(backButtonTarget[page] || "home")}
            >
              <img src="assets/nav-back.png" alt="" className="h-full w-full" />
            </button>
            <button
              type="button"
              aria-label="下一历史页面"
              disabled={!(page === "login" && subscriptionActive)}
              className={`p-[3px] ${page === "login" && subscriptionActive ? "" : "opacity-30"}`}
              onClick={goForward}
            >
              <img src="assets/nav-forward.png" alt="" className="h-full w-full" />
            </button>
          </div>
          <div className="flex">
            {STEP_LABELS.map((label, index) => (
              <Step
                key={label}
                label={label}
                icon={STEP_ICONS[index]}
                state={index + 1 === step ? "active" : index + 1 < step ? "done" : index === STEP_LABELS.length - 1 ? "last" : "idle"}
              />
            ))}
          </div>
          {page !== "login" && page !== "subscription" && (
            <Button
              className={`absolute right-[72px] top-[2px] ${page === "confirm" ? "h-[42px] min-w-[185px] rounded-[22px] text-base" : "min-w-[140px]"}`}
              onClick={() => {
                if (page === "model") setPage("bot");
                else if (page === "bot") setPage("confirm");
                else saveAndStart();
              }}
            >
              {page === "confirm" ? "保存并启动" : "下一步"}
            </Button>
          )}
        </nav>
      )}

      {toast.element}
    </div>
  );
}

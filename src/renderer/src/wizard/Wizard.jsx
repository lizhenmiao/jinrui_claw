/**
 * 配置向导：首页 → 登录 → 订阅 → 模型 → BOT → 确认 六步流程。
 * 布局对照 2.0 设计稿：页面内承载主按钮，底部为左下圆形前进/后退与居中三步骤指示器。
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import desktopApi from "../api.js";
import { useToast } from "../components/ui.jsx";
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

const STEP_LABELS = ["配置模型", "配置BOT", "配置完成"];

const STEP_ICONS = [
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s1"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>,
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s2"><path d="M4 5h11v8H9l-3 3v-3H4z" /><path d="M10 10h10v7h-3v3l-3-3h-4z" /></svg>,
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-full w-full" key="s3"><path d="m12 3 2 2.1 2.9-.3.6 2.8 2.5 1.5-1.2 2.7 1.2 2.7-2.5 1.5-.6 2.8-2.9-.3-2 2.1-2-2.1-2.9.3-.6-2.8L4 14.5l1.2-2.7L4 9.1l2.5-1.5.6-2.8 2.9.3z" /><path d="m8.5 12 2.2 2.2 4.8-4.8" /></svg>,
];

/** 步骤项：46px 圆形气泡 + 12px 标签，非末项带连接线（对照设计稿底部步骤条）。 */
function Step({ label, icon, state }) {
  const active = state === "active" || state === "done";
  return (
    <div className={`relative w-[143px] text-center text-xs ${active ? "text-ink" : "text-faint"}`}>
      {state !== "last" && (
        <span className={`absolute left-[94px] top-[22px] h-[2px] w-[98px] ${active ? "bg-ink" : "bg-line"}`} />
      )}
      <div className={`mx-auto flex h-[46px] w-[46px] items-center justify-center rounded-full border-2 p-[10px] ${active ? "border-current bg-card" : "border-current bg-transparent"}`}>
        {icon}
      </div>
      <div className="mt-1.5">{label}</div>
    </div>
  );
}

/** 底部导航：左下圆形返回/前进 + 居中步骤条 + BOT 页右下角的醒目"下一页"。 */
function WizardFooter({ page, step, onBack, onForward, forwardEnabled }) {
  if (!step) return null;
  return (
    <div className="relative flex h-[112px] flex-none items-start justify-center bg-card">
      <div className="absolute bottom-[16px] left-[36px] flex items-center gap-3">
        <button
          type="button"
          aria-label="返回上一步"
          className="flex h-[30px] w-[30px] items-center justify-center rounded-full border-[1.6px] border-ink text-body"
          onClick={onBack}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
        </button>
        <button
          type="button"
          aria-label="下一步"
          disabled={!forwardEnabled}
          className={`flex h-[30px] w-[30px] items-center justify-center rounded-full border-[1.6px] ${forwardEnabled ? "border-ink text-body" : "border-line text-faint"}`}
          onClick={onForward}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></svg>
        </button>
      </div>
      <div className="flex pt-[10px]">
        {STEP_LABELS.map((label, index) => (
          <Step
            key={label}
            label={label}
            icon={STEP_ICONS[index]}
            state={index + 1 === step ? "active" : index + 1 < step ? "done" : index === STEP_LABELS.length - 1 ? "last" : "idle"}
          />
        ))}
      </div>
      {/* BOT 页通道多、左下角的小箭头不够显眼：接好一个工具后右下角出现实心"下一页"；一个都没接时不出现。 */}
      {page === "bot" && forwardEnabled && (
        <button
          type="button"
          className="absolute bottom-[16px] right-[36px] h-[40px] rounded-full bg-ink px-[30px] text-[15px] font-medium text-white transition hover:opacity-90"
          onClick={onForward}
        >
          下一页
        </button>
      )}
    </div>
  );
}

/** 向导容器：集中管理页面导航、模型选择与保存启动。 */
export default function Wizard({ onConfigured }) {
  const [page, setPage] = useState("home");
  const [publicConfig, setPublicConfig] = useState(null);
  const [account, setAccount] = useState({ loggedIn: false, user: null });
  const [subscriptionActive, setSubscriptionActive] = useState(false);
  const [subscriptionPlan, setSubscriptionPlan] = useState(null);
  const [modelType, setModelType] = useState("openai");
  const [manualModel, setManualModel] = useState({ modelId: "", baseUrl: "", apiKey: "" });
  const [subscriptionModelMode, setSubscriptionModelMode] = useState(false);
  const [chosenSubscriptionModel, setChosenSubscriptionModel] = useState("");
  // BOT 页是否已接入至少一个平台：决定"下一步"能否点（否则只能走"跳过"）。
  const [botReady, setBotReady] = useState(false);
  const toast = useToast();

  useEffect(() => {
    (async () => {
      setPublicConfig(await desktopApi.app.getPublicConfig());
      const status = await desktopApi.account.status();
      setAccount({ loggedIn: Boolean(status?.loggedIn), user: status?.user || null });
    })().catch((error) => toast.show(error.message, "err"));
  }, []);

  const saveAndStart = useCallback(async () => {
    try {
      // BOT 页里扫码/保存的配置由主进程随时落盘，保存前重新读最新值再改，避免把进向导时那份旧快照写回去、清掉刚写入的通道凭据。
      const { config: latest } = await desktopApi.config.load();
      const cfg = JSON.parse(JSON.stringify(latest || {}));
      cfg.gateway = { mode: "local", port: 18789, bind: "loopback", ...(cfg.gateway || {}), auth: { mode: "token", ...(cfg.gateway?.auth || {}) } };
      cfg.agents = { ...(cfg.agents || {}), defaults: { ...(cfg.agents?.defaults || {}), thinkingDefault: "off" } };
      cfg.models = { ...(cfg.models || {}), providers: { ...(cfg.models?.providers || {}) } };
      cfg.plugins = { ...(cfg.plugins || {}), entries: { ...(cfg.plugins?.entries || {}) } };

      if (subscriptionModelMode) {
        const synced = await desktopApi.account.syncSubscriptionModel(chosenSubscriptionModel || undefined);
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

      // 通道插件在扫码/保存配置成功时已各自启用；没配置的通道不因"选中过"而被启用。
      await desktopApi.config.save(cfg);
      onConfigured();
    } catch (error) {
      toast.show(error.message, "err");
    }
  }, [publicConfig, modelType, manualModel, subscriptionModelMode, chosenSubscriptionModel, onConfigured, toast]);

  /** 登录成功后的订阅检查：有效订阅直接进入模型页选择模型（默认订阅模式）。 */
  const checkSubscriptionAfterLogin = useCallback(async () => {
    try {
      const result = await desktopApi.account.subscription();
      const data = result?.data && typeof result.data === "object" ? result.data : result || {};
      const detail = data.detail && typeof data.detail === "object" ? data.detail : {};
      const active = data.subscribed === true || String(detail.status || "").toLowerCase() === "active";
      if (active) {
        setSubscriptionActive(true);
        setSubscriptionModelMode(true);
        setSubscriptionPlan({
          name: detail.plan_name || detail.plan_tier || "Coding Plan",
          quotaRemaining: detail.quota_remaining ?? 0,
          quotaTotal: detail.quota_total ?? 0,
          endAt: detail.end_at || "",
          enabledModels: Array.isArray(detail.enabled_models) ? detail.enabled_models : [],
        });
        setPage("model");
        return;
      }
      setSubscriptionModelMode(false);
      setPage("subscription");
    } catch (error) {
      setSubscriptionModelMode(false);
      if (/登录已失效|请重新登录/.test(String(error.message || ""))) {
        toast.show("登录已失效，请重新登录", "err");
        setSubscriptionActive(false);
        setPage("login");
        return;
      }
      setPage("subscription");
    }
  }, [toast]);

  /** 前进箭头：登录页订阅有效时进入模型页，模型页进入 BOT 配置。 */
  const goForward = useCallback(async () => {
    if (page === "model") {
      setPage("bot");
      return;
    }
    if (page === "bot") {
      if (botReady) setPage("confirm");
      return;
    }
    if (page !== "login" || !subscriptionActive) return;
    try {
      const status = await desktopApi.account.status();
      if (!status?.loggedIn) {
        setSubscriptionActive(false);
        toast.show("请先登录平台账号。", "err");
        return;
      }
      await checkSubscriptionAfterLogin();
    } catch (error) {
      toast.show(`订阅检查失败：${error.message}`, "err");
    }
  }, [page, subscriptionActive, checkSubscriptionAfterLogin, toast, botReady]);

  const step = pageStep(page);
  const forwardEnabled = (page === "login" && subscriptionActive) || page === "model" || (page === "bot" && botReady);
  const context = useMemo(() => ({
    page,
    setPage,
    publicConfig,
    account,
    setAccount,
    subscriptionActive,
    setSubscriptionActive,
    subscriptionPlan,
    setSubscriptionPlan,
    modelType,
    setModelType,
    manualModel,
    setManualModel,
    subscriptionModelMode,
    setSubscriptionModelMode,
    chosenSubscriptionModel,
    setChosenSubscriptionModel,
    setBotReady,
    saveAndStart,
    checkSubscriptionAfterLogin,
    toast,
  }), [page, publicConfig, account, subscriptionActive, subscriptionPlan, modelType, manualModel, subscriptionModelMode, chosenSubscriptionModel, saveAndStart, checkSubscriptionAfterLogin, toast]);

  const pages = {
    home: <HomePage context={context} />,
    login: <LoginPage context={context} />,
    subscription: <SubscriptionPage context={context} />,
    model: <ModelPage context={context} />,
    bot: <BotPage context={context} />,
    confirm: <ConfirmPage context={context} />,
  };

  const backButtonTarget = { login: "home", subscription: "login", model: "login", bot: subscriptionActive ? "model" : "subscription", confirm: "bot" };

  return (
    <div className="flex h-full flex-col bg-card">
      <div className="flex flex-1 flex-col overflow-hidden">{pages[page]}</div>

      <WizardFooter
        page={page}
        step={step}
        onBack={() => setPage(backButtonTarget[page] || "home")}
        onForward={goForward}
        forwardEnabled={forwardEnabled}
      />

      {toast.element}
    </div>
  );
}

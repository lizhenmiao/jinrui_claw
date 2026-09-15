/**
 * 向导订阅页：对照 2.0 设计稿 —— 三档套餐卡片（最受欢迎居中）、底部文档/自定义链接。
 * 点开订阅页后进入等待态：三档按钮全部置灰、被点那一档显示加载中，
 * 并以 2 秒间隔持续查询订购状态，生效后自动进入模型选择。
 */
import React, { useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";

/** 订购状态查询间隔（毫秒），统一取自 src/shared/timing.json。 */
const SUBSCRIPTION_POLL_INTERVAL_MS = timing.subscription.pollIntervalMs;

/** 订阅接口返回结构兼容归一化：active/subscribed/状态串/到期时间。 */
function isSubscriptionActive(result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result || {};
  if (data.active === true || data.subscribed === true || data.is_active === true) return true;
  const detail = data.detail && typeof data.detail === "object" ? data.detail : {};
  if (String(detail.status || "").toLowerCase() === "active") return true;
  const status = String(data.status || data.subscription_status || data.state || "").toLowerCase();
  if (["active", "trial", "paid", "subscribed", "valid"].includes(status)) return true;
  const end = data.end_at || data.expires_at || data.expire_at;
  return Boolean(end && Date.parse(end) > Date.now());
}

export default function SubscriptionPage({ context }) {
  const { publicConfig, setSubscriptionActive, setSubscriptionModelMode, setPage, toast } = context;
  const plans = publicConfig?.subscription?.plans || [];
  const [statusText, setStatusText] = useState("");
  const [statusTone, setStatusTone] = useState("info");
  const [currentPlan, setCurrentPlan] = useState(null);
  const [opening, setOpening] = useState(false);
  const [pendingKey, setPendingKey] = useState("");
  const pollTimer = useRef(null);
  const alive = useRef(true);

  const stopPolling = () => {
    clearTimeout(pollTimer.current);
    pollTimer.current = null;
  };

  useEffect(() => {
    alive.current = true;
    // 进入页面先查一次：已有有效订阅时直接给出"前往选择模型"入口。
    (async () => {
      try {
        const status = await desktopApi.account.status();
        if (!status?.loggedIn) return;
        const result = await desktopApi.account.subscription();
        if (!isSubscriptionActive(result)) return;
        const data = result?.data && typeof result.data === "object" ? result.data : result || {};
        const detail = data.detail && typeof data.detail === "object" ? data.detail : {};
        setCurrentPlan({
          name: detail.plan_name || detail.plan_tier || "Coding Plan",
          quotaRemaining: detail.quota_remaining ?? 0,
          quotaTotal: detail.quota_total ?? 0,
          endAt: detail.end_at || "",
        });
        setSubscriptionActive(true);
      } catch { /* 未登录或查询失败保持静默 */ }
    })();
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [setSubscriptionActive]);

  // 订购生效后进入模型选择页（订阅模式），由用户确认使用哪个模型。
  const enterModelSelection = async () => {
    try {
      setStatusText("订购状态有效，正在获取可用模型...");
      await desktopApi.account.syncSubscriptionModel();
      setSubscriptionModelMode(true);
      toast.show("订购状态有效，请选择要使用的模型");
      setPage("model");
    } catch (error) {
      if (/登录已失效|请重新登录/.test(String(error.message || ""))) {
        setStatusTone("err");
        setStatusText("登录已失效，请重新登录。");
        setPage("login");
        return;
      }
      setStatusTone("warn");
      setStatusText(`订阅有效，但获取可用模型失败：${error.message}`);
    }
  };

  /** 查一次订购状态：成功进模型页，登录失效回登录页，其余情况继续等下一轮。 */
  const checkOnce = async () => {
    try {
      const result = await desktopApi.account.subscription();
      if (!alive.current) return;
      if (isSubscriptionActive(result)) {
        setSubscriptionActive(true);
        stopPolling();
        setPendingKey("");
        await enterModelSelection();
        return;
      }
      setStatusTone("info");
      setStatusText("已打开订阅页面，请在浏览器中完成订购；客户端每 2 秒自动检查一次，订购成功会直接进入模型选择。");
      pollTimer.current = setTimeout(checkOnce, SUBSCRIPTION_POLL_INTERVAL_MS);
    } catch (error) {
      if (!alive.current) return;
      if (/登录已失效|请重新登录/.test(String(error.message || ""))) {
        stopPolling();
        setPendingKey("");
        setStatusTone("err");
        setStatusText("登录已失效，请重新登录。");
        setPage("login");
        return;
      }
      setStatusTone("warn");
      setStatusText(`订购状态查询失败，正在重试：${error.message}`);
      pollTimer.current = setTimeout(checkOnce, SUBSCRIPTION_POLL_INTERVAL_MS);
    }
  };

  /** 点开订阅页：立即进入等待态（该档转圈、三档全部置灰），并开始轮询订购状态。 */
  const openPlans = async (planKey) => {
    if (pendingKey) return;
    try {
      const status = await desktopApi.account.status();
      if (!status?.loggedIn) {
        toast.show("请先登录平台账号，再进行订阅。", "err");
        setPage("login");
        return;
      }
      setPendingKey(planKey);
      setOpening(true);
      const origin = String(publicConfig?.oauth?.authorizationOrigin || "").replace(/\/+$/, "");
      const suffix = publicConfig?.subscription?.plansPageSuffix || "coding-plan";
      await desktopApi.app.openExternal(`${origin}/${suffix}`);
      if (!alive.current) return;
      setOpening(false);
      setStatusTone("info");
      setStatusText("已打开订阅页面，请在浏览器中完成订购；客户端每 2 秒自动检查一次，订购成功会直接进入模型选择。");
      stopPolling();
      pollTimer.current = setTimeout(checkOnce, SUBSCRIPTION_POLL_INTERVAL_MS);
    } catch (error) {
      if (!alive.current) return;
      setOpening(false);
      setPendingKey("");
      setStatusTone("warn");
      setStatusText(`订阅页面打开失败：${error.message}`);
    }
  };

  const planDisabled = Boolean(pendingKey);
  const toneClass = statusTone === "err" ? "text-dangerdeep" : statusTone === "warn" ? "text-warndeep" : "text-okdeep";

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-page px-6">
      <div className="w-full max-w-[860px] text-center">
        <h1 className="text-[32px] font-extrabold leading-none tracking-[-1px] text-ink">
          Zgy<em className="not-italic text-logo">Claw</em>
        </h1>
        <p className="mb-[38px] mt-[18px] text-[24px] font-medium text-title">要开始使用，您需要先订阅 Coding Plan</p>

        {currentPlan && (
          <div className="mx-auto mb-[26px] flex w-full max-w-[820px] items-center justify-between gap-4 rounded-[12px] bg-tint px-6 py-[16px] text-left">
            <div className="text-[13px] text-body">
              <b className="text-[15px] text-title">当前订阅：{currentPlan.name}</b>
              <span className="ml-3">
                额度 {Math.round(currentPlan.quotaRemaining)}/{Math.round(currentPlan.quotaTotal)}
                {currentPlan.endAt ? `，有效期至 ${currentPlan.endAt}` : ""}
              </span>
            </div>
            <button
              type="button"
              className="h-[36px] flex-none rounded-full bg-ink px-[22px] text-[13px] font-medium text-white hover:opacity-90"
              onClick={() => {
                setSubscriptionModelMode(true);
                setPage("model");
              }}
            >
              前往选择模型
            </button>
          </div>
        )}

        <div className="mx-auto flex w-full max-w-[900px] items-stretch justify-center gap-[30px]">
          {plans.map((plan, index) => {
            const planKey = `${plan.name}-${index}`;
            const isPending = pendingKey === planKey;
            return (
              <article
                key={planKey}
                className={`relative flex min-h-[258px] flex-1 flex-col rounded-[14px] bg-card px-[26px] pb-[26px] text-left ${
                  plan.popular ? "border-2 border-hot pt-[46px]" : "border border-linesoft pt-[42px]"
                }`}
              >
                {plan.popular && (
                  <span className="absolute -left-0.5 -right-0.5 -top-0.5 flex h-[36px] items-center justify-center rounded-t-[12px] bg-hot text-[13px] text-white">
                    最受欢迎
                  </span>
                )}
                <b className="text-[17px] font-semibold text-title">{plan.name}</b>
                <strong className="mt-[16px] text-[22px] font-semibold text-title">
                  {plan.price}
                  <small className="ml-1 text-[13px] font-normal text-faint">{plan.period}</small>
                </strong>
                <span className="mt-[10px] text-[12.5px] leading-[1.6] text-subtle">{plan.desc}</span>
                <button
                  type="button"
                  disabled={planDisabled}
                  onClick={() => openPlans(planKey)}
                  className={`mt-auto flex h-[44px] w-full items-center justify-center gap-2 rounded-full text-[15px] font-medium ${
                    planDisabled
                      ? "cursor-not-allowed bg-linesoft text-faint"
                      : plan.popular
                        ? "bg-ink text-white hover:opacity-90"
                        : "border border-line bg-card text-title hover:border-line"
                  }`}
                >
                  {isPending ? (opening ? "正在打开订阅页" : "等待订购完成") : "立即订阅"}
                  {isPending && (
                    <span className="inline-block h-[13px] w-[13px] animate-spin rounded-full border-2 border-ink/20 border-t-ink" />
                  )}
                </button>
              </article>
            );
          })}
        </div>

        <div className={`mt-[26px] min-h-[22px] text-[13px] leading-[1.5] ${toneClass}`}>{statusText}</div>
        <p className="mt-[10px] text-[13px] text-subtle">
          定价与权益说明详见
          <a href="#" onClick={(event) => event.preventDefault()} className="mx-1 text-link">产品文档</a>
          您也可以使用
          <a
            href="#"
            onClick={(event) => { event.preventDefault(); setPage("model"); }}
            className="mx-1 text-link"
          >
            自定义模型配置
          </a>
        </p>
      </div>
    </div>
  );
}

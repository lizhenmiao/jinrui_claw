/**
 * 向导模型页：对照 2.0 设计稿 —— 订阅模型（展示后台可用模型清单供选择）与手动配置（openAI/Anthropic 胶囊切换 + 三行表单）两种模式，底部"下一步"进 BOT 配置。
 */
import React, { useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { useToast } from "../components/ui.jsx";

export default function ModelPage({ context }) {
  const { publicConfig, subscriptionActive, subscriptionModelMode, setSubscriptionModelMode, modelType, setModelType, manualModel, setManualModel, chosenSubscriptionModel, setChosenSubscriptionModel, toast } = context;
  const typeDefaults = publicConfig?.models?.typeDefaults || {};
  const [plan, setPlan] = useState(null);
  const [modelList, setModelList] = useState([]);
  const [autoModelId, setAutoModelId] = useState("");
  const [loading, setLoading] = useState(false);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!subscriptionActive || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    desktopApi.account.subscriptionModels()
      .then((result) => {
        setModelList(result.models || []);
        setAutoModelId(result.autoModelId || "");
        setPlan(result.plan || null);
        setChosenSubscriptionModel((prev) => prev || result.autoModelId || result.defaultModel || (result.models || [])[0]?.id || "");
      })
      .catch((error) => {
        if (/登录已失效|请重新登录/.test(String(error.message || ""))) {
          toast.show("登录已失效，请重新登录", "err");
          context.setPage("login");
          return;
        }
        toast.show(`订阅模型获取失败：${error.message}`, "err");
      })
      .finally(() => setLoading(false));
  }, [subscriptionActive, setChosenSubscriptionModel, toast]);

  const current = typeDefaults[modelType] || typeDefaults.openai;

  const goNext = async () => {
    if (subscriptionModelMode && subscriptionActive) {
      try {
        await desktopApi.account.syncSubscriptionModel(chosenSubscriptionModel || undefined);
        toast.show("已选择订阅模型");
        context.setPage("bot");
      } catch (error) {
        toast.show(`订阅模型同步失败：${error.message}`, "err");
      }
      return;
    }
    context.setPage("bot");
  };

  const showSubscription = subscriptionActive && subscriptionModelMode;

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-page px-6">
      <div className="flex w-full max-w-[860px] flex-col items-center text-center">
        <h1 className="text-[32px] font-extrabold leading-none tracking-[-1px] text-ink">
          Zgy<em className="not-italic text-logo">Claw</em>
        </h1>
        <p className="mb-[30px] mt-[18px] text-[24px] font-medium text-title">配置你的大模型，激活 AI 助手能力</p>

        {subscriptionActive && (
          <div className="mb-[26px] flex h-[52px] w-[250px] rounded-full bg-switch p-[5px] text-[14px] text-faint">
            <span
              role="tab"
              aria-selected={subscriptionModelMode}
              className={`flex h-full flex-1 cursor-pointer select-none items-center justify-center rounded-full ${subscriptionModelMode ? "bg-card text-body shadow-[0_1px_5px_rgba(0,0,0,0.08)]" : ""}`}
              onClick={() => setSubscriptionModelMode(true)}
            >
              订阅模型
            </span>
            <span
              role="tab"
              aria-selected={!subscriptionModelMode}
              className={`flex h-full flex-1 cursor-pointer select-none items-center justify-center rounded-full ${!subscriptionModelMode ? "bg-card text-body shadow-[0_1px_5px_rgba(0,0,0,0.08)]" : ""}`}
              onClick={() => setSubscriptionModelMode(false)}
            >
              手动配置
            </span>
          </div>
        )}

        {showSubscription && (
          <div className="w-full max-w-[620px] rounded-[12px] bg-card p-[26px] text-left shadow-[0_4px_18px_rgba(0,0,0,0.04)]">
            <div className="mb-[14px] flex items-center justify-between gap-3">
              <b className="text-[17px] font-bold text-title">订阅模型</b>
              {plan && (
                <span className="rounded-[6px] bg-okbg px-2.5 py-1 text-[12px] text-okdeep">
                  {plan.name} 已生效{plan.endAt ? ` · ${plan.endAt} 到期` : ""}
                </span>
              )}
            </div>
            {loading ? (
              <div className="py-6 text-center text-[13px] text-faint">正在获取可用模型...</div>
            ) : (
              <div className="flex flex-col gap-[10px]">
                {modelList.map((model) => {
                  const picked = chosenSubscriptionModel === model.id;
                  return (
                    <label
                      key={model.id}
                      className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-[16px] py-[12px] ${picked ? "border-ink bg-paper" : "border-line bg-card hover:border-line"}`}
                    >
                      <input
                        type="radio"
                        name="subscription-model"
                        className="h-[15px] w-[15px] accent-ink"
                        checked={picked}
                        onChange={() => setChosenSubscriptionModel(model.id)}
                      />
                      <span className="flex-1">
                        <b className={`text-[14px] font-semibold ${picked ? "text-ink" : "text-body"}`}>{model.name}</b>
                        <span className="ml-2 text-[12px] text-faint">{model.id}</span>
                        {model.id === autoModelId && <span className="ml-2 rounded-[4px] bg-tint px-1.5 py-0.5 text-[11px] text-branddeep">推荐</span>}
                      </span>
                      {model.input?.includes("image") && <span className="text-[11px] text-faint">支持图片</span>}
                    </label>
                  );
                })}
              </div>
            )}
            <p className="mt-[14px] text-[12px] leading-[1.6] text-subtle">
              已检测到有效订购，使用平台提供的模型服务，无需填写接口地址或 API Key。
            </p>
          </div>
        )}

        {!showSubscription && (
          <>
            <div className="mb-[26px] flex h-[52px] w-[250px] rounded-full bg-switch p-[5px] text-[14px] text-faint">
              {Object.entries(typeDefaults).map(([key, value]) => (
                <span
                  key={key}
                  role="tab"
                  aria-selected={modelType === key}
                  className={`flex h-full flex-1 cursor-pointer select-none items-center justify-center rounded-full ${modelType === key ? "bg-card text-body shadow-[0_1px_5px_rgba(0,0,0,0.08)]" : ""}`}
                  onClick={() => setModelType(key)}
                >
                  {value.label}
                </span>
              ))}
            </div>

            <div className="w-full max-w-[400px]">
              {[
                { id: "modelId", label: "模型ID：", placeholder: "deepseek-v4-pro", value: manualModel.modelId, key: "modelId" },
                { id: "baseUrl", label: "接口地址：", placeholder: current.baseUrl || "https://api.example.com/v1", value: manualModel.baseUrl, key: "baseUrl" },
                { id: "apiKey", label: "Api key：", placeholder: "sk-...", value: manualModel.apiKey, key: "apiKey", type: "password" },
              ].map((field) => (
                <div key={field.key} className="mb-[16px] grid grid-cols-[96px_1fr] items-center gap-3">
                  <label htmlFor={field.id} className="text-right text-[15px] text-body">{field.label}</label>
                  <input
                    id={field.id}
                    type={field.type || "text"}
                    className="h-[44px] rounded-[8px] bg-linesoft px-3 text-[14px] text-body outline-none focus:bg-card focus:ring-1 focus:ring-brand"
                    placeholder={field.placeholder}
                    value={field.value}
                    onChange={(event) => setManualModel((prev) => ({ ...prev, [field.key]: event.target.value.trim() }))}
                  />
                </div>
              ))}
            </div>
          </>
        )}

        <button
          type="button"
          onClick={goNext}
          className="mt-[34px] h-[56px] w-[320px] rounded-full bg-ink text-[19px] font-medium text-white transition hover:opacity-90"
        >
          下一步
        </button>
      </div>
    </div>
  );
}

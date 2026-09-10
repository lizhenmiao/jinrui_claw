/** 向导模型页：订阅模型（服务端托管 Key）或手动填写 OpenAI/Anthropic 兼容配置。 */
import React, { useEffect, useState } from "react";
import desktopApi from "../api.js";
import { Button } from "../components/ui.jsx";

export default function ModelPage({ context }) {
  const { publicConfig, config, subscriptionModelMode, setSubscriptionModelMode, modelType, setModelType, manualModel, setManualModel, subscriptionActive, toast } = context;
  const typeDefaults = publicConfig?.models?.typeDefaults || {};
  const [subscriptionInfo, setSubscriptionInfo] = useState(null);

  useEffect(() => {
    // 已同步的订阅 provider 显示为卡片；手动模式下隐藏。
    const providers = config?.models?.providers || {};
    const providerId = String(config?.agents?.defaults?.model || "").split("/")[0];
    const provider = providers[providerId];
    if (provider?.keyMode === "server") {
      setSubscriptionInfo({ providerId, name: provider.displayName || providerId, modelId: provider.models?.[0]?.id || "" });
    } else {
      setSubscriptionInfo(null);
    }
  }, [config]);

  const current = typeDefaults[modelType] || typeDefaults.openai;

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[620px] px-8 pb-8 pt-6 text-center">
        <div className="mb-3 flex items-center justify-center gap-2">
          <img src="assets/logo.png" alt="小龙虾" className="h-[54px] w-[54px] object-contain" />
          <strong className="text-[30px] font-extrabold tracking-[-1.2px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></strong>
        </div>
        <h1 className="mb-5 text-[23px] font-medium text-[#151515]">配置你的大模型，激活 AI 助手能力</h1>

        {subscriptionModelMode && subscriptionInfo && (
          <div className="mx-auto mb-[18px] w-full max-w-[560px] rounded-[10px] bg-tint p-[18px_20px] text-left text-[#444]">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <strong className="text-base text-[#222]">订阅模型</strong>
              <span className="whitespace-nowrap rounded-[14px] bg-[#dff8e9] px-2.5 py-1 text-[11px] text-okdeep">Coding Plan 已生效</span>
            </div>
            <div className="grid grid-cols-[82px_1fr] gap-y-[7px] text-[13px] leading-[1.45]">
              <b className="text-right font-medium text-[#555]">服务类型</b>
              <span className="break-all font-semibold text-[#222]">{subscriptionInfo.name}</span>
              <b className="text-right font-medium text-[#555]">AI 模型</b>
              <span className="break-all font-semibold text-[#222]">{subscriptionInfo.modelId}</span>
            </div>
            <p className="mt-3 text-[11px] leading-[1.5] text-[#6f7785]">已检测到有效订购，将使用平台提供的模型服务。无需填写接口地址或 API Key。</p>
          </div>
        )}

        {!subscriptionModelMode && (
          <>
            <div className="mx-auto mb-[26px] flex h-[43px] w-[184px] rounded-full bg-[#dedede] p-[5px] text-sm text-[#858585]">
              {Object.entries(typeDefaults).map(([key, value]) => (
                <span
                  key={key}
                  role="tab"
                  aria-selected={modelType === key}
                  className={`flex h-full w-1/2 cursor-pointer select-none items-center justify-center rounded-[18px] ${modelType === key ? "bg-white text-[#444] shadow-[0_1px_5px_rgba(0,0,0,0.05)]" : ""}`}
                  onClick={() => setModelType(key)}
                >
                  {value.label}
                </span>
              ))}
            </div>

            <div className="mx-auto w-full max-w-[440px]">
              {[
                { id: "modelId", label: "模型 ID", placeholder: "例如：deepseek-v4-pro", value: manualModel.modelId, key: "modelId" },
                { id: "baseUrl", label: "接口地址", placeholder: current.baseUrl || "https://api.example.com/v1", value: manualModel.baseUrl, key: "baseUrl" },
                { id: "apiKey", label: "API Key", placeholder: "sk-...", value: manualModel.apiKey, key: "apiKey", type: "password" },
              ].map((field) => (
                <div key={field.key} className="my-2.5 grid grid-cols-[82px_1fr] items-center gap-2.5">
                  <label htmlFor={field.id} className="text-right text-[13px] text-[#444]">{field.label}</label>
                  <input
                    id={field.id}
                    type={field.type || "text"}
                    className="h-9 rounded-md bg-field px-3 text-sm text-[#555] outline-none focus:bg-white focus:ring-1 focus:ring-brand"
                    placeholder={field.placeholder}
                    value={field.value}
                    onChange={(event) => setManualModel((prev) => ({ ...prev, [field.key]: event.target.value.trim() }))}
                  />
                </div>
              ))}
              <div className="col-span-2 mt-1 text-xs text-branddeep">
                {manualModel.apiKey ? "已填写 API Key。" : "请选择 API 类型，并填写模型 ID、接口地址和 API Key。"}
              </div>
            </div>
          </>
        )}

        {subscriptionInfo && (
          <div className="mx-auto mt-4 flex min-h-[40px] items-center justify-center gap-3">
            <Button
              size="sm"
              className="min-w-[150px]"
              onClick={() => {
                setSubscriptionModelMode(true);
                toast.show("已选择订阅模型");
              }}
            >
              使用订阅模型
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setSubscriptionModelMode(false);
                if (!subscriptionActive) toast.show("当前没有生效的订阅，请填写手动模型配置");
              }}
            >
              手动填写模型
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

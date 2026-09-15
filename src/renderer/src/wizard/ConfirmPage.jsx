/** 向导确认页：对照 2.0 设计稿 —— 居中品牌区、加宽摘要卡、黑色"保存并启动"胶囊按钮。 */
import React, { useEffect, useState } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";
import { configuredChannelNames } from "../channels.js";

export default function ConfirmPage({ context }) {
  const { publicConfig, modelType, manualModel, subscriptionModelMode, chosenSubscriptionModel, saveAndStart } = context;
  const typeDefaults = publicConfig?.models?.typeDefaults || {};
  const currentType = typeDefaults[modelType] || typeDefaults.openai;
  const modelText = subscriptionModelMode
    ? `订阅模型（Coding Plan）${chosenSubscriptionModel ? ` · ${chosenSubscriptionModel}` : ""}`
    : `${currentType.label} / ${manualModel.modelId || "未填写"}`;

  // 聊天工具按"已配置完成"实时取（扫码绑上/凭据填全），向导里只选中没配置的不列进来；
  // 页面可见期间持续刷新，回 BOT 页补配后回来立刻就是最新名单。
  const [toolText, setToolText] = useState("读取中...");
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const summary = await desktopApi.channels.summary();
        if (alive) setToolText(configuredChannelNames(summary).join("、") || "暂不接入");
      } catch { if (alive) setToolText("暂不接入"); }
    };
    void refresh();
    const timer = setInterval(refresh, timing.channels.statusRefreshIntervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-page px-6">
      <h1 className="text-[32px] font-extrabold leading-none tracking-[-1px] text-ink">
        Zgy<em className="not-italic text-logo">Claw</em>
      </h1>
      <p className="mb-[40px] mt-[24px] text-[22px] font-medium text-title">
        请确认以下配置，点击完成后会保存到U 盘并启动。
      </p>

      <div className="w-full max-w-[620px] rounded-[12px] bg-panel px-[64px] py-[30px]">
        {[
          { label: "AI 模型", value: modelText },
          { label: "聊天工具", value: toolText },
          { label: "数据存储", value: "U盘 data/.openclaw 目录" },
          { label: "拔出保护", value: "检测到 U 盘移除应停止运行" },
        ].map((row) => (
          <div key={row.label} className="my-[13px] grid grid-cols-[96px_minmax(0,1fr)] items-center gap-[24px] text-[15px]">
            <span className="font-bold text-title">{row.label}</span>
            <b className="truncate font-semibold text-faint">{row.value}</b>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="mt-[44px] h-[56px] w-[340px] rounded-full bg-ink text-[19px] font-medium text-white transition hover:opacity-90"
        onClick={() => saveAndStart()}
      >
        保存并启动
      </button>
    </div>
  );
}

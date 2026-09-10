/** 向导确认页：配置摘要卡片（对照设计稿 405px 宽、灰底、无 logo）。 */
import React from "react";

const TOOL_NAMES = {
  wecom: "企业微信",
  feishu: "飞书 / Lark",
  qqbot: "QQ 机器人",
  "dingtalk-channel": "钉钉对话",
  wechat: "微信 Clawbot",
  none: "暂不接入",
};

export default function ConfirmPage({ context }) {
  const { publicConfig, modelType, manualModel, subscriptionModelMode, selectedTool } = context;
  const typeDefaults = publicConfig?.models?.typeDefaults || {};
  const currentType = typeDefaults[modelType] || typeDefaults.openai;
  const modelText = subscriptionModelMode
    ? "订阅模型（Coding Plan）"
    : `${currentType.label} / ${manualModel.modelId || "未填写"}`;

  return (
    <div className="flex flex-1 flex-col items-center overflow-auto pt-[72px]">
      <h1 className="mb-[34px] text-lg font-medium text-[#151515]">请确认以下配置，点击完成后会保存到 U 盘并启动。</h1>
      <div className="w-[405px] rounded-[10px] bg-paper px-[42px] py-[22px]">
        {[
          { label: "AI 模型", value: modelText },
          { label: "聊天工具", value: TOOL_NAMES[selectedTool] || "暂不接入" },
          { label: "数据存储", value: "U 盘 data 目录" },
          { label: "拔出保护", value: "检测到 U 盘移除停止运行" },
        ].map((row) => (
          <div key={row.label} className="my-2.5 grid grid-cols-[82px_minmax(0,1fr)] items-center gap-[18px] text-sm">
            <span className="font-semibold text-[#222]">{row.label}</span>
            <b className="truncate font-semibold text-[#858585]">{row.value}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

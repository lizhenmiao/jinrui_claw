/**
 * 向导 BOT 页：左侧 74px 通道工具栏 + 右侧灰色工作区（固定行高 + 底部链接行），
 * 对照设计稿：内容区直角、灰面内滚动，通道面板无边框直接落在灰面上。
 */
import React from "react";
import { ChannelPanel } from "../components/ChannelPanels.jsx";

const TOOLS = [
  { id: "wecom", name: "企业微信", icon: "wecom.png" },
  { id: "feishu", name: "飞书 / Lark", icon: "feishu.png" },
  { id: "qqbot", name: "QQ 机器人", icon: "qq.png" },
  { id: "dingtalk-channel", name: "钉钉对话", icon: "dingtalk.png" },
  { id: "wechat", name: "微信 Clawbot", icon: "wechat.png" },
  { id: "none", name: "暂不接入", icon: "companion.png" },
];

export default function BotPage({ context }) {
  const { selectedTool, setSelectedTool, setPage, toast } = context;

  return (
    <div className="grid flex-1 grid-cols-[74px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_42px] overflow-hidden">
      <aside className="row-span-2 flex w-[74px] flex-col items-center gap-2.5 overflow-y-auto py-6">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`flex h-[58px] w-[74px] flex-col items-center justify-center rounded-[10px] px-[5px] py-2 ${selectedTool === tool.id ? "bg-[#e8e8e8]" : "hover:bg-[#f2f2f2]"}`}
            onClick={() => setSelectedTool(tool.id)}
          >
            <img src={`assets/${tool.icon}`} alt="" className="h-11 w-11 object-contain" />
          </button>
        ))}
      </aside>
      <main className="mx-0 mt-6 min-w-0 overflow-hidden border border-[rgba(0,0,0,0.10)] bg-[#f2f2f2]">
        <div className="h-full overflow-y-auto px-8 py-7">
          <ChannelPanel toolId={selectedTool} toast={toast} plain />
        </div>
      </main>
      <div className="col-start-2 flex h-[42px] flex-none items-center justify-center gap-2 bg-white text-sm text-[#666]">
        查看 <a href="#" onClick={(event) => event.preventDefault()} className="text-link">接入文档</a>
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setSelectedTool("none");
            setPage("confirm");
          }}
        >
          暂不接入，跳过
        </button>
      </div>
    </div>
  );
}

/**
 * 通道面板工作区：左侧通道图标栏 + 右侧灰面面板区（对照 2.0 设计稿 BOT 页布局）。
 * 向导 BOT 页与运行页"通道设置"共用；官方文档地址由组件自查 app.config.json，footer 由使用方提供（向导放"跳过"链接，运行页放提示文案）。
 * 保存/扫码绑定只写配置，攒出的"待重启"变更在底部统一给"重启生效"按钮，一次应用。
 */
import React, { useEffect, useState } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";
import { CHANNELS, pendingRestartText } from "../channels.js";
import { ChannelPanel } from "./ChannelPanels.jsx";
import { AsyncButton } from "./ui.jsx";

export function ChannelWorkbench({ toast, footer = null, className = "" }) {
  const [selectedTool, setSelectedTool] = useState("wechat");
  const [docs, setDocs] = useState({});
  // 网关运行中且有配置变更待应用时，底部出现"重启生效"按钮（附具体原因）。
  const [gatewayRunning, setGatewayRunning] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [pendingReasons, setPendingReasons] = useState([]);
  // 访问过的面板保持挂载：来回切换通道不清状态（二维码、已填表单、配对列表都留在原处）。
  const [mounted, setMounted] = useState(() => [selectedTool]);

  useEffect(() => {
    setMounted((prev) => (prev.includes(selectedTool) ? prev : [...prev, selectedTool]));
  }, [selectedTool]);

  useEffect(() => {
    // 各通道的官方文档地址（app.config.json 的 channels.docs，可运营覆盖）；读取失败就不显示链接。
    desktopApi.app.getPublicConfig()
      .then((config) => setDocs(config?.channels?.docs || {}))
      .catch(() => { /* 地址拿不到时面板内自然没有文档链接 */ });
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const status = await desktopApi.gateway.status();
        if (!alive) return;
        setGatewayRunning(Boolean(status?.running));
        setPendingRestart(Boolean(status?.pendingRestart));
        setPendingReasons(Array.isArray(status?.pendingReasons) ? status.pendingReasons : []);
      } catch { /* 状态读取失败保持原样 */ }
    };
    void refresh();
    const timer = setInterval(refresh, timing.channels.statusRefreshIntervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  /** 一次重启应用所有待生效的通道配置变更。 */
  const applyChanges = async () => {
    await desktopApi.gateway.restart();
    setPendingRestart(false);
  };

  return (
    <div className={`grid grid-cols-[74px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_42px] overflow-hidden ${className}`}>
      <aside className="row-span-2 flex w-[74px] flex-col items-center gap-2.5 overflow-y-auto py-6">
        {CHANNELS.map((channel) => (
          <button
            key={channel.tool}
            type="button"
            aria-label={channel.name}
            className={`flex h-[62px] w-[62px] items-center justify-center rounded-[14px] ${selectedTool === channel.tool ? "bg-linesoft" : "hover:bg-surface"}`}
            onClick={() => setSelectedTool(channel.tool)}
          >
            <img src={`assets/${channel.icon}`} alt="" className="h-[46px] w-[46px] object-contain" />
          </button>
        ))}
      </aside>
      <main className="mx-0 mt-6 min-w-0 overflow-hidden rounded-[14px] bg-paper">
        <div className="h-full overflow-y-auto px-8 py-6">
          {mounted.map((toolId) => (
            <div key={toolId} className={toolId === selectedTool ? "" : "hidden"}>
              <ChannelPanel toolId={toolId} toast={toast} plain docUrl={docs[toolId]} />
            </div>
          ))}
        </div>
      </main>
      <div className="col-start-2 flex h-[42px] flex-none items-center justify-center gap-2 bg-card text-sm text-muted">
        {footer}
        {pendingRestart && gatewayRunning && (
          <>
            <span className="text-[13px] text-warndeep">{pendingRestartText(pendingReasons)}</span>
            <AsyncButton
              className="h-[30px] rounded-full bg-warn px-4 text-[13px] font-medium text-[#160b00] hover:brightness-105"
              busyText="正在重启..."
              onClick={applyChanges}
            >
              重启生效
            </AsyncButton>
          </>
        )}
      </div>
    </div>
  );
}

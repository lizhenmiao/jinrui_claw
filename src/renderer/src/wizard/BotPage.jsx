/**
 * 向导 BOT 页：对照 2.0 设计稿（Desktop-12）—— 通道面板工作区（ChannelWorkbench）+ 底部"暂不接入，跳过"。
 * 进入页面即预生成微信登录二维码（未绑定过时），并轮询各通道连接状态：
 * 只要有一个平台接入成功，底部"下一步"就会亮起，不必非要点"跳过"。
 */
import React, { useEffect, useRef } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";
import { ChannelWorkbench } from "../components/ChannelWorkbench.jsx";

export default function BotPage({ context }) {
  const { setPage, setBotReady, toast } = context;
  const prewarmed = useRef(false);

  useEffect(() => {
    // 预热登录会话：未绑定时二维码在后台生成；已绑定时也预热，用户点"重新绑定"能立刻出码。
    if (prewarmed.current) return;
    prewarmed.current = true;
    desktopApi.channels.wechat.prewarm().catch(() => { /* 预热失败不打扰用户，面板内可重试 */ });
  }, []);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const summary = await desktopApi.channels.summary();
        if (!alive) return;
        setBotReady(Object.values(summary || {}).some((item) => item?.connected));
      } catch { /* 摘要读取失败保持原状态 */ }
    };
    void refresh();
    const timer = setInterval(refresh, timing.channels.statusRefreshIntervalMs);
    return () => { alive = false; clearInterval(timer); };
  }, [setBotReady]);

  return (
    <ChannelWorkbench
      className="flex-1"
      toast={toast}
      footer={(
        <button type="button" className="text-link" onClick={() => setPage("confirm")}>
          暂不接入，跳过
        </button>
      )}
    />
  );
}

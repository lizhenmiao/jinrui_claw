/**
 * 应用外壳：按配置状态在「配置向导」与「运行页」之间切换，
 * 启动阶段显示加载画面（对照设计稿加载页），启动失败显示错误与重试。
 */
import React, { useEffect, useState } from "react";
import desktopApi from "./api";
import Wizard from "./wizard/Wizard.jsx";
import Runtime from "./runtime/Runtime.jsx";

export default function App() {
  const [phase, setPhase] = useState("loading");
  const [bootError, setBootError] = useState("");
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    desktopApi.app.onBootError((payload) => {
      setBootError(payload?.message || "启动失败");
      setPhase("error");
    });
    (async () => {
      try {
        setConfigured(await desktopApi.config.isConfigured());
        setPhase("ready");
      } catch (error) {
        setBootError(error.message);
        setPhase("error");
      }
    })();
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-white">
        <div className="flex items-center gap-2">
          <img src="assets/logo.png" alt="小龙虾" className="h-16 w-16 object-contain" />
          <strong className="text-[30px] font-extrabold tracking-[-1.2px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></strong>
        </div>
        <div className="mt-1 text-[11px] text-[#888]">便携式 U 盘小龙虾智能协作伙伴</div>
        <div className="mt-7 h-[2px] w-[190px] overflow-hidden bg-[#e6e6e6]">
          <div className="h-full w-1/2 animate-[loadingSlide_1.2s_ease-in-out_infinite] bg-[#333]" />
        </div>
        <style>{`@keyframes loadingSlide{0%{transform:translateX(-90px)}50%{transform:translateX(70px)}100%{transform:translateX(190px)}}`}</style>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-white px-10 text-center">
        <div className="text-2xl font-extrabold text-ink">启动失败</div>
        <pre className="mt-4 max-w-xl whitespace-pre-wrap rounded-lg bg-paper p-4 text-sm text-danger">{bootError}</pre>
        <button
          type="button"
          className="mt-6 rounded-full bg-ink px-7 py-2 text-sm font-semibold text-white"
          onClick={() => window.location.reload()}
        >
          重新加载
        </button>
      </div>
    );
  }

  return configured ? <Runtime /> : <Wizard onConfigured={() => setConfigured(true)} />;
}

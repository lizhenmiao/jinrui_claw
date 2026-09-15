/**
 * 应用外壳：按配置状态在「配置向导」与「运行页」之间切换，
 * 启动阶段显示加载画面（共用 LoadingScreen），启动失败显示错误与重试。
 */
import React, { useEffect, useState } from "react";
import desktopApi from "./api";
import { LoadingScreen } from "./components/LoadingScreen.jsx";
import { setToastPosition } from "./components/ui.jsx";
import Wizard from "./wizard/Wizard.jsx";
import Runtime from "./runtime/Runtime.jsx";

export default function App() {
  const [phase, setPhase] = useState("loading");
  const [bootMessage, setBootMessage] = useState("正在准备运行组件…");
  const [bootError, setBootError] = useState("");
  const [configured, setConfigured] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        // 提示落点由运营配置决定（ui.toastPosition），默认右上角。
        const publicConfig = await desktopApi.app.getPublicConfig().catch(() => null);
        setToastPosition(publicConfig?.ui?.toastPosition);
        setConfigured(await desktopApi.config.isConfigured());
        // 首次运行（本机组件还没热过）把约 1 分钟的冷启动挡在加载页里，
        // 这样进向导后 BOT 页直接有二维码；已热过或已绑定微信号时这一步立刻返回。
        const status = await desktopApi.channels.wechat.status().catch(() => null);
        if (status?.runtimeWarm === false) setBootMessage("首次运行需要准备组件，请稍候…");
        await desktopApi.channels.wechat.warmup().catch(() => null);
        setPhase("ready");
      } catch (error) {
        setBootError(error.message);
        setPhase("error");
      }
    })();
  }, []);

  if (phase === "loading") {
    return <LoadingScreen message={bootMessage} />;
  }

  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-card px-10 text-center">
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

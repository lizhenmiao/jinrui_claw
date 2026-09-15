/**
 * 应用外壳：主进程启动核心（模块解压/授权校验）就绪前显示加载画面（共用 LoadingScreen），
 * 就绪后按配置状态在「配置向导」与「运行页」之间切换；启动失败显示错误页并支持重试。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import desktopApi from "./api.js";
import { LoadingScreen } from "./components/LoadingScreen.jsx";
import { setToastPosition } from "./components/ui.jsx";
import Wizard from "./wizard/Wizard.jsx";
import Runtime from "./runtime/Runtime.jsx";

export default function App() {
  const [phase, setPhase] = useState("loading");
  const [bootMessage, setBootMessage] = useState("正在准备运行组件…");
  const [bootError, setBootError] = useState("");
  const [configured, setConfigured] = useState(false);
  // 界面初始化只跑一次的闸：重试时由错误页复位。
  const uiReadyRef = useRef(false);

  /** 主进程启动就绪后的界面初始化：提示落点、配置状态检查、微信组件预热。 */
  const initUi = useCallback(async () => {
    if (uiReadyRef.current) return;
    uiReadyRef.current = true;
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
  }, []);

  useEffect(() => {
    let alive = true;
    const applyBootState = (state) => {
      if (!alive || !state) return;
      if (state.status === "ready") void initUi();
      if (state.status === "error") {
        setBootError(state.message || "启动失败");
        setPhase("error");
      }
    };
    const unsubscribe = desktopApi.app.onBootState(applyBootState);
    // 页面加载可能晚于启动事件：先查一次当前状态，之后靠事件推进。
    desktopApi.app.getBootState().then(applyBootState).catch(() => {});
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [initUi]);

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
          onClick={() => {
            // 重试：回加载页并复位界面闸，让主进程重跑启动核心（比如 --bind-usb 之后就能过）。
            setPhase("loading");
            setBootError("");
            uiReadyRef.current = false;
            void desktopApi.app.retryBoot();
          }}
        >
          重试
        </button>
      </div>
    );
  }

  return configured ? <Runtime /> : <Wizard onConfigured={() => setConfigured(true)} />;
}

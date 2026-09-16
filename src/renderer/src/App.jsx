/**
 * 应用外壳：主进程启动核心（模块解压/授权校验）就绪前显示加载画面（共用 LoadingScreen），就绪后按配置状态在「配置向导」与「运行页」之间切换。
 * 启动未通过（如未授权）不切页面：加载页停住显示原因，可重试（配合 --bind-usb 闭环）。
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
  // 启动未通过的原因；有值时加载页停住并显示原因（不再进入独立错误页）。
  const [bootFailure, setBootFailure] = useState("");
  const [configured, setConfigured] = useState(false);
  // 界面初始化只跑一次的闸：重试时复位。
  const uiReadyRef = useRef(false);

  /** 主进程启动就绪后的界面初始化：提示落点、配置状态检查。 */
  const initUi = useCallback(async () => {
    if (uiReadyRef.current) return;
    uiReadyRef.current = true;
    try {
      const publicConfig = await desktopApi.app.getPublicConfig().catch(() => null);
      setToastPosition(publicConfig?.ui?.toastPosition);
      setConfigured(await desktopApi.config.isConfigured());
      // 微信组件预热已在启动链里完成（加载页逐步说明在做什么），进向导后 BOT 页直接有码，
      // 不会出现"启动等一次、进 BOT 页再等一次"的两段等待。
      setPhase("ready");
    } catch (error) {
      setBootFailure(error.message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const applyBootState = (state) => {
      if (!alive || !state) return;
      // 启动阶段的说明文案（例如首次解压组件）直接显示在加载页上，避免长时间白等。
      if (state.status === "booting") setBootMessage(state.message || "");
      if (state.status === "ready") void initUi();
      if (state.status === "error") setBootFailure(state.message || "启动失败");
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
    return (
      <LoadingScreen
        message={bootMessage}
        failure={bootFailure || null}
        onRetry={bootFailure
          ? () => {
              // 重试：清掉失败提示并复位界面闸，让主进程重跑启动核心（--bind-usb 之后就能过）。
              setBootFailure("");
              uiReadyRef.current = false;
              void desktopApi.app.retryBoot();
            }
          : undefined}
      />
    );
  }

  return configured ? <Runtime /> : <Wizard onConfigured={() => setConfigured(true)} />;
}

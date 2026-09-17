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
  // 启动失败的错误码：LICENSE_REQUIRED 表示需要用户输入授权码，加载页据此换成激活表单。
  const [bootCode, setBootCode] = useState("");
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
      // 运行组件的解压与微信预热都在后台进行，不挡这一步：向导前几页（登录、订阅、选模型）用不到它们，
      // 等用户走到 BOT 页时多半已经备好，没备好也由面板自己显示进度。
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
      if (state.status === "error") {
        setBootFailure(state.message || "启动失败");
        setBootCode(state.code || "");
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

  /** 重跑启动核心：清掉失败提示并复位界面闸（绑定授权码之后、或用户手动重试时调用）。 */
  const retryBoot = useCallback(() => {
    setBootFailure("");
    setBootCode("");
    uiReadyRef.current = false;
    void desktopApi.app.retryBoot();
  }, []);

  /** 需要用户输入授权码：本地文件缺失/与盘不符、或后台明确拒绝授权码，都属于这一类。 */
  const needsLicense = bootCode === "LICENSE_REQUIRED";

  if (phase === "loading") {
    return (
      <LoadingScreen
        message={bootMessage}
        failure={bootFailure || null}
        activation={needsLicense ? {
          message: bootFailure,
          onSubmit: async (licenseKey) => {
            const result = await desktopApi.license.bind({ licenseKey });
            // 绑定成功后主进程重跑启动核心（本地授权文件与后台记录此时都已就位）。
            if (result?.ok) retryBoot();
            return result;
          },
        } : null}
        onRetry={bootFailure
          ? () => retryBoot()
          : undefined}
      />
    );
  }

  return configured ? <Runtime /> : <Wizard onConfigured={() => setConfigured(true)} />;
}

/**
 * 向导登录引导页：对照 2.0 设计稿逐项还原 —— 内容块整体垂直居中，
 * 左上双行标题、右上龙虾家族合影（压横幅上沿）、白色横幅（ZgyClaw + 状态按钮组）、
 * 三行特性列表。比例按 1440×1024 设计稿等比换算。
 */
import React, { useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";
import { useToast } from "../components/ui.jsx";

const LOGIN_FEATURES = [
  { icon: "login-deploy.png", title: "一键部署，开箱即用", desc: "告别繁琐的环境搭建和配置流程。一键部署，快速接入聊天工具。" },
  { icon: "login-native.png", title: "原生体验，能力无损", desc: "提供原版 OpenClaw 完整能力，独特个性、长期记忆，内置多个插件。" },
  { icon: "login-security.png", title: "企业级安全，数据不离场", desc: "数据全程在U盘内流转，权限可控、授权透明、安全合规，放心用 AI。" },
];

/** 授权结果轮询：间隔与最长等待时间统一取自 src/shared/timing.json。 */
const LOGIN_POLL_INTERVAL_MS = timing.login.pollIntervalMs;
const LOGIN_POLL_TIMEOUT_MS = timing.login.waitTimeoutMs;

export default function LoginPage({ context }) {
  const { setPage, setAccount, checkSubscriptionAfterLogin } = context;
  const toast = useToast();
  const [phase, setPhase] = useState("idle"); // idle | waiting | done
  const [statusText, setStatusText] = useState("");
  const [fallbackUrl, setFallbackUrl] = useState("");
  const pollTimer = useRef(null);

  useEffect(() => () => clearInterval(pollTimer.current), []);

  useEffect(() => {
    // 进页面校验收据：本地有会话时再用一次真实请求确认仍然有效，
    // 已被服务端吊销的会话会在这里被清除并回到"立即登录"。
    (async () => {
      try {
        const status = await desktopApi.account.status();
        if (!status?.loggedIn) return;
        try {
          await desktopApi.account.subscription();
          setPhase("done");
        } catch (error) {
          if (/登录已失效|请重新登录/.test(String(error.message || ""))) {
            setPhase("idle");
            setStatusText("登录已失效，请重新登录。");
            return;
          }
          // 其它错误（如无订阅）说明会话本身有效。
          setPhase("done");
        }
      } catch { /* 状态读取失败保持默认 */ }
    })();
  }, []);

  const startLogin = async () => {
    setPhase("waiting");
    setFallbackUrl("");
    setStatusText("正在打开平台登录页面...");
    const startedAt = Date.now();
    try {
      const result = await desktopApi.account.login();
      let opened = false;
      try {
        await desktopApi.app.openExternal(result.authorizationUrl);
        opened = true;
      } catch { /* 打开失败时展示手动链接 */ }
      setFallbackUrl(result.authorizationUrl);
      setStatusText(opened ? "登录页面已在默认浏览器打开，请完成授权。" : "浏览器打开失败，请点击下方链接手动打开。");
      clearInterval(pollTimer.current);
      const deadline = Date.now() + LOGIN_POLL_TIMEOUT_MS;
      pollTimer.current = setInterval(async () => {
        try {
          // 浏览器侧取消授权或回调失败：回到待登录状态并停留在本页。
          const authResult = await desktopApi.account.authResult?.();
          if (authResult && authResult.at >= startedAt && authResult.ok === false) {
            clearInterval(pollTimer.current);
            setPhase("idle");
            setFallbackUrl("");
            setStatusText(
              authResult.reason === "access_denied"
                ? "你取消了授权，可重新点击立即登录。"
                : "授权未完成，可重新点击立即登录。",
            );
            return;
          }
          const status = await desktopApi.account.status();
          if (status?.loggedIn) {
            clearInterval(pollTimer.current);
            setAccount({ loggedIn: true, user: status.user });
            setPhase("done");
            setStatusText("登录成功，正在检查订阅状态...");
            await checkSubscriptionAfterLogin();
          } else if (Date.now() >= deadline) {
            clearInterval(pollTimer.current);
            // 放弃等待时释放本地回调监听，避免回调端口一直被占用。
            void desktopApi.account.cancelLogin?.().catch(() => {});
            setPhase("idle");
            setFallbackUrl("");
            setStatusText("未检测到授权结果，可重新点击立即登录。");
          }
        } catch { /* 轮询失败继续等待 */ }
      }, LOGIN_POLL_INTERVAL_MS);
    } catch (error) {
      setPhase("idle");
      setStatusText(`登录失败：${error.message}`);
    }
  };

  /** 取消等待：停止轮询并关闭回调监听，回到待登录状态。 */
  const cancelLogin = () => {
    clearInterval(pollTimer.current);
    setPhase("idle");
    setFallbackUrl("");
    setStatusText("已取消登录，可重新点击立即登录。");
    desktopApi.account.cancelLogin?.().catch(() => {});
  };

  const goCustomModel = () => {
    context.setSubscriptionModelMode(false);
    setPage("model");
  };

  const goModelPage = async () => {
    await checkSubscriptionAfterLogin();
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-page px-6 pt-[90px]">
      <div className="w-full max-w-[860px]">
        <div className="relative">
          <div className="text-[17px] font-medium leading-[21px] text-title">
            登录<span className="text-link">中广云</span>一键配置AI模型
            <br />
            你也可以添加自己的模型。
          </div>

          <img
            src="assets/companion.png"
            alt="ZgyClaw 龙虾家族"
            className="pointer-events-none absolute right-[44px] top-[-80px] h-[175px] w-[372px] object-contain object-bottom"
          />

          <div className="mt-[38px] flex h-[95px] w-full items-center justify-between rounded-[12px] bg-card pl-[50px] pr-[20px] shadow-[0_1px_6px_rgba(0,0,0,0.03)]">
            <b className="text-[37px] font-extrabold tracking-[-1px] text-ink">
              Zgy<em className="not-italic text-logo">Claw</em>
            </b>
            <div className="flex items-center gap-[13px]">
              <button
                type="button"
                className="h-[43px] rounded-[8px] border border-line bg-card px-[22px] text-[14px] font-medium text-title hover:bg-paper"
                onClick={goCustomModel}
              >
                自定义模型
              </button>
              {phase === "idle" && (
                <button
                  type="button"
                  className="h-[43px] rounded-[8px] bg-ink px-[24px] text-[14px] font-medium text-white hover:opacity-90"
                  onClick={startLogin}
                >
                  立即登录
                </button>
              )}
              {phase === "waiting" && (
                <>
                  <button type="button" disabled className="flex h-[43px] items-center gap-2 rounded-[8px] bg-line px-[24px] text-[14px] font-medium text-white">
                    登录验证
                    <span className="inline-block h-[13px] w-[13px] animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  </button>
                  <button type="button" onClick={cancelLogin} className="text-[13px] text-subtle hover:text-body">
                    取消
                  </button>
                </>
              )}
              {phase === "done" && (
                <button
                  type="button"
                  className="h-[43px] rounded-[8px] bg-ink px-[24px] text-[14px] font-medium text-white hover:opacity-90"
                  onClick={goModelPage}
                >
                  设置模型
                </button>
              )}
            </div>
          </div>
        </div>

        {fallbackUrl && (
          <div className="mt-[10px] text-right text-[12px] text-subtle">
            {statusText}
            <a
              href={fallbackUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                desktopApi.app.openExternal(fallbackUrl).catch(() => {});
              }}
              className="ml-1 text-link"
            >
              手动打开登录页面
            </a>
          </div>
        )}

        <div className="mt-[46px] flex flex-col gap-[23px]">
          {LOGIN_FEATURES.map((feature) => (
            <div key={feature.title}>
              <b className="flex items-center gap-[9px] text-[14px] font-semibold text-title">
                <img src={`assets/${feature.icon}`} alt="" className="h-[17px] w-[17px] object-contain" />
                {feature.title}
              </b>
              <p className="mt-[6px] pl-[26px] text-[10.5px] leading-[1.65] text-subtle">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 向导登录页：跳转系统浏览器完成 OAuth，登录后自动检查订阅（对照设计稿定位）。 */
import React, { useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { Button } from "../components/ui.jsx";

const LOGIN_FEATURES = [
  { icon: "login-deploy.png", title: "一键部署，开箱即用", desc: "告别繁琐的环境搭建和配置流程，一键登录，快速接入聊天工具。" },
  { icon: "login-native.png", title: "原生体验，能力无损", desc: "提供原生 OpenClaw 完整能力，独特个性、长记忆，内置多个插件。" },
  { icon: "login-security.png", title: "企业级安全，数据不离场", desc: "数据全程在 U 盘内流转，权限可控、授权透明、安全合规。" },
];

export default function LoginPage({ context }) {
  const { setPage, setAccount, setSubscriptionActive, toast } = context;
  const [statusText, setStatusText] = useState("登录中广云后可一键配置 AI 模型。");
  const [fallbackUrl, setFallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const pollTimer = useRef(null);

  useEffect(() => () => clearInterval(pollTimer.current), []);

  const afterLoginCheck = async () => {
    setStatusText("登录成功，正在检查订阅状态...");
    try {
      const result = await desktopApi.account.subscription();
      if (isSubscriptionActive(result)) {
        setSubscriptionActive(true);
        try {
          await desktopApi.account.syncSubscriptionModel();
          setPage("bot");
          return;
        } catch (error) {
          toast.show(`订阅模型同步失败：${error.message}`, "err");
        }
      }
      setPage("subscription");
    } catch {
      setPage("subscription");
      setStatusText("订购状态查询失败，请稍后重试。");
    }
  };

  const startLogin = async () => {
    setBusy(true);
    setFallbackUrl("");
    setStatusText("正在打开平台登录页面...");
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
      let tries = 0;
      pollTimer.current = setInterval(async () => {
        tries += 1;
        try {
          const status = await desktopApi.account.status();
          if (status?.loggedIn) {
            clearInterval(pollTimer.current);
            setAccount({ loggedIn: true, user: status.user });
            await afterLoginCheck();
          } else if (tries >= 80) {
            clearInterval(pollTimer.current);
            setStatusText("登录等待超时，请重新点击登录。");
          }
        } catch { /* 轮询失败继续等待 */ }
      }, 1500);
    } catch (error) {
      setStatusText(`登录失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const customModel = () => {
    context.setSubscriptionModelMode(false);
    setPage("model");
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="relative mx-auto min-h-[520px] w-full max-w-[950px] px-16 pb-10 pt-16">
        <div className="absolute inset-x-[44px] top-[69px] h-[127px] rounded-[14px] border border-[rgba(128,128,128,0.12)] bg-[rgba(128,128,128,0.12)]" />
        <div className="absolute left-16 top-[58px] z-10 text-[18px] leading-[1.5] text-[#222]">
          登录<span className="text-link">中广云</span>一键配置AI模型
          <br />你也可以添加自己的模型。
        </div>
        <img src="assets/companion.png" alt="ZgyClaw 智能伙伴" className="absolute right-[42px] top-[10px] h-[170px] w-[390px] object-contain object-right" />
        <div className="absolute left-16 top-[151px] z-10 text-[30px] font-extrabold text-ink">
          Zgy<em className="not-italic text-claw">Claw</em>
        </div>
        <div className="absolute right-[62px] top-[184px] z-10 flex gap-3">
          <Button variant="secondary" size="sm" onClick={customModel}>自定义模型</Button>
          <Button size="sm" disabled={busy} onClick={startLogin}>立即登录</Button>
        </div>
        <div className="absolute right-[62px] top-[221px] z-10 w-[334px] text-center text-sm text-[#666]">{statusText}</div>
        {fallbackUrl && (
          <div className="absolute right-[62px] top-[250px] z-10 w-[334px] text-center text-xs text-link">
            未自动跳转？
            <a
              href={fallbackUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.preventDefault();
                desktopApi.app.openExternal(fallbackUrl).catch(() => {});
              }}
            >
              点击这里手动打开登录页面
            </a>
          </div>
        )}
        <div className="mt-[232px] grid grid-cols-3 gap-7 px-2">
          {LOGIN_FEATURES.map((feature) => (
            <div key={feature.title} className="flex min-h-[84px] flex-col gap-[7px]">
              <b className="flex items-center gap-2 whitespace-nowrap text-[15px] font-medium text-[#333]">
                <img src={`assets/${feature.icon}`} alt="" className="h-5 w-5 flex-none object-contain" />
                {feature.title}
              </b>
              <span className="text-xs leading-[1.55] text-[#888]">{feature.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 订阅接口返回结构兼容归一化：active/subscribed/状态串/到期时间。 */
export function isSubscriptionActive(result) {
  const data = result?.data && typeof result.data === "object" ? result.data : result || {};
  if (data.active === true || data.subscribed === true || data.is_active === true) return true;
  const status = String(data.status || data.subscription_status || data.state || "").toLowerCase();
  if (["active", "trial", "paid", "subscribed", "valid"].includes(status)) return true;
  const end = data.end_at || data.expires_at || data.expire_at;
  return Boolean(end && Date.parse(end) > Date.now());
}

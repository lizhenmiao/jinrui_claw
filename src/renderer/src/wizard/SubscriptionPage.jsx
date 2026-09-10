/** 向导订阅页：展示套餐、打开订阅页面并轮询订购状态。 */
import React, { useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { Button } from "../components/ui.jsx";
import { isSubscriptionActive } from "./LoginPage.jsx";

export default function SubscriptionPage({ context }) {
  const { publicConfig, setSubscriptionActive, setPage, toast } = context;
  const plans = publicConfig?.subscription?.plans || [];
  const [statusText, setStatusText] = useState("");
  const pollTimer = useRef(null);

  useEffect(() => () => clearInterval(pollTimer.current), []);

  const checkOnce = async () => {
    try {
      const result = await desktopApi.account.subscription();
      if (isSubscriptionActive(result)) {
        setSubscriptionActive(true);
        clearInterval(pollTimer.current);
        setStatusText("订购状态有效，正在同步订阅模型...");
        try {
          await desktopApi.account.syncSubscriptionModel();
          toast.show("订购状态有效，正在进入 BOT 配置");
          setPage("bot");
        } catch (error) {
          setStatusText("订购状态有效，但订阅模型同步失败，请稍后重试。");
          toast.show(`订阅模型同步失败：${error.message}`, "err");
        }
        return;
      }
      setStatusText("已打开 Zgy 订阅页面，请完成订购；客户端会自动检查订阅状态。");
    } catch (error) {
      setStatusText(`订购状态查询失败：${error.message}`);
    }
  };

  const openPlans = async () => {
    try {
      const status = await desktopApi.account.status();
      if (!status?.loggedIn) {
        toast.show("请先登录平台账号，再进行订阅。", "err");
        return;
      }
      const origin = String(publicConfig?.oauth?.authorizationOrigin || "").replace(/\/+$/, "");
      const suffix = publicConfig?.subscription?.plansPageSuffix || "#plans";
      await desktopApi.app.openExternal(`${origin}/${suffix}`);
      setStatusText("已打开 Zgy 订阅页面，请完成订购；客户端会自动检查订阅状态。");
      clearInterval(pollTimer.current);
      pollTimer.current = setInterval(checkOnce, 2000);
      await checkOnce();
    } catch (error) {
      setStatusText(`订阅页面打开失败：${error.message}`);
    }
  };

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[700px] px-8 pb-8 pt-10 text-center">
        <div className="mb-3 flex items-center justify-center gap-2">
          <img src="assets/logo.png" alt="小龙虾" className="h-[54px] w-[54px] object-contain" />
          <strong className="text-[30px] font-extrabold tracking-[-1.2px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></strong>
        </div>
        <h1 className="mb-[30px] text-[23px] font-medium text-[#151515]">要开始使用，您需要先订阅 Coding Plan</h1>

        <div className="mx-auto grid w-full grid-cols-3 gap-[26px]">
          {plans.map((plan, index) => (
            <article
              key={`${plan.name}-${index}`}
              className={`relative flex min-h-[166px] flex-col gap-2 rounded-[9px] bg-white text-left shadow-[0_3px_15px_rgba(0,0,0,0.04)] ${plan.popular ? "border-2 border-hot px-[18px] pb-[15px] pt-[30px]" : "px-5 pb-[17px] pt-8"}`}
            >
              {plan.popular && (
                <label className="absolute -left-0.5 -right-0.5 -top-0.5 rounded-t-[9px] bg-hot py-0.5 text-center text-[10px] leading-6 text-white">
                  最受欢迎
                </label>
              )}
              <b className="text-sm font-medium text-[#222]">{plan.name}</b>
              <strong className="text-base font-medium text-[#222]">
                {plan.price} <small className="text-[11px] font-normal text-[#888]">{plan.period}</small>
              </strong>
              <span className="text-[10px] text-[#999]">{plan.desc}</span>
              <Button variant="secondary" size="sm" className="mt-auto w-full" onClick={openPlans}>立即订阅</Button>
            </article>
          ))}
        </div>

        <div className="mt-3 block w-full min-h-7 text-xs leading-[1.4] text-okdeep">{statusText}</div>
        <div className="mx-auto mt-2.5 inline-block rounded-[10px] border border-[#e4e4e4] bg-paper px-[14px] py-[7px]">
          <span className="whitespace-nowrap text-[10px] leading-[1.5] text-[#999]">
            定价与权益说明详见 <a href="#" onClick={(event) => event.preventDefault()} className="text-link">产品文档</a>
          </span>
        </div>
      </div>
    </div>
  );
}

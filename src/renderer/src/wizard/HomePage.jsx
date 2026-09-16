/**
 * 向导首页：对照 2.0 设计稿 1:1 还原 —— 居中品牌区、龙虾吉祥物横幅（Coding Plan 徽章）、三张能力卡片、黑色"快速配置"主按钮与服务规则勾选。
 */
import React, { useState } from "react";
import { useToast } from "../components/ui.jsx";

const FEATURES = [
  { icon: "feature-deploy.png", title: "一键部署，开箱即用", desc: "快速配置，点击即可拥有一台专属便携智能体，安全省心。" },
  { icon: "feature-skills.png", title: "内置精选 Skills，生来强大", desc: "为你的龙虾预装了优质技能包，领到手就是一只\"满级龙虾\"，即刻释放AI生产力。" },
  { icon: "feature-models.png", title: "多模型可选，自由扩展", desc: "也可自由选择GLM、Minimax、Kimi 等最新主流模型" },
];

export default function HomePage({ context }) {
  const { setPage } = context;
  const toast = useToast();
  const [agreed, setAgreed] = useState(false);

  const startConfig = () => {
    if (!agreed) {
      toast.show("请先阅读并同意 ZgyClaw 服务规则", "err");
      return;
    }
    setPage("login");
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-page px-6 pt-[60px]">
      <div className="w-full max-w-[860px] text-center">
        <h1 className="text-[32px] font-extrabold leading-none tracking-[-1px] text-ink">
          Zgy<em className="not-italic text-logo">Claw</em>
        </h1>
        <p className="mb-[30px] mt-[14px] text-[18px] font-medium text-title">7*24小时在线的专属便携试智能伙伴</p>

        <div className="relative mx-auto mb-[42px] w-full rounded-[14px] bg-tint">
          <img
            src="assets/banner.png"
            alt="ZgyClaw 智能伙伴"
            className="pointer-events-none absolute left-[16px] top-[-68px] h-[190px] w-[215px] object-contain"
          />
          <div className="py-[26px] pl-[240px] pr-8 text-left">
            <div className="flex items-center gap-3">
              <b className="text-[17px] font-bold text-title">配置 ZgyClaw</b>
              <span className="rounded-[6px] border border-brand/40 bg-card/70 px-2 py-[3px] text-[12px] text-branddeep">
                Coding Plan 用户一键配置
              </span>
            </div>
            <p className="mt-[10px] text-[14px] leading-[1.6] text-subtle">
              零门槛即刻唤醒个人助手，即插即用，随时随地对话，
              <a
                href="#"
                onClick={(event) => event.preventDefault()}
                className="text-[15px] font-medium text-link"
              >
                了解更多
              </a>
            </p>
          </div>
        </div>

        <div className="mx-auto mb-[34px] grid w-full grid-cols-3 gap-[26px]">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="flex min-h-[186px] flex-col rounded-[12px] bg-card px-[26px] py-[28px] text-left shadow-[0_4px_18px_rgba(0,0,0,0.04)]">
              <span className="mb-[18px] flex h-[30px] w-[30px] items-center justify-center">
                <img src={`assets/${feature.icon}`} alt="" className="h-full w-full object-contain" />
              </span>
              <strong className="mb-[10px] text-[17px] font-bold text-title">{feature.title}</strong>
              <span className="text-[12.5px] leading-[1.7] text-subtle">{feature.desc}</span>
            </article>
          ))}
        </div>

        <button
          type="button"
          onClick={startConfig}
          className="mx-auto block h-[58px] w-[356px] rounded-full bg-ink text-[19px] font-medium text-white transition hover:opacity-90"
        >
          快速配置
        </button>

        <label className="mt-[22px] flex cursor-pointer items-center justify-center gap-[6px] text-[13px] text-body">
          <input
            type="checkbox"
            className="h-[14px] w-[14px] accent-ink"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
          />
          我已阅读并同意
          <a href="#" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }} className="text-link">
            ZgyClaw 服务规则
          </a>
        </label>
      </div>
    </div>
  );
}

/** 向导首页：产品介绍与快速配置入口（对照设计稿首页布局）。 */
import React from "react";
import { Button } from "../components/ui.jsx";

const FEATURES = [
  { icon: "feature-deploy.png", title: "一键部署，开箱即用", desc: "快速配置，点击即可拥有一台专属便携智能伙伴，安全省心。" },
  { icon: "feature-skills.png", title: "内置精选 Skills，生产强大", desc: "为你的龙虾预装了优质技能，到手就是一只「满级龙虾」。" },
  { icon: "feature-models.png", title: "多模型可选，自由扩展", desc: "也可自由选择 GLM、MiniMax、Kimi 等服务商模型。" },
];

export default function HomePage({ context }) {
  const { setPage, toast } = context;
  const [agreed, setAgreed] = React.useState(false);

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[670px] px-8 pb-4 pt-10 text-center">
        <div className="mb-3 flex items-center justify-center gap-2">
          <img src="assets/logo.png" alt="小龙虾" className="h-[54px] w-[54px] object-contain" />
          <strong className="text-[30px] font-extrabold tracking-[-1.2px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></strong>
        </div>
        <h1 className="mb-[26px] text-[23px] font-medium text-[#151515]">7*24小时在线的专属便携式智能伙伴</h1>

        <div className="mx-auto mb-[34px] flex min-h-[76px] w-full items-center gap-[22px] rounded-[10px] bg-tint px-[26px]">
          <img src="assets/banner.png" alt="小龙虾" className="h-[112px] w-[150px] self-end object-contain" />
          <div className="flex flex-col gap-[9px] text-left text-[13px] text-[#5d5d5d]">
            <b className="font-medium text-[#444]">配置 ZgyClaw</b>
            <span>零门槛即刻唤醒个人助手，即插即用，随时随地对话，<a href="#" onClick={(event) => event.preventDefault()} className="text-link">了解更多</a></span>
          </div>
        </div>

        <div className="mx-auto mb-5 grid w-full grid-cols-3 gap-[22px]">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="flex min-h-[126px] flex-col gap-2 rounded-[9px] bg-white p-[14px] text-left shadow-[0_2px_14px_rgba(0,0,0,0.04)]">
              <b className="mb-1 flex h-[46px] w-[46px] items-center justify-center">
                <img src={`assets/${feature.icon}`} alt="" className="h-8 w-8 object-contain" />
              </b>
              <strong className="text-[15px] font-medium text-[#222]">{feature.title}</strong>
              <span className="text-[11px] leading-[1.5] text-[#9199a5]">{feature.desc}</span>
            </article>
          ))}
        </div>

        <Button size="lg" className="mx-auto mb-3 block w-[220px] text-[18px]" onClick={() => {
          if (!agreed) {
            toast.show("请先阅读并同意 ZgyClaw 服务规则", "err");
            return;
          }
          setPage("login");
        }}>
          快速配置
        </Button>
        <label className="flex items-center justify-center gap-[5px] text-xs text-[#888]">
          <input type="checkbox" className="accent-ink" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          我已阅读并同意 <a href="#" onClick={(event) => event.preventDefault()} className="text-link">ZgyClaw 服务规则</a>
        </label>
      </div>
    </div>
  );
}

/**
 * 加载画面（对照 2.0 设计稿加载页）：启动引导与长耗时操作共用。
 * overlay 为 true 时以整窗遮罩呈现，用于盖住"要等一会儿"的操作（首次冷启动、插件解压等）。
 * failure 有值时表示启动未通过（如未授权）：进度条换成原因说明，停在加载页上可重试。
 */
import React from "react";

export function LoadingScreen({ message = "", overlay = false, failure = null, onRetry = null }) {
  return (
    <div className={`${overlay ? "fixed inset-0 z-50" : "h-full"} flex flex-col items-center justify-center bg-card`}>
      <div className="flex items-center gap-[14px]">
        <img src="assets/logo.png" alt="小龙虾" className="h-[72px] w-auto object-contain" />
        <span className="text-[40px] font-extrabold tracking-[-1px] text-ink">
          Zgy<em className="not-italic text-logo">Claw</em>
        </span>
      </div>
      <div className="mt-[6px] pl-[56px] text-[15px] text-subtle">便携式 U 盘小龙虾智能协作伙伴</div>
      {failure ? (
        <>
          <div className="mt-[38px] max-w-[480px] rounded-[10px] bg-warnbg px-[20px] py-[12px] text-center text-[13px] leading-[1.7] text-warndeep">{failure}</div>
          {onRetry && (
            <button type="button" className="mt-[14px] text-[14px] text-link" onClick={onRetry}>
              重试
            </button>
          )}
        </>
      ) : (
        <div className="mt-[38px] h-[2px] w-[340px] overflow-hidden bg-[#e6e6e6]">
          <div className="h-full w-1/2 animate-[loading-slide_1.4s_linear_infinite] bg-[#333]" />
        </div>
      )}
      {message && !failure && <div className="mt-[18px] max-w-[420px] text-center text-[14px] text-subtle">{message}</div>}
    </div>
  );
}

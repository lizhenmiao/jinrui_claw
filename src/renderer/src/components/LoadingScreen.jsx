/**
 * 加载画面（对照 2.0 设计稿加载页）：启动引导与长耗时操作共用。
 * overlay 为 true 时以整窗遮罩呈现，用于盖住"要等一会儿"的操作（首次冷启动、插件解压等）。
 * failure 有值时表示启动未通过（如未授权）：进度条换成原因说明，停在加载页上可重试。
 * activation 有值时换成"输入授权码"表单：U 盘还没绑定授权时，用户在界面上填码即可完成绑定，
 * 不必离开程序去命令行执行（macOS 上找包内二进制、过 Gatekeeper 都很折腾）。
 */
import React, { useState } from "react";

export function LoadingScreen({ message = "", overlay = false, failure = null, onRetry = null, activation = null }) {
  const [licenseKey, setLicenseKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const value = licenseKey.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await activation.onSubmit(value);
      if (!result?.ok) setError([result?.message, result?.hint].filter(Boolean).join("\n"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${overlay ? "fixed inset-0 z-50" : "h-full"} flex flex-col items-center justify-center bg-card`}>
      <div className="flex items-center gap-[14px]">
        <img src="assets/logo.png" alt="小龙虾" className="h-[72px] w-auto object-contain" />
        <span className="text-[40px] font-extrabold tracking-[-1px] text-ink">
          Zgy<em className="not-italic text-logo">Claw</em>
        </span>
      </div>
      <div className="mt-[6px] pl-[56px] text-[15px] text-subtle">便携式 U 盘小龙虾智能协作伙伴</div>
      {activation ? (
        <form className="mt-[34px] flex w-[380px] flex-col items-center" onSubmit={submit}>
          <div className="text-[15px] font-medium text-title">需要授权</div>
          <p className="mt-[8px] text-center text-[13px] leading-[1.7] text-subtle">
            {activation.message || "请输入售后提供的授权码，完成后会自动继续启动。"}
          </p>
          <input
            type="text"
            autoFocus
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value.trim())}
            placeholder="XLX-XXXXXXXX"
            className="mt-[16px] h-[44px] w-full rounded-[8px] bg-field px-3 text-center text-[15px] tracking-[1px] text-body outline-none focus:ring-1 focus:ring-brand"
          />
          <button
            type="submit"
            disabled={!licenseKey || busy}
            className="mt-[16px] h-[44px] w-full rounded-full bg-ink text-[15px] font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "正在核对授权码…" : "绑定并继续"}
          </button>
          {error && (
            <div className="mt-[12px] max-h-[140px] w-full overflow-y-auto whitespace-pre-wrap rounded-[10px] bg-warnbg px-[14px] py-[10px] text-[13px] leading-[1.7] text-warndeep">{error}</div>
          )}
          {onRetry && (
            <button type="button" className="mt-[12px] text-[13px] text-link" onClick={onRetry}>
              已绑定，重试启动
            </button>
          )}
        </form>
      ) : failure ? (
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
      {message && !failure && !activation && <div className="mt-[18px] max-w-[420px] text-center text-[14px] text-subtle">{message}</div>}
    </div>
  );
}

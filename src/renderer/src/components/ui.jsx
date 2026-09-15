/** 通用小组件：按钮、徽标、状态灯、Toast、二维码容器。 */
import React from "react";

const buttonVariants = {
  primary: "bg-ink text-white hover:bg-black",
  secondary: "bg-card text-ink border border-line hover:border-brand",
  green: "bg-ok text-white hover:brightness-105",
  orange: "bg-warn text-[#160b00] hover:brightness-105",
  danger: "bg-card text-danger border border-[#ff9a9a] hover:bg-[#fff5f5]",
  link: "bg-transparent text-link hover:underline px-0",
};

/** 圆角胶囊按钮：variant 决定配色，size 决定尺寸。 */
export function Button({ variant = "primary", size = "md", className = "", ...props }) {
  const sizeClass = size === "sm" ? "h-8 px-4 text-sm" : size === "lg" ? "h-12 px-8 text-lg" : "h-10 px-6";
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-full font-semibold transition disabled:opacity-50 ${buttonVariants[variant]} ${sizeClass} ${className}`}
      {...props}
    />
  );
}

/**
 * 异步操作按钮：点击后自动置灰并转圈，请求完成（或失败）后恢复，防止重复提交，
 * 也让"要等十几秒"的操作（保存触发网关重启等）有可见的进行中状态。
 * 样式完全由 className 提供，与各面板原有按钮保持一致。
 */
export function AsyncButton({ onClick, busyText = "处理中...", children, className = "", disabled = false, ...props }) {
  const [busy, setBusy] = React.useState(false);
  const run = async () => {
    if (busy || disabled) return;
    setBusy(true);
    try { await onClick?.(); } finally { setBusy(false); }
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 whitespace-nowrap transition disabled:opacity-60 ${className}`}
      disabled={disabled || busy}
      onClick={run}
      {...props}
    >
      {busy && (
        <svg viewBox="0 0 24 24" className="h-[1em] w-[1em] animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
      )}
      {busy ? busyText : children}
    </button>
  );
}

/** 状态徽标：ok 绿 / warn 黄。 */
export function Badge({ tone = "warn", children }) {
  const tones = {
    ok: "border-[#96e2ba] bg-[#edfff6] text-okdeep",
    warn: "border-[#f1d08a] bg-[#fff8e8] text-[#a66b00]",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

/** 运行状态灯：running 绿 / starting 黄 / stopped 红。 */
export function StatusLight({ state }) {
  const colors = {
    running: "bg-ok shadow-[0_0_0_10px_rgba(32,200,120,0.08)]",
    starting: "bg-[#ffb020] shadow-[0_0_0_10px_rgba(255,176,32,0.12)] animate-pulse",
    stopped: "bg-danger shadow-[0_0_0_10px_rgba(255,77,79,0.08)]",
  };
  return <span className={`inline-block h-5 w-5 rounded-full ${colors[state] || colors.stopped}`} />;
}

/** Toast 落点：默认右上角，可由运行时配置 ui.toastPosition 切换。 */
export const TOAST_POSITIONS = ["top-right", "top-center", "bottom-center", "bottom-right"];
const DEFAULT_TOAST_POSITION = "top-right";
let toastPosition = DEFAULT_TOAST_POSITION;

const POSITION_CLASSES = {
  "top-right": "top-6 right-6",
  "top-center": "top-6 left-1/2 -translate-x-1/2",
  "bottom-center": "bottom-6 left-1/2 -translate-x-1/2",
  "bottom-right": "bottom-6 right-6",
};

/** 设置 Toast 落点（取值为 TOAST_POSITIONS；未知值忽略）。 */
export function setToastPosition(position) {
  if (TOAST_POSITIONS.includes(position)) toastPosition = position;
}

/** 四类提示的图标与配色：成功 / 提示 / 警告 / 错误。 */
const TOAST_TONES = {
  ok: { className: "border-[#96e2ba] text-okdeep", icon: "M20 6 9 17l-5-5" },
  info: { className: "border-line text-ink", icon: "M12 16v-5M12 8h.01" },
  warn: { className: "border-[#f1d08a] text-warndeep", icon: "M12 9v4M12 17h.01" },
  err: { className: "border-[#ff9a9a] text-dangerdeep", icon: "M15 9l-6 6M9 9l6 6" },
};

/** 提示类型归一化：失败/错误都按 err 处理，未知类型落到 info。 */
function toastTone(type) {
  const value = String(type || "ok").toLowerCase();
  if (["ok", "success", "done"].includes(value)) return "ok";
  if (["warn", "warning"].includes(value)) return "warn";
  if (["err", "error", "fail", "failed"].includes(value)) return "err";
  return "info";
}

/** 提示图标：圆底 + 类型化笔画，颜色跟随文字。 */
function ToastIcon({ tone }) {
  const { icon } = TOAST_TONES[tone];
  return (
    <svg viewBox="0 0 24 24" className="mt-[1px] h-[18px] w-[18px] flex-none" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d={icon} />
    </svg>
  );
}

/** 轻提示 Toast：默认右上角弹出，两秒半后自动消失，按类型带图标。 */
export function useToast() {
  const [toast, setToast] = React.useState(null);
  const timer = React.useRef(null);
  const show = React.useCallback((message, type = "ok") => {
    clearTimeout(timer.current);
    setToast({ message, type: toastTone(type) });
    timer.current = setTimeout(() => setToast(null), 2500);
  }, []);
  const element = toast ? (
    <div
      className={`fixed z-50 flex max-w-sm items-start gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-xl ${
        POSITION_CLASSES[toastPosition] || POSITION_CLASSES[DEFAULT_TOAST_POSITION]
      } ${TOAST_TONES[toast.type].className}`}
    >
      <ToastIcon tone={toast.type} />
      <span className="text-body">{toast.message}</span>
    </div>
  ) : null;
  // 返回值保持稳定引用：toast 常被放进 effect/useMemo 依赖，
  // 依赖 rawToast 状态而非新建的 JSX，避免每次渲染都换引用导致重复请求。
  return React.useMemo(() => ({ show, element }), [show, toast]);
}

/** 二维码盒子：内容可为 SVG 字符串或占位文案。 */
export function QrBox({ svg, placeholder, size = 150 }) {
  if (!svg) {
    return (
      <div
        className="flex items-center justify-center rounded-[12px] bg-panel p-[10px] text-center text-[13px] text-faint"
        style={{ width: size, height: size }}
      >
        {placeholder || "等待二维码"}
      </div>
    );
  }
  return (
    <div
      className="flex items-center justify-center rounded-[12px] bg-card p-[10px] [&>svg]:h-full [&>svg]:w-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

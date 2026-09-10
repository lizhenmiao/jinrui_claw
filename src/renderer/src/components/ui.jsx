/** 通用小组件：按钮、徽标、状态灯、Toast、二维码容器。 */
import React from "react";

const buttonVariants = {
  primary: "bg-ink text-white hover:bg-black",
  secondary: "bg-white text-ink border border-line hover:border-brand",
  green: "bg-ok text-white hover:brightness-105",
  orange: "bg-warn text-[#160b00] hover:brightness-105",
  danger: "bg-white text-danger border border-[#ff9a9a] hover:bg-[#fff5f5]",
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

/** 轻提示 Toast：两秒半后自动消失。 */
export function useToast() {
  const [toast, setToast] = React.useState(null);
  const timer = React.useRef(null);
  const show = React.useCallback((message, type = "ok") => {
    clearTimeout(timer.current);
    setToast({ message, type });
    timer.current = setTimeout(() => setToast(null), 2500);
  }, []);
  const element = toast ? (
    <div
      className={`fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border bg-white px-4 py-3 text-sm shadow-xl ${
        toast.type === "err" ? "border-[#933] text-danger" : "border-line text-ink"
      }`}
    >
      {toast.message}
    </div>
  ) : null;
  return { show, element };
}

/** 二维码盒子：内容可为 SVG 字符串或占位文案。 */
export function QrBox({ svg, placeholder }) {
  if (!svg) {
    return (
      <div className="flex h-[150px] w-[150px] items-center justify-center rounded-lg border border-dashed border-line bg-[#fafafa] p-2 text-center text-xs text-faint">
        {placeholder || "等待二维码"}
      </div>
    );
  }
  return (
    <div
      className="flex h-[150px] w-[150px] items-center justify-center rounded-lg border border-line bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

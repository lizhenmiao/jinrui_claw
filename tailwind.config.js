/** Tailwind 设计令牌：与产品浅色视觉规范一一对应。 */
export default {
  content: ["./src/renderer/index.html", "./src/renderer/src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#f5f5f5",
        ink: "#171717",
        line: "#e5e5e5",
        brand: "#4e7cff",
        branddeep: "#5f78ff",
        link: "#3275e8",
        ok: "#20c878",
        okdeep: "#20a760",
        warn: "#ffad17",
        danger: "#ff4d4f",
        claw: "#ff3b30",
        muted: "#747474",
        faint: "#9a9a9a",
      },
      fontFamily: {
        sans: ['"Microsoft YaHei UI"', '"PingFang SC"', '"Segoe UI"', "system-ui", "sans-serif"],
        mono: ["Consolas", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

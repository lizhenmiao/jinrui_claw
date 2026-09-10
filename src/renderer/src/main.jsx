/** 渲染进程入口：装配 React 根组件与全局样式。 */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles/global.css";

createRoot(document.getElementById("root")).render(<App />);

/**
 * 运行页（最终设计）：品牌 + 状态胶囊居中，副标题，两项统计，
 * 运行日志，控制行（一键修复/启动/停止），底部左侧链接 + 右侧大按钮。
 * 对照旧实现 .runtime 最终布局：不渲染插件行、U 盘状态与状态灯。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { Button, useToast } from "../components/ui.jsx";

/** 网关状态徽标：运行中（绿）/ 启动中·停止中（黄）/ 失败·已停止（红）。 */
function GatewayBadge({ state }) {
  const tone = state === "running" ? "bg-okbg text-okdeep" : state === "starting" ? "bg-warnbg text-warndeep" : "bg-dangerbg text-dangerdeep";
  const label = { running: "运行中", starting: "启动中", stopping: "停止中", failed: "启动失败", stopped: "已停止" }[state] || "已停止";
  return (
    <span className={`inline-flex h-[30px] min-w-[76px] items-center justify-center rounded-full px-[17px] text-[13px] font-medium ${tone}`}>
      {label}
    </span>
  );
}

export default function Runtime() {
  const toast = useToast();
  const [gatewayState, setGatewayState] = useState("starting");
  const [gatewayDetail, setGatewayDetail] = useState("正在读取 OpenClaw 状态");
  const [config, setConfig] = useState({});
  const [repair, setRepair] = useState(null);
  const [logText, setLogText] = useState("正在加载日志...");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseText, setLicenseText] = useState("");
  const startingRef = useRef(false);

  const loadLogs = useCallback(async () => {
    try {
      setLogText(await desktopApi.logs.recent());
    } catch { /* 日志读取失败保持原样 */ }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { config: loaded } = await desktopApi.config.load();
      setConfig(loaded || {});
      const status = await desktopApi.gateway.status();
      if (startingRef.current && !status.running) return;
      setGatewayState(status.running ? "running" : "stopped");
      setGatewayDetail(status.running ? "已就绪，可在聊天工具中开始对话" : "网关已停止，可点击右侧按钮重新启动");
      await loadLogs();
    } catch { /* 状态读取失败保持原样 */ }
  }, [loadLogs]);

  useEffect(() => {
    let timer = null;
    (async () => {
      await refresh();
      timer = setInterval(refresh, 6000);
    })();
    return () => clearInterval(timer);
  }, [refresh]);

  const startGateway = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setGatewayState("starting");
    setGatewayDetail("正在请求启动网关...");
    try {
      const result = await desktopApi.gateway.startWechatFirst();
      setGatewayDetail(result.ready ? "网关已在运行，正在确认状态..." : "网关进程启动中，正在等待端口就绪...");
      const deadline = Date.now() + 45000;
      let running = Boolean(result.ready);
      while (!running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const status = await desktopApi.gateway.status();
        running = Boolean(status.running);
      }
      if (running) {
        setGatewayState("running");
        setGatewayDetail("已就绪，可在聊天工具中开始对话");
        toast.show("网关已启动");
      } else {
        setGatewayState("failed");
        setGatewayDetail("启动超时，网关可能未成功监听，请查看日志");
        toast.show("启动超时，请查看日志", "err");
      }
    } catch (error) {
      setGatewayState("failed");
      setGatewayDetail(error.message || "启动失败");
      toast.show(`启动失败：${error.message}`, "err");
    } finally {
      startingRef.current = false;
      await refresh();
    }
  }, [refresh, toast]);

  const stopGateway = async () => {
    setGatewayState("stopping");
    setGatewayDetail("正在停止网关...");
    try {
      const result = await desktopApi.gateway.stop();
      toast.show(result.message || "网关已停止");
      setGatewayState("stopped");
      setGatewayDetail("网关已停止，可随时重新启动");
    } catch (error) {
      toast.show(error.message, "err");
    } finally {
      await refresh();
    }
  };

  const runRepair = async () => {
    try {
      const result = await desktopApi.repair.run();
      setRepair(result.checks || []);
      toast.show(result.message || "一键修复完成");
      await refresh();
    } catch (error) {
      toast.show(error.message, "err");
    }
  };

  const showLicense = async () => {
    setLicenseOpen(true);
    setLicenseText("正在读取授权信息...");
    try {
      const result = await desktopApi.license.info();
      setLicenseText(result?.info?.copyText || JSON.stringify(result?.info || {}, null, 2));
    } catch (error) {
      setLicenseText(`授权信息读取失败：${error.message}`);
    }
  };

  const copyLicense = async () => {
    try {
      await navigator.clipboard.writeText(licenseText);
      toast.show("授权信息已复制");
    } catch (error) {
      toast.show(`复制失败：${error.message}`, "err");
    }
  };

  const checkUpdate = async () => {
    toast.show("正在检查更新...");
    try {
      const result = await desktopApi.update.check();
      const update = result?.result || {};
      if (update.needUpdate) {
        if (window.confirm(`发现新版本：${update.latestVersion || update.version || "未知"}\n是否立即下载并安装？安装时小龙虾会自动关闭并在完成后重新打开。`)) {
          await desktopApi.update.install();
          toast.show("更新包已准备，正在关闭并安装...");
        }
      } else {
        toast.show(`当前已经是最新版本：${result?.request?.currentVersion || ""}`);
      }
    } catch (error) {
      toast.show(`检查更新失败：${error.message}`, "err");
    }
  };

  const openChat = async () => {
    try {
      await desktopApi.gateway.openChat();
    } catch (error) {
      toast.show(`打开聊天失败：${error.message}`, "err");
    }
  };

  const resetWizard = async () => {
    if (!window.confirm("重新配置会保留通道凭证，仅回到配置向导。确定继续？")) return;
    try {
      await desktopApi.config.reset();
      window.location.reload();
    } catch (error) {
      toast.show(error.message, "err");
    }
  };

  const configuredModel = formatConfiguredModel(config);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white px-[92px] pb-9 pt-[76px]">
      <div className="flex items-center justify-center gap-[18px]">
        <div className="text-[30px] font-extrabold tracking-[-1px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></div>
        <GatewayBadge state={gatewayState} />
      </div>
      <div className="mt-6 text-center text-[21px] text-[#222]">您的 AI 助手 · 数据仅存 U 盘，拔出即停止</div>

      <div className="mx-auto mt-[18px] mb-[30px] flex items-center justify-center gap-[26px]">
        <Stat label="聊天工具" value={toolLabel(config)} />
        <Stat label="AI 模型" value={configuredModel} />
      </div>

      {repair && (
        <div className="mx-auto mb-4 w-full max-w-[760px] rounded-[10px] border border-[#e5e5e5] bg-white p-[14px_18px]">
          <div className="grid gap-2">
            {repair.map((item) => (
              <div key={item.label} className="grid grid-cols-[28px_180px_1fr] items-center gap-2.5 text-[13px]">
                <span className={`text-center font-bold ${item.ok === true ? "text-ok" : item.ok === false ? "text-danger" : "text-warn"}`}>
                  {item.ok === true ? "✓" : item.ok === false ? "×" : "·"}
                </span>
                <span className="text-[#333]">{item.label}</span>
                <span className={`text-right ${item.ok === true ? "text-ok" : item.ok === false ? "text-danger" : "text-warn"}`}>{item.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mx-auto w-full max-w-[760px]">
        <div className="mb-3 text-lg font-semibold text-[#222]">运行日志</div>
        <div className="h-[162px] overflow-auto whitespace-pre-wrap rounded-[11px] bg-paper p-[18px_24px] font-mono text-xs leading-[1.65] text-[#6d6d6d]">
          {logText}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2.5">
          <Button
            variant="secondary"
            className="border-[#f0a52f] bg-[#fffaf0] text-[#b87000]"
            onClick={runRepair}
          >
            一键修复
          </Button>
          {gatewayState === "running" ? (
            <Button variant="secondary" className="border-[#bdbdbd] text-[#444]" onClick={stopGateway}>停止网关</Button>
          ) : (
            <Button variant="green" className="border-[#26c978] bg-[#26c978]" disabled={gatewayState === "starting"} onClick={startGateway}>
              {gatewayState === "starting" ? "启动中..." : "启动网关"}
            </Button>
          )}
        </div>
      </div>

      <div className="mx-auto mt-auto flex w-full max-w-[860px] items-center justify-between pt-[22px]">
        <div className="flex gap-[18px]">
          <button type="button" className="text-[15px] text-link" onClick={showLicense}>授权信息</button>
          <button type="button" className="text-[15px] text-link" onClick={checkUpdate}>检查更新</button>
        </div>
        <div className="flex gap-[14px]">
          <Button variant="secondary" className="h-[54px] min-w-[132px] rounded-[29px] text-base" onClick={resetWizard}>重新配置</Button>
          <Button className="h-[54px] min-w-[206px] rounded-[29px] border-[#050505] bg-[#050505] text-base" onClick={openChat}>打开聊天窗口</Button>
        </div>
      </div>

      {licenseOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(3,3,12,0.66)] p-6" onClick={(event) => event.target === event.currentTarget && setLicenseOpen(false)}>
          <div className="w-[560px] rounded-xl border border-[#e5e5e5] bg-white p-[24px_26px] shadow-2xl">
            <div className="text-center text-xl font-extrabold text-[#eef0ff] text-ink">授权信息（售后专用）</div>
            <div className="mt-3 text-center text-[13px] text-muted">将以下信息发送给客服，用于校验授权并获取更新文件。</div>
            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[#fafafa] p-4 font-mono text-[13px] leading-[1.75] text-[#333]">{licenseText}</pre>
            <div className="mt-4 flex justify-center gap-3">
              <Button variant="secondary" className="min-w-[120px]" onClick={() => setLicenseOpen(false)}>关闭</Button>
              <Button className="min-w-[120px]" onClick={copyLicense}>一键复制</Button>
            </div>
          </div>
        </div>
      )}

      {toast.element}
    </div>
  );
}

/** 概览统计项。 */
function Stat({ label, value }) {
  return (
    <div className="flex items-center gap-[7px] text-left">
      <span className="text-[13px] text-[#777] after:content-['：']">{label}</span>
      <span className="max-w-[260px] truncate text-[13px] font-semibold text-[#222]">{value}</span>
    </div>
  );
}

/** 当前启用的聊天工具名称。 */
function toolLabel(config) {
  const entries = config?.plugins?.entries || {};
  if (entries["openclaw-weixin"]?.enabled) return "微信 Clawbot";
  if (entries["wecom-openclaw-plugin"]?.enabled) return "企业微信";
  if (entries.feishu?.enabled) return "飞书 / Lark";
  if (entries.qqbot?.enabled) return "QQ 机器人";
  if (entries["openclaw-dingtalk-channel"]?.enabled) return "钉钉对话";
  return "暂未接入";
}

/** 配置中的当前模型展示文案。 */
function formatConfiguredModel(config) {
  const raw = String(config?.agents?.defaults?.model || "").trim();
  if (!raw) return "未配置";
  const slash = raw.indexOf("/");
  if (slash < 1) return raw;
  const providerId = raw.slice(0, slash);
  const modelId = raw.slice(slash + 1);
  const provider = config?.models?.providers?.[providerId];
  const model = Array.isArray(provider?.models) ? provider.models.find((item) => item && String(item.id) === modelId) : null;
  const providerName = String(provider?.displayName || providerId);
  return `${providerName} / ${modelId}`;
}

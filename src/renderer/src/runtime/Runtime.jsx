/**
 * 运行页（最终设计）：品牌 + 状态胶囊居中，副标题，两项统计，
 * 运行日志，控制行（一键修复/启动/停止），底部左侧链接 + 右侧大按钮。
 * 对照旧实现 .runtime 最终布局：不渲染插件行、U 盘状态与状态灯。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { configuredChannelNames, pendingRestartText } from "../channels.js";
import timing from "../../../shared/timing.json";
import { Button, AsyncButton, useToast } from "../components/ui.jsx";
import { ChannelWorkbench } from "../components/ChannelWorkbench.jsx";

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
  // 通道保存/扫码绑定攒下的待重启变更：运行中时展示"重启生效"横幅（附具体原因）。
  const [pendingRestart, setPendingRestart] = useState(false);
  const [pendingReasons, setPendingReasons] = useState([]);
  const [config, setConfig] = useState({});
  // 各通道已配置摘要：聊天工具清单按"扫码绑上/凭据填全"列，不按插件启用位。
  const [channelSummary, setChannelSummary] = useState(null);
  const [repair, setRepair] = useState(null);
  const [logText, setLogText] = useState("正在加载日志...");
  const [licenseOpen, setLicenseOpen] = useState(false);
  const [licenseText, setLicenseText] = useState("");
  // 通道设置整窗浮层：网关运行中也能进面板批准配对、切私聊策略、改绑/换凭据。
  const [settingsOpen, setSettingsOpen] = useState(false);
  const startingRef = useRef(false);
  // 日志框：贴底跟随（用户上翻即暂停），选中文字时暂停刷新以便复制。
  const logBoxRef = useRef(null);
  const logFollowRef = useRef(true);

  const loadLogs = useCallback(async () => {
    try {
      const next = await desktopApi.logs.recent();
      // 用户正在日志里选中文字时跳过本次刷新，避免选区被内容替换清掉。
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && logBoxRef.current?.contains(selection.anchorNode)) return;
      setLogText((prev) => (prev === next ? prev : next));
    } catch { /* 日志读取失败保持原样 */ }
  }, []);

  // 新日志到达时保持贴底；用户往上翻阅时不打扰。
  useEffect(() => {
    const el = logBoxRef.current;
    if (el && logFollowRef.current) el.scrollTop = el.scrollHeight;
  }, [logText]);

  const handleLogScroll = () => {
    const el = logBoxRef.current;
    if (el) logFollowRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const refresh = useCallback(async () => {
    try {
      const { config: loaded } = await desktopApi.config.load();
      setConfig(loaded || {});
      const summary = await desktopApi.channels.summary().catch(() => null);
      if (summary) setChannelSummary(summary);
      const status = await desktopApi.gateway.status();
      setPendingRestart(Boolean(status?.pendingRestart));
      setPendingReasons(Array.isArray(status?.pendingReasons) ? status.pendingReasons : []);
      if (startingRef.current && !status.running) return;
      setGatewayState(status.running ? "running" : "stopped");
      setGatewayDetail(status.running ? "已就绪，可在聊天工具中开始对话" : "网关已停止，可点击右侧按钮重新启动");
      await loadLogs();
    } catch { /* 状态读取失败保持原样 */ }
  }, [loadLogs]);

  const startGateway = useCallback(async (silent = false) => {
    if (startingRef.current) return;
    startingRef.current = true;
    setGatewayState("starting");
    setGatewayDetail("正在请求启动网关...");
    try {
      const result = await desktopApi.gateway.startWechatFirst();
      setGatewayDetail(result.ready ? "网关已在运行，正在确认状态..." : "网关进程启动中，正在等待端口就绪...");
      const deadline = Date.now() + timing.gateway.startWaitTimeoutMs;
      let running = Boolean(result.ready);
      while (!running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, timing.gateway.startProbeIntervalMs));
        const status = await desktopApi.gateway.status();
        running = Boolean(status.running);
      }
      if (running) {
        setGatewayState("running");
        setGatewayDetail("已就绪，可在聊天工具中开始对话");
        if (!silent) toast.show("网关已启动");
      } else {
        setGatewayState("failed");
        setGatewayDetail("启动超时，网关可能未成功监听，请查看日志");
        if (!silent) toast.show("启动超时，请查看日志", "err");
      }
    } catch (error) {
      setGatewayState("failed");
      setGatewayDetail(error.message || "启动失败");
      if (!silent) toast.show(`启动失败：${error.message}`, "err");
    } finally {
      startingRef.current = false;
      await refresh();
    }
  }, [refresh, toast]);

  useEffect(() => {
    let timer = null;
    (async () => {
      await refresh();
      const status = await desktopApi.gateway.status().catch(() => null);
      if (status && !status.running) void startGateway(true);
      timer = setInterval(refresh, timing.gateway.statusRefreshIntervalMs);
    })();
    return () => clearInterval(timer);
  }, [refresh, startGateway]);

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

  /** 一次重启应用所有待生效的通道配置变更。 */
  const applyChanges = async () => {
    try {
      await desktopApi.gateway.restart();
      setPendingRestart(false);
      toast.show("新配置已生效");
    } catch (error) {
      toast.show(`重启失败：${error.message}`, "err");
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
      // 主进程直接返回授权信息本体（含拼好的 copyText），没有外层包装。
      const info = await desktopApi.license.info();
      setLicenseText(info?.copyText || JSON.stringify(info || {}, null, 2));
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

  /** 出厂重置：清空模型配置、通道绑定与凭据、聊天数据（授权与插件缓存保留），回到向导首页。 */
  const factoryReset = async () => {
    if (!window.confirm("恢复出厂会清空模型配置、通道绑定与凭据、聊天数据，回到最初状态（授权与插件缓存保留）。确定继续？")) return;
    try {
      await desktopApi.config.reset();
      window.location.reload();
    } catch (error) {
      toast.show(error.message, "err");
    }
  };

  const configuredModel = formatConfiguredModel(config);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card px-[92px] pb-9 pt-[76px]">
      <div className="flex items-center justify-center gap-[18px]">
        <div className="text-[30px] font-extrabold tracking-[-1px] text-ink">Zgy<em className="not-italic text-claw">Claw</em></div>
        <GatewayBadge state={gatewayState} />
      </div>
      <div className="mt-6 text-center text-[21px] text-[#222]">您的 AI 助手 数据仅存U盘中拔出即停止</div>

      <div className="mx-auto mt-[18px] mb-[30px] flex items-center justify-center gap-[26px]">
        <Stat label="聊天工具" value={configuredChannelNames(channelSummary).join("、") || "暂未接入"} />
        <Stat label="AI 模型" value={configuredModel} />
      </div>

      {repair && (
        <div className="mx-auto mb-4 w-full max-w-[760px] rounded-[10px] border border-[#e5e5e5] bg-card p-[14px_18px]">
          <div className="grid gap-2">
            {repair.map((item) => (
              <div key={item.label} className="grid grid-cols-[28px_180px_1fr] items-center gap-2.5 text-[13px]">
                <span className={`text-center font-bold ${item.ok === true ? "text-ok" : item.ok === false ? "text-danger" : "text-warn"}`}>
                  {item.ok === true ? "✓" : item.ok === false ? "×" : "·"}
                </span>
                <span className="text-body">{item.label}</span>
                <span className={`text-right ${item.ok === true ? "text-ok" : item.ok === false ? "text-danger" : "text-warn"}`}>{item.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {pendingRestart && gatewayState === "running" && (
        <div className="mx-auto mb-4 flex w-full max-w-[760px] items-center justify-between rounded-[10px] border border-line bg-warnbg px-[16px] py-[10px] text-[13px] text-warndeep">
          <span>{pendingRestartText(pendingReasons)}，重启网关后生效</span>
          <AsyncButton
            className="h-[30px] rounded-full bg-warn px-4 text-[13px] font-medium text-[#160b00] hover:brightness-105"
            busyText="正在重启..."
            onClick={applyChanges}
          >
            重启生效
          </AsyncButton>
        </div>
      )}

      <div className="mx-auto w-full max-w-[760px]">
        <div className="mb-3 text-[22px] font-semibold text-title">运行日志</div>
        <div
          ref={logBoxRef}
          onScroll={handleLogScroll}
          className="h-[200px] select-text overflow-auto whitespace-pre-wrap break-all rounded-[14px] bg-panel p-[20px_24px] font-mono text-[12px] leading-[1.7] text-subtle outline-none focus:outline-none"
        >
          {logText}
        </div>
        {(gatewayState === "failed" || gatewayState === "stopped") && (
        <div className="mt-4 flex items-center justify-end gap-2.5">
          <Button
            variant="secondary"
            className="border-[#f0a52f] bg-[#fffaf0] text-[#b87000]"
            onClick={runRepair}
          >
            一键修复
          </Button>
          {gatewayState === "running" ? (
            <Button variant="secondary" className="border-[#bdbdbd] text-body" onClick={stopGateway}>停止网关</Button>
          ) : (
            <Button variant="green" className="border-[#26c978] bg-[#26c978]" disabled={gatewayState === "starting"} onClick={startGateway}>
              {gatewayState === "starting" ? "启动中..." : "启动网关"}
            </Button>
          )}
        </div>
        )}
      </div>

      <div className="mx-auto mt-auto flex w-full max-w-[860px] items-center justify-between pt-[22px]">
        <div className="flex gap-[18px]">
          <button type="button" className="text-[15px] text-link" onClick={showLicense}>授权信息</button>
          <button type="button" className="text-[15px] text-link" onClick={checkUpdate}>检查更新</button>
        </div>
        <div className="flex gap-[14px]">
          <Button variant="secondary" className="h-[55px] min-w-[150px] rounded-full text-base" onClick={() => setSettingsOpen(true)}>通道设置</Button>
          <Button variant="secondary" className="h-[55px] min-w-[168px] rounded-full text-base" onClick={factoryReset}>恢复出厂设置</Button>
          <Button className="h-[55px] min-w-[262px] rounded-full border-[#050505] bg-[#050505] text-base" onClick={openChat}>打开聊天窗口</Button>
        </div>
      </div>

      {/* 通道设置浮层：与向导 BOT 页同一套面板；放在 toast 之前渲染，提示浮层仍在最上层。 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-card">
          <div className="flex h-[58px] flex-none items-center gap-4 border-b border-linesoft px-6">
            <button
              type="button"
              aria-label="返回运行页"
              className="flex h-[30px] w-[30px] items-center justify-center rounded-full border-[1.6px] border-ink text-body"
              onClick={() => setSettingsOpen(false)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
            </button>
            <span className="text-[18px] font-semibold text-title">通道设置</span>
            <span className="text-[13px] text-subtle">保存或扫码绑定只写配置；都改完后点底部「重启生效」一次应用</span>
          </div>
          <ChannelWorkbench
            className="min-h-0 flex-1"
            toast={toast}
            footer={<span>通道绑定与凭据都保存在 U 盘 data 目录，换机不丢</span>}
          />
        </div>
      )}

      {licenseOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(3,3,12,0.66)] p-6" onClick={(event) => event.target === event.currentTarget && setLicenseOpen(false)}>
          <div className="w-[560px] rounded-xl border border-[#e5e5e5] bg-card p-[24px_26px] shadow-2xl">
            <div className="text-center text-xl font-extrabold text-[#eef0ff] text-ink">授权信息（售后专用）</div>
            <div className="mt-3 text-center text-[13px] text-muted">将以下信息发送给客服，用于校验授权并获取更新文件。</div>
            <pre className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[#fafafa] p-4 font-mono text-[13px] leading-[1.75] text-body">{licenseText}</pre>
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
      <span className="max-w-[260px] truncate text-[14px] font-semibold text-title underline decoration-[#1f1f1f]/60 underline-offset-[3px]">{value}</span>
    </div>
  );
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

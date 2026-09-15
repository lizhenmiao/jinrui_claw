/**
 * 通道配置面板集合：微信扫码、QQ 双码、企业微信、飞书（含配对审批）、钉钉对话。
 * 向导 BOT 页与运行页共用同一套面板，保证交互一致。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import timing from "../../../shared/timing.json";
import { LoadingScreen } from "./LoadingScreen.jsx";
import { AsyncButton, QrBox } from "./ui.jsx";

const QQ_OPENCLAW_URL = "https://q.qq.com/qqbot/openclaw/login.html";

/** 二维码内容转 SVG 字符串（主进程渲染，失败返回空串显示占位）。 */
function renderQr(data) {
  return desktopApi.qr.render(data).catch(() => "");
}

/** 按通道 ID 渲染对应面板；plain 为 BOT 页灰面模式（面板去边框直接落灰面）。 */
export function ChannelPanel({ toolId, toast, plain = false, docUrl = "" }) {
  switch (toolId) {
    case "wechat":
      return <WechatPanel toast={toast} plain={plain} />;
    case "qqbot":
      return <QQPanel toast={toast} plain={plain} />;
    case "wecom":
      return <WecomPanel toast={toast} plain={plain} docUrl={docUrl} />;
    case "feishu":
      return <FeishuPanel toast={toast} plain={plain} docUrl={docUrl} />;
    case "dingtalk-channel":
      return <DingTalkChannelPanel toast={toast} plain={plain} docUrl={docUrl} />;
    default:
      return <div className="flex h-32 items-center justify-center text-sm text-faint">本次暂不接入聊天工具</div>;
  }
}

/** 拿凭据的官方文档入口：地址由 app.config.json 的 channels.docs 提供，没配就不显示。 */
function DocLink({ url, label = "查看官方文档" }) {
  if (!url) return null;
  return (
    <button
      type="button"
      className="text-[13px] text-link"
      onClick={() => { desktopApi.app.openExternal(url).catch(() => { /* 打不开浏览器时静默 */ }); }}
    >
      {label}
    </button>
  );
}

/** 面板容器：标题 + 内容；plain 模式去掉白色卡片容器。 */
function Panel({ title, plain, children }) {
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <h2 className={`text-xl font-medium text-title ${plain ? "mb-7 text-center" : "mb-4"}`}>{title}</h2>
      {children}
    </div>
  );
}

/** 二维码占位：绑定成功后用它替掉二维码，避免继续展示已失效的码。 */
function BoundBox({ size }) {
  return (
    <div className="flex items-center justify-center rounded-[12px] bg-okbg" style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="currentColor" strokeWidth="2" className="text-okdeep">
        <circle cx="12" cy="12" r="10" />
        <path d="m8 12.5 2.6 2.6L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** 微信扫码面板：登录拿码 → 轮询状态直至成功（已扫码/已绑定都会在二维码下方提示）。 */
export function WechatPanel({ toast, plain }) {
  const [svg, setSvg] = useState("");
  const [message, setMessage] = useState("正在连接微信登录入口...");
  const [tone, setTone] = useState("idle");
  const [started, setStarted] = useState(false);
  const [coldWait, setColdWait] = useState(false);
  const pollRef = useRef(null);
  const qrUrlRef = useRef("");
  const autoStarted = useRef(false);

  useEffect(() => () => clearInterval(pollRef.current), []);

  /** 二维码换码后必须重绘（否则用户扫到的是已失效的旧码）。 */
  const showQr = useCallback(async (qrUrl) => {
    if (!qrUrl || qrUrl === qrUrlRef.current) return;
    qrUrlRef.current = qrUrl;
    setSvg(await renderQr(qrUrl));
  }, []);

  const startLogin = useCallback(async (restart = false) => {
    setStarted(true);
    setTone("idle");
    setMessage("正在连接微信登录入口...");
    try {
      const current = await desktopApi.channels.wechat.status().catch(() => null);
      // 已绑定过就直接展示绑定态（切页/重启后依然如此），只有点"重新绑定"才作废重来。
      if (!restart && current?.status === "success") {
        qrUrlRef.current = "";
        setSvg("");
        setTone("ok");
        setMessage(current.message || "微信已绑定，通道已启用");
        return;
      }
      // 本机第一次启动组件要等一分钟左右（模块首次执行要过系统扫描），盖加载页说明清楚，别让面板像卡死。
      // 只有主进程明确报"未预热"才盖：字段缺失（旧主进程/接口异常）时按普通等待处理，不误报"首次"。
      setColdWait(current?.runtimeWarm === false && !current?.qr);
      // 已有可用二维码时直接复用（登录接口内部会等待新码出现）。
      const result = await desktopApi.channels.wechat.login(restart ? { restart: true } : {});
      if (result?.qr) {
        await showQr(result.qr);
        setMessage("请用微信扫码");
      } else {
        setMessage(result?.message || "二维码仍在后台生成，请稍候...");
      }
      startPolling();
    } catch (error) {
      setMessage(`生成失败：${error.message}`);
      setTone("warn");
    } finally {
      setColdWait(false);
    }
  }, [showQr]);

  // 进入面板即自动连接（复用预热二维码），无需手动点击。
  useEffect(() => {
    if (autoStarted.current) return;
    autoStarted.current = true;
    startLogin();
  }, [startLogin]);

  const startPolling = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await desktopApi.channels.wechat.status();
        if (status?.qr) await showQr(status.qr);
        if (status?.message) setMessage(status.message);
        if (status?.status === "success") {
          clearInterval(pollRef.current);
          qrUrlRef.current = "";
          setSvg("");
          setTone("ok");
        } else if (status?.status === "failed") {
          clearInterval(pollRef.current);
          setTone("warn");
        } else if (["scanned", "confirming"].includes(status?.status)) {
          setTone("ok");
        }
      } catch { /* 轮询失败继续 */ }
    }, timing.wechatScan.pollIntervalMs);
  }, [showQr]);

  const messageTone = tone === "ok" ? "text-okdeep" : tone === "warn" ? "text-warndeep" : "text-subtle";

  return (
      <Panel title="配置微信 Clawbot" plain={plain}>
        <div className="flex flex-col items-center">
          {tone === "ok" && !svg ? (
            <BoundBox size={236} />
          ) : (
            <QrBox svg={svg} placeholder={started ? "二维码生成中..." : "请使用微信扫码绑定"} size={236} />
          )}
          <p className={`mt-[18px] min-h-[20px] text-center text-[14px] ${messageTone}`}>{message}</p>
          <AsyncButton
            className="mt-[16px] h-[46px] min-w-[176px] rounded-full bg-ink px-[28px] text-[15px] font-medium text-white hover:opacity-90"
            busyText="正在连接..."
            onClick={() => startLogin(started)}
          >
            {tone === "ok" ? "重新绑定" : started ? "刷新二维码" : "扫码连接"}
          </AsyncButton>
        </div>
        {coldWait && <LoadingScreen overlay message="首次运行需要准备组件，请稍候…" />}
      </Panel>
  );
}

/**
 * QQ 双码面板：左侧官方创建入口码，右侧进面板自动装插件并生成绑定码（与微信面板一致，无需先点按钮）。
 * 扫码进度由主进程的绑定会话推进（过期自动换码），面板轮询展示（已绑定态从落盘配置推导，重启后仍在）。
 */
export function QQPanel({ toast, plain }) {
  const [createSvg, setCreateSvg] = useState("");
  const [bindSvg, setBindSvg] = useState("");
  const [bindMessage, setBindMessage] = useState("正在检查 QQ 插件与绑定状态...");
  const [bindTone, setBindTone] = useState("");
  const [pluginInstalled, setPluginInstalled] = useState(null);
  const pollRef = useRef(null);
  const bindQrRef = useRef("");
  const boundRef = useRef(false);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const startPolling = useCallback(() => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const status = await desktopApi.channels.qq.status();
        if (!status) return;
        // 只看本次绑定会话的状态：落盘的 bound 由进面板时那一次检查负责，否则"重新绑定"会被旧绑定态立刻顶掉。
        // 过期后主进程会自动换码，所以这里只有在"多次失效已停止"时才停下；
        // 新码出现就重绘，用户不用手动刷新。
        if (status.qr && status.qr !== bindQrRef.current) {
          bindQrRef.current = status.qr;
          setBindSvg(await renderQr(status.qr));
        }
        if (status.status === "success") {
          clearInterval(pollRef.current);
          setBindSvg("");
          setBindTone("ok");
          boundRef.current = true;
          setBindMessage(status.message || `QQBot 已绑定，AppID: ${status.appId}`);
        } else if (status.status === "failed" || status.status === "expired") {
          clearInterval(pollRef.current);
          setBindTone("warn");
          setBindMessage(status.message);
        } else if (status.message && status.status !== "idle") {
          setBindMessage(status.message);
        }
      } catch { /* 轮询失败继续 */ }
    }, timing.qqBind.pollIntervalMs);
  }, []);

  const startBind = useCallback(async () => {
    setBindTone("");
    bindQrRef.current = "";
    setBindSvg("");
    setBindMessage("正在连接 QQ 官方扫码绑定入口。");
    try {
      const result = await desktopApi.channels.qq.login();
      if (result?.qr) {
        bindQrRef.current = result.qr;
        setBindSvg(await renderQr(result.qr));
        setBindMessage("请用手机 QQ 扫右侧二维码完成绑定。");
      } else {
        setBindMessage(result?.message || result?.error || "暂未取得绑定二维码，请点击按钮重试。");
      }
    } catch (error) {
      setBindMessage(error.message);
      setBindTone("warn");
    }
  }, []);

  // 进面板：已绑定直接展示绑定态（切页、重启后依然如此）；未绑定则装好插件后自动生成绑定二维码。
  useEffect(() => {
    (async () => {
      setCreateSvg(await renderQr(QQ_OPENCLAW_URL));
      let binding = null;
      try { binding = await desktopApi.channels.qq.status(); } catch { /* 读取失败按未绑定处理 */ }
      boundRef.current = Boolean(binding?.bound);
      if (boundRef.current) {
        setBindTone("ok");
        setBindMessage(`QQBot 已绑定，AppID: ${binding.appId}`);
        return;
      }
      startPolling();
      let installed = false;
      try {
        installed = Boolean((await desktopApi.channels.qq.pluginStatus())?.installed);
      } catch { /* 状态读取失败按未安装处理 */ }
      if (!installed) {
        // 首次进入自动安装插件（后台解压，无需用户点击）；失败时保留手动重试按钮。
        setBindMessage("正在准备 QQ 插件（首次需要解压安装，请稍候）...");
        try {
          installed = Boolean((await desktopApi.channels.qq.install())?.installed);
        } catch (error) {
          setPluginInstalled(false);
          setBindMessage(`插件安装失败：${error.message}`);
          return;
        }
      }
      setPluginInstalled(installed);
      if (installed) await startBind();
      else setBindMessage("插件安装未完成，可点击下方按钮重试。");
    })();
  }, [startPolling, startBind]);

  const installPlugin = async () => {
    try {
      const result = await desktopApi.channels.qq.install();
      setPluginInstalled(Boolean(result?.installed));
      toast?.show?.(result.message || "QQ 插件安装完成");
      // 手动装好插件同样直接出码，少一次点击。
      if (result?.installed && !boundRef.current) await startBind();
    } catch (error) {
      toast?.show?.(error.message, "err");
    }
  };

  const messageTone = bindTone === "ok" ? "text-okdeep" : bindTone === "warn" ? "text-warndeep" : "text-subtle";

  return (
    <Panel title="配置 QQ bot" plain={plain}>
      <div className="flex flex-col items-center">
        <div className="flex flex-col items-center">
          <QrBox svg={createSvg} placeholder="二维码生成中..." size={200} />
          <p className="mt-[14px] max-w-[420px] text-center text-[13px] leading-[1.6] text-subtle">
            用手机 QQ 扫码进入官方 OpenClaw 机器人入口，创建或选择你的 QQ 机器人。
          </p>
        </div>
        <div className="my-[26px] h-px w-full max-w-[420px] bg-linesoft" />
        <div className="flex flex-col items-center">
          {bindTone === "ok" && !bindSvg ? <BoundBox size={200} /> : <QrBox svg={bindSvg} placeholder="绑定二维码生成中..." size={200} />}
          <p className={`mt-[14px] min-h-[20px] max-w-[420px] text-center text-[13px] leading-[1.6] ${messageTone}`}>{bindMessage}</p>
          {bindTone === "ok" && (
            <p className="mt-[6px] max-w-[420px] text-center text-[12.5px] leading-[1.6] text-subtle">
              QQ 机器人会在配置完成、网关启动后上线，届时在 QQ 里就能对话。
            </p>
          )}
          {pluginInstalled === null ? null : (
            <AsyncButton
              className={`mt-[16px] h-[46px] min-w-[176px] rounded-full px-[28px] text-[15px] font-medium text-white hover:opacity-90 ${pluginInstalled ? "bg-ink" : "bg-warn"}`}
              busyText={pluginInstalled ? "正在生成..." : "正在安装..."}
              onClick={pluginInstalled ? startBind : installPlugin}
            >
              {pluginInstalled ? (bindTone === "ok" ? "重新绑定" : "生成绑定二维码") : "安装 QQ 插件"}
            </AsyncButton>
          )}
        </div>
      </div>
    </Panel>
  );
}

/** 企业微信凭证面板。 */
export function WecomPanel({ toast, plain, docUrl = "" }) {
  const [form, setForm] = useState({ name: "", botId: "", secret: "" });
  const [statusText, setStatusText] = useState("读取中...");

  useEffect(() => {
    (async () => {
      try {
        const { config } = await desktopApi.channels.wecom.load();
        setForm({ name: config.name || "", botId: config.botId || "", secret: config.secret || "" });
        setStatusText(config.configured ? "已读取企业微信配置。" : "请填写企业微信后台「长连接配置」中的 Bot ID 和 Secret。");
      } catch (error) {
        setStatusText(`读取失败：${error.message}`);
      }
    })();
  }, []);

  const save = async () => {
    if (!form.botId || !form.secret) {
      toast?.show?.("请同时填写 Bot ID 和 Secret", "err");
      return;
    }
    try {
      await desktopApi.channels.wecom.save({ ...form, enabled: true });
      toast?.show?.("企业微信配置已保存");
      setStatusText("已保存并启用，网关启动后自动生效（长连接，无需回调）。");
    } catch (error) {
      toast?.show?.(error.message, "err");
      setStatusText(`保存失败：${error.message}`);
    }
  };

  return (
    <Panel title="配置企业微信 bot" plain={plain}>
      <CredentialFields
        statusTone={statusText.includes("已配置") ? "ok" : ""}
        fields={[
          { key: "name", label: "机器人名称（可选）", placeholder: "阿宝" },
          { key: "botId", label: "Bot ID", placeholder: "长连接配置里的 Bot ID" },
          { key: "secret", label: "Secret", placeholder: "长连接配置里的 Secret", type: "password" },
        ]}
        form={form}
        setForm={setForm}
        statusText={statusText}
        onSave={save}
        footer={<DocLink url={docUrl} label="如何获取 Bot ID 和 Secret？查看官方文档" />}
      />
    </Panel>
  );
}

/** 飞书凭证面板（含私聊策略与配对审批）。 */
export function FeishuPanel({ toast, plain, docUrl = "" }) {
  const [form, setForm] = useState({ name: "飞书", domain: "feishu", appId: "", appSecret: "" });
  const [statusText, setStatusText] = useState("读取中...");
  const [dmPolicy, setDmPolicy] = useState("pairing");
  const [switching, setSwitching] = useState(false);
  const [pairing, setPairing] = useState({ requests: [], allowFrom: [], approved: [] });

  const refreshPairing = useCallback(async () => {
    try {
      const result = await desktopApi.channels.feishu.pairing();
      setPairing({ requests: result?.requests || [], allowFrom: result?.allowFrom || [], approved: result?.approved || [] });
    } catch { /* 配对列表读取失败不阻塞表单 */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { config } = await desktopApi.channels.feishu.load();
        setForm({ name: config.name || "飞书", domain: config.domain || "feishu", appId: config.appId || "", appSecret: config.appSecret || "" });
        setDmPolicy(config.dmPolicy || "pairing");
        setStatusText(config.configured ? "已读取飞书配置。" : "请填写飞书开放平台自建应用的 App ID 和 App Secret。");
        await refreshPairing();
      } catch (error) {
        setStatusText(`读取失败：${error.message}`);
      }
    })();
  }, [refreshPairing]);

  const save = async () => {
    if (!form.appId || !form.appSecret) {
      toast?.show?.("请同时填写 App ID 和 App Secret", "err");
      return;
    }
    try {
      await desktopApi.channels.feishu.save({ ...form, enabled: true });
      toast?.show?.("飞书配置已保存");
      setStatusText("已保存并启用，网关启动后自动生效。请在飞书单聊/群聊中测试对话（群聊默认需@）。");
    } catch (error) {
      toast?.show?.(error.message, "err");
      setStatusText(`保存失败：${error.message}`);
    }
  };

  const approve = async (code) => {
    try {
      const result = await desktopApi.channels.feishu.approvePairing(code);
      toast?.show?.(result.message || "配对已批准");
      await refreshPairing();
    } catch (error) {
      toast?.show?.(error.message, "err");
    }
  };

  /** 取消批准：对方立刻回到"需配对审批"状态（名单同时在配置里时会提示重启生效）。 */
  const revoke = async (userId) => {
    try {
      const result = await desktopApi.channels.feishu.revokeUser(userId);
      toast?.show?.(result?.message || "已取消批准");
      await refreshPairing();
    } catch (error) {
      toast?.show?.(error.message, "err");
    }
  };

  /** 切换私聊策略：只写配置，网关重启后生效（工作区底部/运行页会给"重启生效"按钮）。 */
  const changeDmPolicy = async (next) => {
    if (switching || next === dmPolicy) return;
    const previous = dmPolicy;
    setDmPolicy(next);
    setSwitching(true);
    try {
      await desktopApi.channels.feishu.setDmPolicy(next);
      toast?.show?.(next === "open" ? "已改为开放：企业内任何人都能直接私聊" : "已改为需审批：私聊需配对码批准");
    } catch (error) {
      setDmPolicy(previous);
      toast?.show?.(error.message, "err");
    } finally {
      setSwitching(false);
    }
  };

  const dmOpen = dmPolicy === "open";
  const dmHint = switching
    ? "正在保存新策略..."
    : dmOpen
      ? "当前为开放模式：企业内任何人私聊机器人都能直接对话，无需审批。"
      : dmPolicy === "allowlist"
        ? "当前为仅白名单模式（由配置文件设置）：只有名单内的用户能私聊机器人。"
        : "陌生人私聊机器人会得到一个配对码，需在下方批准后才能对话。";

  return (
    <Panel title="配置飞书 bot" plain={plain}>
      <CredentialFields
        fields={[
          { key: "domain", label: "域名", type: "select", options: [{ value: "feishu", label: "飞书（国内）" }, { value: "lark", label: "Lark（国际）" }] },
          { key: "appId", label: "App ID", placeholder: "cli_xxxxxxxx" },
          { key: "appSecret", label: "App Secret", placeholder: "应用密钥", type: "password" },
        ]}
        form={form}
        setForm={setForm}
        statusText={statusText}
        onSave={save}
        footer={<DocLink url={docUrl} label="如何获取 App ID 和 App Secret？查看官方文档" />}
      />
      <div className="mx-auto mt-[26px] w-full max-w-[420px] border-t border-linesoft pt-[18px]">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold text-title">私聊策略</span>
          {!dmOpen && (
            <AsyncButton className="text-[13px] text-link" busyText="刷新中..." onClick={refreshPairing}>刷新列表</AsyncButton>
          )}
        </div>
        <div className={`flex h-[46px] w-full rounded-full bg-switch p-[5px] text-[13px] text-faint ${switching ? "opacity-60" : ""}`}>
          <span
            role="tab"
            aria-selected={!dmOpen}
            className={`flex h-full flex-1 cursor-pointer select-none items-center justify-center rounded-full ${!dmOpen ? "bg-card text-body shadow-[0_1px_5px_rgba(0,0,0,0.08)]" : ""}`}
            onClick={() => changeDmPolicy("pairing")}
          >
            需要配对审批
          </span>
          <span
            role="tab"
            aria-selected={dmOpen}
            className={`flex h-full flex-1 cursor-pointer select-none items-center justify-center rounded-full ${dmOpen ? "bg-card text-body shadow-[0_1px_5px_rgba(0,0,0,0.08)]" : ""}`}
            onClick={() => changeDmPolicy("open")}
          >
            开放（人人可私聊）
          </span>
        </div>
        <p className="mt-[10px] text-[12px] leading-[1.6] text-subtle">{dmHint}</p>
        {!dmOpen && (pairing.requests.length === 0 ? (
          <div className="mt-2 py-1 text-[12px] text-subtle">暂无待审批请求。对方在飞书私聊机器人后，这里会出现配对码。</div>
        ) : (
          pairing.requests.map((request) => (
            <div key={request.code} className="mt-2 flex items-center justify-between rounded-[10px] bg-panel px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-title">{request.name || "飞书用户"}</div>
                <div className="break-all text-[12px] text-subtle">
                  配对码 <span className="font-mono font-bold text-branddeep">{request.code}</span> · {request.userId}
                </div>
              </div>
              <AsyncButton
                className="h-8 rounded-full bg-ok px-4 text-sm font-semibold text-white hover:brightness-105"
                busyText="批准中..."
                onClick={() => approve(request.code)}
              >
                批准
              </AsyncButton>
            </div>
          ))
        ))}
        {!dmOpen && (
          <div className="mt-4 border-t border-linesoft pt-3">
            <div className="text-[12px] font-semibold text-title">已批准的用户</div>
            {pairing.approved.length === 0 ? (
              <div className="mt-2 py-1 text-[12px] text-subtle">暂无已批准用户，批准配对后会出现在这里。</div>
            ) : pairing.approved.map((user) => (
              <div key={user.id} className="mt-2 flex items-center justify-between rounded-[10px] bg-panel px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-semibold text-title">{user.name || "飞书用户"}</div>
                  <div className="break-all text-[12px] text-subtle">{user.id}</div>
                </div>
                <AsyncButton
                  className="h-8 flex-none rounded-full border border-[#ff9a9a] bg-card px-4 text-sm font-semibold text-danger hover:bg-[#fff5f5]"
                  busyText="移除中..."
                  onClick={() => revoke(user.id)}
                >
                  取消批准
                </AsyncButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** 钉钉 Stream 对话凭证面板。 */
export function DingTalkChannelPanel({ toast, plain, docUrl = "" }) {
  const [form, setForm] = useState({ name: "钉钉对话", clientId: "", clientSecret: "", robotCode: "" });
  const [statusText, setStatusText] = useState("读取中...");

  useEffect(() => {
    (async () => {
      try {
        const { config } = await desktopApi.channels.dingtalkChannel.load();
        setForm({
          name: config.name || "钉钉对话",
          clientId: config.clientId || "",
          clientSecret: config.clientSecret || "",
          robotCode: config.robotCode || "",
        });
        setStatusText(config.configured ? "已读取钉钉对话配置。" : "请填写钉钉开放平台应用的 Client ID 和 Client Secret。");
      } catch (error) {
        setStatusText(`读取失败：${error.message}`);
      }
    })();
  }, []);

  const save = async () => {
    if (!form.clientId || !form.clientSecret) {
      toast?.show?.("请同时填写 Client ID 和 Client Secret", "err");
      return;
    }
    try {
      await desktopApi.channels.dingtalkChannel.save({ ...form, enabled: true });
      toast?.show?.("钉钉对话配置已保存");
      setStatusText("已保存并启用，网关启动后自动生效。请在钉钉单聊/群聊中测试对话。");
    } catch (error) {
      toast?.show?.(error.message, "err");
      setStatusText(`保存失败：${error.message}`);
    }
  };

  return (
    <Panel title="配置钉钉对话 bot" plain={plain}>
      <CredentialFields
        fields={[
          { key: "clientId", label: "Client ID（AppKey）", placeholder: "dingxxxxxxxx" },
          { key: "clientSecret", label: "Client Secret（AppSecret）", placeholder: "应用密钥", type: "password" },
          { key: "robotCode", label: "Robot Code（可选）", placeholder: "机器人 RobotCode，可从开放平台复制" },
        ]}
        form={form}
        setForm={setForm}
        statusText={statusText}
        onSave={save}
        footer={<DocLink url={docUrl} label="如何获取 Client ID 和 Secret？查看官方文档" />}
      />
    </Panel>
  );
}

/** 凭证字段组：标签在上、输入框在下 + 状态文案 + 保存按钮（可附额外操作与文档链接）。 */
function CredentialFields({ fields, form, setForm, statusText, statusTone, onSave, extraActions, footer }) {
  return (
    <div className="mt-[30px] flex flex-col items-center">
      <div className="w-full max-w-[420px] text-left">
        {fields.map((field) => (
          <div key={field.key} className="mb-[16px]">
            <label className="mb-[8px] block text-[13px] font-medium text-title" htmlFor={field.key}>{field.label}</label>
            {field.type === "select" ? (
              <select
                id={field.key}
                className="h-[46px] w-full rounded-[10px] bg-card px-3.5 text-[14px] text-body outline-none focus:ring-1 focus:ring-brand"
                value={form[field.key] || ""}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                id={field.key}
                type={field.type || "text"}
                className="h-[46px] w-full rounded-[10px] bg-card px-3.5 text-[14px] text-body outline-none placeholder:text-placeholder focus:ring-1 focus:ring-brand"
                placeholder={field.placeholder}
                value={form[field.key] || ""}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value.trim() }))}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-[10px] flex items-center gap-3">
        {extraActions}
        {/* 保存可能触发网关重启（运行中且已配置时，约十几秒），按钮置灰转圈到完成。 */}
        <AsyncButton
          className="h-[46px] min-w-[160px] rounded-full bg-ink px-[28px] text-[15px] font-medium text-white hover:opacity-90"
          busyText="保存中..."
          onClick={onSave}
        >
          保存配置
        </AsyncButton>
      </div>
      <div className={`mt-[14px] min-h-[20px] w-full max-w-[420px] text-center text-[13px] leading-[1.6] ${statusTone === "ok" ? "text-okdeep" : "text-muted"}`}>{statusText}</div>
      {footer ? <div className="mt-[8px]">{footer}</div> : null}
    </div>
  );
}

/**
 * 通道配置面板集合：微信扫码、QQ 双码、企业微信、飞书（含配对审批）、钉钉对话。
 * 向导 BOT 页与运行页共用同一套面板，保证交互一致。
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import desktopApi from "../api.js";
import { Button, QrBox } from "./ui.jsx";

const QQ_OPENCLAW_URL = "https://q.qq.com/qqbot/openclaw/login.html";

/** 二维码内容转 SVG 字符串（主进程渲染，失败返回空串显示占位）。 */
function renderQr(data) {
  return desktopApi.qr.render(data).catch(() => "");
}

/** 按通道 ID 渲染对应面板；plain 为 BOT 页灰面模式（面板去边框直接落灰面）。 */
export function ChannelPanel({ toolId, toast, plain = false }) {
  switch (toolId) {
    case "wechat":
      return <WechatPanel toast={toast} plain={plain} />;
    case "qqbot":
      return <QQPanel toast={toast} plain={plain} />;
    case "wecom":
      return <WecomPanel toast={toast} plain={plain} />;
    case "feishu":
      return <FeishuPanel toast={toast} plain={plain} />;
    case "dingtalk-channel":
      return <DingTalkChannelPanel toast={toast} plain={plain} />;
    default:
      return <div className="flex h-32 items-center justify-center text-sm text-faint">本次暂不接入聊天工具</div>;
  }
}

/** 面板容器：标题 + 内容；plain 模式去掉白色卡片容器。 */
function Panel({ title, plain, children }) {
  return (
    <div className="mx-auto w-full max-w-[680px]">
      <h2 className={`text-xl font-medium text-[#222] ${plain ? "mb-7 text-center" : "mb-4"}`}>{title}</h2>
      {children}
    </div>
  );
}

/** 微信扫码面板：登录拿码 → 轮询状态直至成功。 */
export function WechatPanel({ toast, plain }) {
  const [svg, setSvg] = useState("");
  const [message, setMessage] = useState("点击「扫码连接」开始绑定微信。");
  const [started, setStarted] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const startLogin = useCallback(async () => {
    setStarted(true);
    setMessage("正在连接微信登录入口...");
    try {
      const result = await desktopApi.channels.wechat.login();
      if (result?.qr) {
        setSvg(await renderQr(result.qr));
        setMessage("请用微信扫码");
        startPolling();
      } else {
        setMessage(result?.message || "二维码仍在后台生成，请稍候...");
      }
    } catch (error) {
      setMessage(`生成失败：${error.message}`);
    }
  }, []);

  const startPolling = useCallback(() => {
    clearInterval(pollRef.current);
    let tries = 0;
    pollRef.current = setInterval(async () => {
      tries += 1;
      try {
        const status = await desktopApi.channels.wechat.status();
        if (status?.qr) {
          const current = await renderQr(status.qr);
          setSvg((prev) => prev || current);
          setMessage(status.message || "请用微信扫码");
        } else if (status?.message) {
          setMessage(status.message);
        }
        if (status?.status === "success") {
          clearInterval(pollRef.current);
          setMessage("扫码成功，通道已启用。");
        } else if (status?.status === "failed") {
          clearInterval(pollRef.current);
          setMessage(status.message || "登录失败，请重试");
        }
        if (tries > 120) clearInterval(pollRef.current);
      } catch { /* 轮询失败继续 */ }
    }, 1500);
  }, []);

  return (
    <Panel title="配置微信 Clawbot" plain={plain}>
      <div className="flex items-start gap-5">
        <QrBox svg={svg} placeholder={started ? "生成中..." : "请使用微信扫码绑定"} />
        <div className="flex max-w-[280px] flex-col items-start gap-2 text-[13px] leading-relaxed text-[#777]">
          <div className="font-bold text-[#222]">微信 ClawBot</div>
          <div>{message}</div>
          <Button size="sm" variant={started ? "secondary" : "primary"} onClick={startLogin}>
            {started ? "刷新二维码" : "扫码连接"}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

/** QQ 双码面板：左侧官方创建入口码，右侧按需安装插件并扫码绑定。 */
export function QQPanel({ toast, plain }) {
  const [createSvg, setCreateSvg] = useState("");
  const [bindSvg, setBindSvg] = useState("");
  const [bindMessage, setBindMessage] = useState("创建或选择机器人后，点击下方按钮生成第二个绑定二维码。");
  const [pluginInstalled, setPluginInstalled] = useState(null);

  useEffect(() => {
    (async () => {
      setCreateSvg(await renderQr(QQ_OPENCLAW_URL));
      try {
        const status = await desktopApi.channels.qq.pluginStatus();
        setPluginInstalled(Boolean(status?.installed));
      } catch {
        setPluginInstalled(false);
      }
    })();
  }, []);

  const installPlugin = async () => {
    try {
      const result = await desktopApi.channels.qq.install();
      setPluginInstalled(Boolean(result?.installed));
      toast?.show?.(result.message || "QQ 插件安装完成");
    } catch (error) {
      toast?.show?.(error.message, "err");
    }
  };

  const startBind = async () => {
    setBindMessage("正在连接 QQ 官方扫码绑定入口。");
    try {
      const result = await desktopApi.channels.qq.login();
      if (result?.qr) {
        setBindSvg(await renderQr(result.qr));
        setBindMessage("请用手机 QQ 扫右侧二维码完成绑定。");
      } else {
        setBindMessage(result?.message || result?.error || "暂未取得绑定二维码，请点击按钮重试。");
      }
    } catch (error) {
      setBindMessage(error.message);
    }
  };

  return (
    <Panel title="配置 QQ 机器人" plain={plain}>
      <div className="grid w-full max-w-[660px] grid-cols-2 gap-6">
        <div className="flex items-center gap-4">
          <QrBox svg={createSvg} placeholder="二维码生成中..." />
          <div className="text-[13px] leading-relaxed text-[#777]">
            <div className="mb-1 font-bold text-[#222]">扫码创建</div>
            <div>用手机 QQ 扫左侧二维码，进入 QQ 官方 OpenClaw 机器人入口，创建或选择你的 QQ 机器人。</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <QrBox svg={bindSvg} placeholder="点击下方按钮生成" />
          <div className="flex max-w-[230px] flex-col items-start gap-2 text-[13px] leading-relaxed text-[#777]">
            <div className="font-bold text-[#222]">扫码绑定</div>
            <div>{bindMessage}</div>
            {pluginInstalled === null ? null : pluginInstalled ? (
              <Button size="sm" onClick={startBind}>生成绑定二维码</Button>
            ) : (
              <Button variant="orange" size="sm" onClick={installPlugin}>安装 QQ 插件</Button>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** 企业微信凭证面板。 */
export function WecomPanel({ toast, plain }) {
  const [form, setForm] = useState({ name: "企业微信", botId: "", secret: "" });
  const [statusText, setStatusText] = useState("读取中...");

  useEffect(() => {
    (async () => {
      try {
        const { config } = await desktopApi.channels.wecom.load();
        setForm({ name: config.name || "企业微信", botId: config.botId || "", secret: config.secret || "" });
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
      setStatusText("已保存并启用。请在企业微信单聊/群聊中测试对话。");
    } catch (error) {
      toast?.show?.(error.message, "err");
      setStatusText(`保存失败：${error.message}`);
    }
  };

  return (
    <Panel title="企业微信智能机器人" plain={plain}>
      <div className="text-[13px] leading-relaxed text-[#777]">填写企业微信后台「长连接配置」中的 Bot ID 和 Secret。采用 WebSocket 长连接，无需公网回调地址。</div>
      <CredentialFields
        fields={[
          { key: "botId", label: "Bot ID", placeholder: "企业微信智能机器人 Bot ID" },
          { key: "secret", label: "Secret", placeholder: "长连接 Secret", type: "password" },
        ]}
        form={form}
        setForm={setForm}
        statusText={statusText}
        onSave={save}
        plain={plain}
      />
    </Panel>
  );
}

/** 飞书凭证面板（含私聊配对审批）。 */
export function FeishuPanel({ toast, plain }) {
  const [form, setForm] = useState({ name: "飞书", domain: "feishu", appId: "", appSecret: "" });
  const [statusText, setStatusText] = useState("读取中...");
  const [pairing, setPairing] = useState({ requests: [], allowFrom: [] });

  const refreshPairing = useCallback(async () => {
    try {
      const result = await desktopApi.channels.feishu.pairing();
      setPairing({ requests: result?.requests || [], allowFrom: result?.allowFrom || [] });
    } catch { /* 配对列表读取失败不阻塞表单 */ }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const { config } = await desktopApi.channels.feishu.load();
        setForm({ name: config.name || "飞书", domain: config.domain || "feishu", appId: config.appId || "", appSecret: config.appSecret || "" });
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
      setStatusText("已保存并启用。请在飞书单聊/群聊中测试对话（群聊默认需@）。");
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

  const setDmOpen = async () => {
    if (!window.confirm("将飞书私聊改为「开放」后，企业内任何人私聊机器人都可直接对话（无需配对）。确定？")) return;
    try {
      await desktopApi.channels.feishu.setDmPolicy("open");
      toast?.show?.("私聊已改为开放，网关将自动重启");
    } catch (error) {
      toast?.show?.(error.message, "err");
    }
  };

  return (
    <Panel title="飞书 / Lark 机器人" plain={plain}>
      <div className="text-[13px] leading-relaxed text-[#777]">填写飞书开放平台自建应用的 App ID 和 App Secret。默认 WebSocket 长连接，无需公网回调。</div>
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
        extraActions={<Button variant="secondary" size="sm" onClick={setDmOpen}>私聊改为开放</Button>}
        plain={plain}
      />
      <div className="mt-4 border-t border-line pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-semibold text-[#222]">私聊配对审批</span>
          <Button variant="secondary" size="sm" onClick={refreshPairing}>刷新列表</Button>
        </div>
        {pairing.requests.length === 0 ? (
          <div className="py-1 text-xs text-[#858aa9]">暂无待审批请求。对方在飞书私聊机器人后，这里会出现配对码。</div>
        ) : (
          pairing.requests.map((request) => (
            <div key={request.code} className="mb-2 flex items-center justify-between rounded-lg border border-line bg-[#fafafa] px-3 py-2">
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-[#222]">{request.name || "飞书用户"}</div>
                <div className="break-all text-xs text-[#858aa9]">
                  配对码 <span className="font-mono font-bold text-branddeep">{request.code}</span> · {request.userId}
                </div>
              </div>
              <Button variant="green" size="sm" onClick={() => approve(request.code)}>批准</Button>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

/** 钉钉 Stream 对话凭证面板。 */
export function DingTalkChannelPanel({ toast, plain }) {
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
      setStatusText("已保存并启用。请在钉钉单聊/群聊中测试对话。");
    } catch (error) {
      toast?.show?.(error.message, "err");
      setStatusText(`保存失败：${error.message}`);
    }
  };

  return (
    <Panel title="钉钉完整对话（Stream）" plain={plain}>
      <div className="text-[13px] leading-relaxed text-[#777]">填写钉钉开放平台企业内部应用的 Client ID / Client Secret。Stream 长连接，支持单聊/群聊完整对话（不是群 Webhook 通知）。</div>
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
        plain={plain}
      />
    </Panel>
  );
}

/** 凭证字段组：网格表单 + 状态文案 + 保存按钮（可附额外操作）。 */
function CredentialFields({ fields, form, setForm, statusText, onSave, extraActions, plain }) {
  return (
    <div className={plain ? "mt-3" : "mt-3 rounded-xl border border-line bg-white p-4"}>
      <div className="grid grid-cols-2 gap-3">
        {fields.map((field) => (
          <div key={field.key}>
            <label className="mb-1.5 block text-[13px] text-[#444]">{field.label}</label>
            {field.type === "select" ? (
              <select
                className="h-9 w-full rounded-md border border-line bg-white px-2.5 text-sm text-[#222] outline-none focus:border-brand"
                value={form[field.key] || ""}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value }))}
              >
                {field.options.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            ) : (
              <input
                type={field.type || "text"}
                className="h-9 w-full rounded-md border border-line bg-white px-2.5 text-sm text-[#222] outline-none focus:border-brand"
                placeholder={field.placeholder}
                value={form[field.key] || ""}
                onChange={(event) => setForm((prev) => ({ ...prev, [field.key]: event.target.value.trim() }))}
              />
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2.5">
        <span className="mr-auto text-[13px] text-muted">{statusText}</span>
        {extraActions}
        <Button size="sm" onClick={onSave}>保存配置</Button>
      </div>
    </div>
  );
}

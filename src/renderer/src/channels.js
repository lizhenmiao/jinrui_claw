/**
 * 通道目录：工具 id、展示名与图标。
 * 向导侧边栏图标、确认页/运行页"聊天工具"摘要都从这里取名与图标，
 * 避免名字、图标与工具的映射在几处各写一份（多通道同时启用时要一起列出来）。
 */
export const CHANNELS = [
  { tool: "wechat", name: "微信 Clawbot", icon: "wechat.png" },
  { tool: "wecom", name: "企业微信", icon: "wecom.png" },
  { tool: "feishu", name: "飞书", icon: "feishu.png" },
  { tool: "dingtalk-channel", name: "钉钉对话", icon: "dingtalk.png" },
  { tool: "qqbot", name: "QQ 机器人", icon: "qq.png" },
];

/** 通道展示名：飞书按所选域名显示"飞书"或"Lark"，其余取目录名。 */
export function channelDisplayName(channel, entry) {
  if (channel.tool === "feishu") return entry?.domain === "lark" ? "Lark" : "飞书";
  return channel.name;
}

/** 已配置完成的通道展示名（按目录顺序）：扫码绑上或凭据填全才算数，向导里仅选中没配置的不展示。 */
export function configuredChannelNames(summary) {
  return CHANNELS.filter((item) => summary?.[item.tool]?.connected).map((item) => channelDisplayName(item, summary?.[item.tool]));
}

/** 待重启原因的展示名（与主进程 markConfigPendingRestart 登记的原因一一对应）。 */
const PENDING_RESTART_LABELS = {
  "wecom-config": "企业微信配置",
  "feishu-config": "飞书配置",
  "feishu-dm-policy": "飞书私聊策略",
  "feishu-allowFrom": "飞书私聊名单",
  "dingtalk-config": "钉钉配置",
  "weixin-account-changed": "微信绑定",
  "qqbot-bound": "QQ 绑定",
};

/** "配置已更改"提示文案：带上具体原因，让用户知道为什么要点重启。 */
export function pendingRestartText(reasons) {
  const labels = [...new Set((reasons || []).map((reason) => PENDING_RESTART_LABELS[reason] || reason))];
  return labels.length ? `配置已更改（${labels.join("、")}）` : "配置已更改";
}

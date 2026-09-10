---
name: dingtalk-channel
description: Use when helping the user configure or operate the DingTalk Stream conversation channel in this portable OpenClaw package.
---

# DingTalk Channel

This portable package contains a DingTalk Stream-mode channel plugin at `plugins/openclaw-dingtalk-channel`.

Use `data/.openclaw/dingtalk-channel.json` for credentials:

```json
{
  "enabled": true,
  "accountId": "default",
  "clientId": "DingTalk Client ID / AppKey",
  "clientSecret": "DingTalk Client Secret / AppSecret",
  "robotCode": "RobotCode",
  "debug": false,
  "allowConversationIds": [],
  "allowSenderStaffIds": []
}
```

The channel receives text messages from DingTalk Stream robot events and replies through the message's `sessionWebhook`.

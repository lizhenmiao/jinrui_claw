# OpenClaw DingTalk Channel

This plugin is a small DingTalk Stream-mode channel for OpenClaw.

It is different from the existing Webhook plugin:

- Webhook plugin: OpenClaw sends notifications to DingTalk.
- Channel plugin: DingTalk users message the robot, OpenClaw replies.

## Configure

Edit:

```text
data/.openclaw/dingtalk-channel.json
```

Minimal config:

```json
{
  "enabled": true,
  "accountId": "default",
  "clientId": "your_dingtalk_app_key_or_client_id",
  "clientSecret": "your_dingtalk_app_secret_or_client_secret",
  "robotCode": "your_robot_code",
  "debug": false,
  "allowConversationIds": [],
  "allowSenderStaffIds": []
}
```

You need a DingTalk Open Platform enterprise internal app with Robot ability enabled in Stream mode.

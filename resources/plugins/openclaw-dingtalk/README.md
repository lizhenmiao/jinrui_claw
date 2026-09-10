# OpenClaw DingTalk Webhook Plugin

Small first version for OpenClaw Portable.

It only sends messages to a DingTalk group robot webhook. It does not receive DingTalk messages yet.

## Tool

- `dingtalk_send`

## Config

Add this under `plugins.entries.openclaw-dingtalk`:

```json
{
  "enabled": true,
  "webhook": "https://oapi.dingtalk.com/robot/send?access_token=...",
  "secret": "SEC..."
}
```

`secret` is optional if the DingTalk robot does not use signing.

## Examples

Send text:

```json
{
  "text": "Hello from OpenClaw",
  "format": "text"
}
```

Send Markdown:

```json
{
  "title": "OpenClaw",
  "text": "### Report\n\n- Item A\n- Item B",
  "format": "markdown"
}
```

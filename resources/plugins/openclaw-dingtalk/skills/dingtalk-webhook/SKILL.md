---
name: dingtalk-webhook
description: "Use when the user asks OpenClaw to send a notification, report, summary, alert, reminder, meeting notes, file summary, daily report, weekly report, or test message to DingTalk."
---

# DingTalk Webhook

Use the `dingtalk_send` tool to send text or Markdown messages to the configured DingTalk group robot.

## Important

The normal/default DingTalk webhook and secret are stored outside `openclaw.json` at:

`data/.openclaw/dingtalk.json`

Do not claim the DingTalk configuration is missing merely because `openclaw.json` does not contain `webhook` or `secret`. For normal use, call `dingtalk_send` with only the message parameters. The tool will read the default webhook and secret itself.

Do not expose, print, summarize, or send webhook URLs, access tokens, secrets, API keys, or signing material.

## Usage

For a short test or notification, call:

- `text`: the message to send
- `format`: `"text"`

For reports, meeting notes, summaries, task lists, and multi-line content, call:

- `title`: short DingTalk Markdown title
- `text`: Markdown content
- `format`: `"markdown"`

Only pass `webhook` or `secret` explicitly when the user provides a temporary override in the current request. Otherwise omit them.

## Message Style

- Keep DingTalk messages concise and suitable for a group chat.
- Put the conclusion first for reports.
- Use Markdown headings and bullet lists for structured output.
- Do not send internal reasoning or configuration diagnostics unless the user explicitly asks.

## Success Criteria

If DingTalk returns `errcode: 0`, treat the message as sent successfully. Report success briefly.

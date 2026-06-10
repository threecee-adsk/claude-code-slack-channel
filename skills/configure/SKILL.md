---
name: configure
description: Configure Slack channel tokens (bot token + app-level token)
version: 1.0.0
author: Jeremy Longshore <jeremy@intentsolutions.io>
license: Apache-2.0
user-invocable: true
argument-hint: "<bot-token> <app-token>"
allowed-tools: [Read, Write, "Bash(cmd:chmod)"]
---

# /slack-channel:configure

Configure the Slack channel with your bot token and app-level token.

## Usage

```
/slack-channel:configure <xoxb-bot-token> <xapp-app-token>
```

## Instructions

1. Parse the two arguments from `$ARGUMENTS`:
   - First token must start with `xoxb-` (Bot User OAuth Token)
   - Second token must start with `xapp-` (App-Level Token)

2. If either token is missing or has the wrong prefix, show this error and stop:
   ```
   Error: Two tokens required.
     - Bot token (starts with xoxb-) from OAuth & Permissions
     - App token (starts with xapp-) from Socket Mode settings

   Usage: /slack-channel:configure xoxb-... xapp-...
   ```

3. Create the state directory if it doesn't exist:
   ```
   ~/.claude/channels/slack/
   ```

4. Write the `.env` file at `~/.claude/channels/slack/.env`:
   ```
   SLACK_BOT_TOKEN=<bot-token>
   SLACK_APP_TOKEN=<app-token>
   ```

5. Set file permissions to owner-only:
   ```bash
   chmod 600 ~/.claude/channels/slack/.env
   ```

6. Confirm success:
   ```
   Slack channel configured.

   Start Claude with the Slack channel:
     claude --channels plugin:slack-channel@claude-code-plugins

   Or for development:
     claude --dangerously-load-development-channels server:slack
   ```

## Security

- Never echo the tokens back in the confirmation message
- Never log tokens to stdout or any file other than `.env`
- Always set 0o600 permissions on the `.env` file

## Optional: channel-creation scopes (multi-session)

The `!new-channel-bot` operator command (multi-session routing only) creates a
Slack channel on the fly, which needs the bot token to carry `channels:manage`
(public) and `groups:write` (private). These are included in the manifest
exported by `/slack-channel:install manifest`. They are **optional**: without
them the rest of the bridge works unchanged and `!new-channel-bot` simply
replies with a `missing_scope` hint telling the operator to reinstall with the
updated manifest.

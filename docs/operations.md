# Doujie Operations

## Paths

```text
Source:        ~/service/doujie
Config:        ~/.doujie/config.yaml
DB:            ~/.doujie/data.db
Session state: ~/.doujie/codex-sessions.json
Registry:      ~/.doujie/sessions
LaunchAgent:   ~/Library/LaunchAgents/com.doujie.daemon.plist
Log:           /tmp/doujie.log
```

## Local Checks

```bash
cd ~/service/doujie
pnpm typecheck
pnpm test
pnpm build
```

## Service Management

Check service:

```bash
launchctl print gui/$(id -u)/com.doujie.daemon
```

Expected plist shape:

```text
ProgramArguments: /opt/homebrew/opt/node@20/bin/node dist/index.js
WorkingDirectory: ~/service/doujie
PATH: /opt/homebrew/opt/node@20/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
StandardOutPath: /tmp/doujie.log
StandardErrorPath: /tmp/doujie.log
```

Restart after build:

```bash
cd ~/service/doujie
pnpm build
launchctl kickstart -k gui/$(id -u)/com.doujie.daemon
```

Logs:

```bash
tail -n 120 /tmp/doujie.log
```

Expected startup lines:

```text
[doujie] Starting...
[doujie] Config loaded
[doujie] Codex workdir: ~/service/doujie
[doujie] DB path: ~/.doujie/data.db
[doujie] Listener started. Waiting for Feishu events...
```

## Feishu E2E Test

Use an existing Doujie chat. Keep the real chat id in private operator notes or shell history, not in git.

```text
DOUJIE_PRIVATE_CHAT_ID=oc_your_private_chat_id
```

Send status as the user:

```bash
lark-cli im +messages-send \
  --chat-id "$DOUJIE_PRIVATE_CHAT_ID" \
  --text "/status" \
  --as user \
  --idempotency-key doujie-status-$(date +%s)
```

Then inspect recent messages:

```bash
lark-cli im +chat-messages-list \
  --chat-id "$DOUJIE_PRIVATE_CHAT_ID" \
  --page-size 2 \
  --format json \
  --as user
```

Expected bot reply:

```text
Doujie Status
...
DB: ~/.doujie/data.db
```

Codex E2E:

```bash
lark-cli im +messages-send \
  --chat-id "$DOUJIE_PRIVATE_CHAT_ID" \
  --text "请只回复：DOUJIE_E2E_OK，不要解释" \
  --as user \
  --idempotency-key doujie-codex-$(date +%s)
```

Expected bot reply:

```text
DOUJIE_E2E_OK
```

## Session Inspection

From Feishu:

```text
/sessions
```

From shell:

```bash
cat ~/.doujie/codex-sessions.json
cat ~/.doujie/sessions/index.json
find ~/.doujie/sessions/links -maxdepth 1 -type l -print
```

The `links/*.jsonl` entries normally point to original Codex files under `~/.codex/sessions`. If symlink creation fails, the code falls back to copying the jsonl file, so use `find ~/.doujie/sessions/links -maxdepth 1 -type f -print` as well when auditing.

## Production Config Checklist

Before restarting a production-like listener, verify:

```bash
node --input-type=module -e "import { loadConfig } from './dist/config.js'; const c=loadConfig(); console.log(JSON.stringify({workdir:c.codex.workdir, controlSessionDir:c.codex.controlSessionDir, dbPath:c.storage.dbPath, mentionIds:c.feishu.botMentionIds, mentionNames:c.feishu.botMentionNames}, null, 2));"
```

Expected:

- `workdir` is `~/service/doujie`
- `controlSessionDir` is `~/.doujie/sessions`
- `dbPath` is `~/.doujie/data.db`
- `mentionIds` or `mentionNames` is non-empty

## Known CLI Notice

`lark-cli` has reported:

```text
current 1.0.15, latest 1.0.79
```

This does not block Doujie, but upgrading should be planned separately with a quick E2E test afterward.

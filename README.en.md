# dev-notify

English | [简体中文](README.md)

Receive task notifications through **Telegram and Feishu**. With Claude Code, reply to sessions remotely, answer questions, and approve or deny individual tool requests after separate authorization.

- npm package: `@quecue/dev-notify`
- Source: [QueCue/dev-notify](https://github.com/QueCue/dev-notify)
- Changes and upgrade notes: [CHANGELOG.en.md](CHANGELOG.en.md)
- Security and privacy: [SECURITY.en.md](SECURITY.en.md)

General notifications do not require Claude Code. npm automatically installs the communication dependency [QueCue/notify-core](https://github.com/QueCue/notify-core); no separate installation is needed.

## Installation and quick start

Requires **Node.js 22 or later** on Windows or macOS. Keep npm optional dependencies enabled: do not use `--omit=optional`. npm installs the system credential component.

```sh
npm install -g @quecue/dev-notify
dev-notify --version
dev-notify setup
```

The wizard guides you through channels, credentials, and recipients, then asks for confirmation before saving:

1. Telegram: prepare a bot token, send the bot a message, then select recipients or enter numeric chat IDs. Separate multiple IDs with commas.
2. Feishu: enter a China-site custom bot webhook and an optional signing secret.
3. Secrets use hidden input. If the terminal cannot hide input, setup stops.
4. After confirmation, setup sends a test notification and installs Claude Code notification hooks by default. Skip either with `--no-test` or `--no-hooks`.
5. Run `setup` again to edit configuration. A blank secret preserves its value; `-` clears an optional signature.

Credentials are stored in Windows Credential Manager or macOS Keychain, not as plaintext in configuration. The system may request credential access; failures do not fall back to plaintext storage.

```sh
dev-notify send --title "Build complete" --content "Installer generated"
dev-notify send --title "Test results" --content-file result.txt
dev-notify send --title "Task output" --stdin
dev-notify send --title "Preview" --content-file result.txt --dry-run
```

Options include `--channel telegram|feishu|all`, `--level info|success|warn|error`, and `--footer`. Files must use UTF-8. `--dry-run` does not use the network or print message bodies or credentials.

## Updates and prereleases

```sh
dev-notify update           # check and confirm an upgrade
dev-notify update --yes     # skip upgrade confirmation
dev-notify update --check   # check only
dev-notify update --no-post # update the package only; skip hooks/bridge maintenance
```

`update` maintains existing Claude Code hooks bound to the current configuration and restores or restarts authorized reply bridges, even when the installed version is already current. Existing credentials and valid reply authorization do not need reconfiguration. Keep passing `--config <path>` for custom configurations.

If npm updates a different Node/npm installation, the command reports an entry mismatch instead of maintaining from the old entry. After switching Node versions, reinstall the tool from the intended Node environment and update the hooks.

Default installation uses npm `latest`; ordinary `update` does not switch to `beta`. Explicitly opt into a prerelease when needed:

```sh
npm view @quecue/dev-notify dist-tags
npm install -g @quecue/dev-notify@beta
dev-notify --version
dev-notify update --yes
```

Prereleases may be unstable. To return to stable, explicitly install `@quecue/dev-notify@latest`, then run `dev-notify update --yes`.

## Claude Code notifications

Manage the integration independently after configuring notification channels; credentials do not need to be entered again:

```sh
dev-notify integration claude-code install
dev-notify integration claude-code status
dev-notify integration claude-code remove
```

`install` and `remove` accept `--yes`. After installation, confirm loading in Claude Code `/hooks` and restart the session if necessary. Claude Code must support command hooks in `command` + `args` form and `async`.

- Hooks are written to user-level `~/.claude/settings.json` by default and apply to projects under that configuration directory. Other settings and hooks are preserved.
- Completion notifications send Claude's final response. Waiting reminders cover permission requests and input-needed events; thinking and tool results are not sent.
- Footers may include project paths, session names, session IDs, and completion times. Check that recipients are allowed to see them.
- Reinstalling does not duplicate this tool's hooks. Older tools, project-level hooks, or plugins may still send notifications; decide separately whether to disable them.
- Project or managed policies may restrict hooks. This tool does not bypass them, and status checks do not prove actual event execution.
- Claude Code's launch environment may differ from a manual terminal. Reinstall hooks after moving the installation or switching Node versions.

## Remote replies and questions

**Remote input requires separate authorization; installing notification hooks does not enable it.**

```sh
dev-notify reply setup
dev-notify reply start
dev-notify reply status
```

Authorize only trusted Telegram private-chat users who are already notification recipients. Group members and Feishu card viewers do not automatically gain input rights. Tool permission approval requires a separate choice in `reply setup`.

### Reply to a session

- Click "💬 Reply to Claude" on a Telegram completion notification or reply directly to that message.
- Feishu's "Reply to Claude in Telegram" opens the corresponding bot. Follow the prompt: long-press the message and choose Reply before entering text.
- Buttons appear only when the bridge is ready and the session identity can be verified. Use a recent notification; older messages do not gain buttons automatically.
- Replies received while Claude is working queue locally and are attempted after completion. The queue is canceled after 5 minutes, new local input, or a target change.
- A reply is limited to 4000 Unicode characters. Newlines and control characters are cleaned, and text is submitted as one terminal input, not executed as a shell command.
- "Queued", "Forwarded", and "Claude received" are different states. Receipt is confirmed only after a matching local input event. Failed or unknown-result input is not retried automatically.

Remote input can contain Claude commands and grants real control; it is not read-only. Avoid editing or switching the target terminal during a remote reply.

### Questions and tool permissions

- Supports actual single-select and multi-select questions and custom answers for each question. The local interface remains usable.
- After separately enabling tool permission approval, choose Allow this time, Deny, or a custom denial reason. No permanent approval rules are created.
- Timeouts, revoked authorization, or unverifiable targets never select or approve by default. Old buttons cannot answer new questions.
- Answers are first reported as registered, then as applied, not applied, or unknown based on Claude's actual result.
- Unsupported interactions such as MCP forms and URLs must be handled locally.

### Platforms and bridge management

- Windows: native `claude` consoles. Input is refused when multiple Claude processes share the same console.
- macOS: foreground native `claude` in tmux or Ghostty. Ghostty may require system Automation authorization; denied access does not redirect input to another window.
- No automatic fallback to VS Code integrated terminals, WSL, SSH, or other terminals. See [SECURITY.en.md](SECURITY.en.md) for macOS native-input and other compatibility limits.
- The bridge is a local background process, without a public listener or system auto-start. Supported later events can start it on demand.
- **Only one update consumer may use a bot.** Use different bots for reply bridges on different machines. Do not run `reply start` and `reply run` instances in parallel.

```sh
dev-notify reply stop    # stop the current bridge; retain authorization for later event-driven startup
dev-notify reply disable # revoke authorization after confirmation and request stop
dev-notify reply run     # foreground diagnostics; first confirm no other bridge is running
```

## Configuration, language, and environment

```sh
dev-notify paths
dev-notify language       # view the effective language
dev-notify language en    # save English; zh selects Simplified Chinese
```

| Platform | Default configuration | Data directory |
| --- | --- | --- |
| Windows | `%APPDATA%\DevNotify\config.json` | `%LOCALAPPDATA%\DevNotify\data` |
| macOS | `~/Library/Application Support/DevNotify/config/config.json` | `~/Library/Application Support/DevNotify/data` |

Use `--config <path>` for a specific configuration, or set `DEV_NOTIFY_HOME` to an absolute directory containing `config/config.json` and `data/`. `CLAUDE_CONFIG_DIR` selects an absolute Claude Code configuration directory; the default is `~/.claude`.

| Environment variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_IDS` | Single / comma-separated recipients |
| `FEISHU_WEBHOOK` | Feishu China-site custom bot webhook |
| `FEISHU_SECRET` | Optional signing secret |
| `DEV_NOTIFY_LANG` | Environment language, zh or en |
| `DEV_NOTIFY_HOME` | Tool configuration and data root |
| `CLAUDE_CONFIG_DIR` | Claude Code configuration directory |

Windows also supports `APPDATA`/`LOCALAPPDATA` overrides; Linux helper paths support `XDG_CONFIG_HOME`/`XDG_STATE_HOME`.

Explicit credential and recipient environment variables take precedence, **including empty values**. Recipient variables replace the file's list; when both forms are present, they are merged and deduplicated. Represent large numeric chat IDs as strings. Configuration fields `token_env`, `webhook_env`, and `secret_env` can specify custom variable names. Do not write tokens, webhooks, or signing secrets directly into JSON.

Language precedence: `--lang zh|en` > `DEV_NOTIFY_LANG` > configuration `language` > Simplified Chinese.

Generate a credential-free automation template without overwriting an existing configuration:

```sh
dev-notify setup --template --yes
```

### Notification filtering and quiet hours

The following affects only ordinary Claude Code notifications, not general `send` or remote-input authorization:

```json
"notifications": {
  "events": {"stop": true, "waiting": false},
  "projects": {"allow": ["/Users/me/work"], "deny": []},
  "quiet_hours": {"start": "22:00", "end": "08:00"}
}
```

Completion and waiting notifications are enabled by default. Project lists match absolute path prefixes, with deny taking precedence; Windows matching is case-insensitive. Quiet hours use local time and may cross midnight. Ordinary notifications and reply buttons are suppressed during that period, while the bridge and interactions remain active; do not rely on quiet-hour notifications for permission handling.

### Footer template

```json
"templates": {"footer": "Project: {project}\nFinished: {time}\nSession: {session}"}
```

Supports `{project}`, `{topic}`, `{session}`, and `{time}`, up to 1000 characters. An empty string hides the footer. `{time}` uses local `YYYY-MM-DD HH:mm:ss`; completion notifications prefer Claude's actual completion time and fall back to event time. Only using this variable causes the tool to read a timestamp from the end of the local session file, without reading or sending message bodies.

## Troubleshooting

```sh
dev-notify doctor
dev-notify status
dev-notify integration claude-code status
dev-notify reply status
```

`doctor`/`status` check local configuration and may request system credential access, but do not verify the network. A ready bridge does not prove every notification was delivered.

Error messages use `[DN-…]` identifiers that stay the same across languages. To report a problem, provide the error code, failure stage (if present), and time; secrets and full configuration are not needed. Common examples:

| Error code | Meaning and next step |
| --- | --- |
| `DN-BRIDGE-CONNECTION-RESET` | The bridge connection was reset; its source is unknown. Run `dev-notify reply status` to check the current state. |
| `DN-BRIDGE-START-TIMEOUT` | Readiness waiting timed out, not proof of process exit. Do not start another consumer or delete locks. |
| `DN-REPLY-IDENTITY` | Button identity lookup failed. Ordinary notification delivery is still attempted independently; this does not establish delivery. |
| `DN-NOTIFY-INCOMPLETE` | Delivery or post-send processing did not fully complete. Check the channel and API-acknowledged part count; do not resend blindly. |

Failures labeled as retained by `reply status` are not new failure events. If the bridge is now ready, do not restart it solely because of historical failures.

- **No reply button:** confirm authorization, bridge readiness, and actual hook loading, then submit a normal new task in the target session. Unverifiable sessions do not gain input rights.
- **Only one channel received a notification:** check that notification's channel error. Channels deliver independently; recovery does not automatically replay failed messages.
- **Unavailable entry after an update:** check `dev-notify --version` and the active Node environment, then reinstall hooks. Existing hook entries alone do not prove usability.
- **Permission or lock error:** check directory ownership, access rights, and running processes. Do not indiscriminately delete locks or rerun with sudo/administrator rights.
- **Network error:** retain the safe error and its timestamp. A limited read-only identity-query retry does not mean message sending is retried automatically.

Local diagnostics are under `<configuration file>.reply-data/`: `notification-diagnostics/` stores recent notification summaries, `notification-failures/` the latest failure per session, and `bridge-failures/` the latest parent/worker failure. Recovery does not erase retained failures, so compare timestamps. Files contain no message bodies, credentials, or recipients and are not used for replay. They do not expire automatically; clear them with reply state after disabling and confirming cleanup. Review files before sharing, and do not share full configuration, credentials, or session state.

## Uninstall and cleanup

```sh
dev-notify reply disable
dev-notify integration claude-code remove
dev-notify credentials clear
npm uninstall -g @quecue/dev-notify
```

Run the preceding cleanup steps only for enabled features you intend to remove. Credential cleanup requires interactive confirmation and affects configurations sharing the same reference; environment variables are unchanged. npm uninstall does not automatically delete user configuration, credentials, or reply history.

## Formatting and exit codes

Supports common Markdown, code blocks, lists, and tables, with automatic splitting of long messages. Complex Markdown may not render exactly as written. Failure for one recipient stops their remaining segments while other recipients are still attempted. Explicit formatting rejection or rate limiting may trigger bounded fallback; unknown network outcomes are not blindly resent, and exactly-once delivery is not guaranteed.

| Code | Meaning |
| --- | --- |
| 0 | Selected channels fully delivered, or configuration/read-only operation succeeded |
| 1 | Delivery or maintenance incomplete, or status not ready |
| 2 | Argument, configuration, file, or credential error |
| 130 | Canceled by the user |

Claude Code hooks report safe errors without returning a host-blocking exit code; a successful hook exit does not establish notification delivery. Setup saves and test-notification results are also reported separately.

## Feedback and contributions

Report issues at [GitHub Issues](https://github.com/QueCue/dev-notify/issues), including version, OS, and sanitized errors. Do not submit tokens, webhooks, or message bodies.

See the [contribution guide](https://github.com/QueCue/dev-notify/blob/main/CONTRIBUTING.en.md) for source builds and tests, [CHANGELOG.en.md](CHANGELOG.en.md) for release changes, [LICENSE](LICENSE) for MIT licensing, and [SECURITY.en.md](SECURITY.en.md) for detailed security boundaries.

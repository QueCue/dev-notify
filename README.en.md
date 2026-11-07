# dev-notify

English | [简体中文](README.md)

Cross-platform developer task notification tool written in **TypeScript / Node.js** and distributed via npm, with no standalone executable or other script runtime required. General notifications do not depend on Claude Code or a project directory.

**The npm package name is `@quecue/dev-notify`, with general notifications, Claude Code remote replies, and local/Telegram two-sided question answering and result feedback.** Source repository: [QueCue/dev-notify](https://github.com/QueCue/dev-notify). For changes and upgrade notes, see [CHANGELOG.en.md](CHANGELOG.en.md); published versions and distribution tags are authoritative on the npm registry, and source changes do not constitute a release.

### Communication dependency in 0.2.2 source

The current 0.2.2 source extracts Telegram/Feishu communication into the standard npm runtime dependency `@quecue/notify-core`, pinned to exactly `0.1.0`. Source: [QueCue/notify-core](https://github.com/QueCue/notify-core). This structure does not describe the published `0.2.1` package.

npm installs the dependency; builds compile only this application without copying the communication library or linking sibling source. npm users do not install the library manually. `@quecue/notify-core@0.1.0` has been published through GitHub Actions. The lockfile pins its registry source and integrity; use `npm ci --ignore-scripts` for source development.

## Installation and usage

Requires Node.js 22 or later; initial targets are Windows and macOS. Runtime depends on a pinned version of `@napi-rs/keyring`, and npm installs the prebuilt native component for the corresponding system, so no additional language toolchain or compiler is required. Keep npm optional dependencies enabled.

Install from npm:

```sh
npm view @quecue/dev-notify dist-tags
npm install -g @quecue/dev-notify
dev-notify --version
dev-notify setup
```

You can also override credentials and recipients with environment variables: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_IDS`, `FEISHU_WEBHOOK`, `FEISHU_SECRET`; and path variables `DEV_NOTIFY_HOME`, `CLAUDE_CONFIG_DIR`. Explicitly present variables take precedence, and empty values also override; see "Paths, templates, and environment variables" below for complete rules and custom variable names.

The default installation uses npm's `latest` tag; `alpha` is a prerelease tag and does not imply a newer version than the stable release. Use the `npm view` command above to check tags and `dev-notify --version` to check the installed version. See the changelog for upgrade notes; after upgrading, update the complete hooks and restart any existing reply bridge. Valid authorizations and notification credentials do not need to be reconfigured; keep passing the original `--config` path for custom configurations.

The main instructions below use the npm-installed `dev-notify` command; see "Development and verification" for source builds and `node dist/cli.js` usage.

After configuration is complete, send:

```sh
dev-notify send --title "Build complete" --content "Installer generated"
dev-notify send --title "Test results" --content-file result.txt
dev-notify send --title "Task output" --stdin
dev-notify send --title "Segment preview" --content-file result.txt --dry-run
```

To install locally as the `dev-notify` command, run `npm install --global .` after building, then use `dev-notify setup`, `dev-notify send ...`, and so on. This is a local source install, not an install from the public registry; this project does not automatically install globally or publish.

npm handles installation, upgrades, and uninstallation of the official package. **Clearing credentials before uninstalling is recommended**: npm uninstall does not automatically delete user credentials. First run `dev-notify credentials clear` interactively, then uninstall. That command deletes only the Node credential referenced by the current configuration; it does not scan other configurations, delete unrelated entries, or handle old-prototype credentials. However, configuration copies sharing the same credential reference will also lose access to that credential.

Installed versions can be upgraded with `update`; it only checks the version and invokes npm, and does not download or replace files itself:

```sh
dev-notify update           # check and run npm install -g after confirmation
dev-notify update --check   # check only, do not install
dev-notify update --yes     # skip confirmation (suitable for scripts)
dev-notify update --no-post # update the package only, skip hooks/bridge maintenance
```

Actual integrity verification, registry configuration, permission handling, and native dependency resolution are still handled by npm. After a successful install, `update` automatically reinstalls the Claude Code hooks bound to the current configuration (when they exist and the configuration matches) and restarts a running reply bridge; use `--no-post` to skip this when not needed. As of 0.1.3, `update` performs the same maintenance even when already up to date, so the same command can complete post-upgrade cleanup.

## Features

- Telegram and Feishu notification channels, split by rendered length without silently truncating content.
- Text, strict UTF-8 files, or standard input; channel selection, notification level, and auxiliary metadata.
- Interactive configuration (including Telegram recipient discovery), hidden input, system credential storage, and environment variable overrides.
- Configuration update conflict detection, failure recovery, and credential cleanup.
- By default, installation sends a test notification as part of the summary confirmation, which `--no-test` skips; a failed test does not roll back saved configuration.
- By default, installs the Claude Code integration as part of the summary confirmation: final replies and waiting notifications; `--no-hooks` skips this, and independent query and removal are supported.
- Claude Code notifications can be filtered by completion/waiting event and project absolute paths, with local-time quiet hours.
- Separately authorized Telegram button replies, direct message replies, and Feishu jumps; each segment maps to a specific session.
- Normal replies queue locally, are submitted to the terminal, and `UserPromptSubmit` confirms receipt, with the states kept distinct.
- `AskUserQuestion` original options, single-select/multi-select, and custom answers are returned directly through the official hook JSON.
- When separately enabled, you can allow or deny tool permissions one at a time, or provide a custom denial reason; no persistent permission rules are written.
- Offline diagnostics via `paths`, `doctor`, `status`, and `send --dry-run`; manage the bridge with `reply start/status/stop/disable/run`.

**General notifications do not depend on Claude Code.** npm installation does not modify other applications' configuration or start background services. Notification hooks and remote input are two independent layers of authorization: by default only notifications are sent, and the reply bridge is enabled only after authorization. There is no automatic authorization or pairing, remote shell executor, or system auto-start.

## Configuration wizard

```sh
dev-notify setup
```

1. Choose Telegram, Feishu, or both; when editing an existing configuration, the current selection is shown and pressing Enter keeps it.
2. Token, webhook, and signing secret are all read as hidden input (not echoed). If the terminal cannot safely hide input, the wizard stops and does not switch to plaintext input.
3. For Telegram, setup first reads the bot's recent updates and lists recent private chats, groups, or channels that have talked to the bot (only chat_id and name are extracted; message text is never displayed or saved). Enter `#1,#3` to select them, or enter numeric chat_id values separated by commas. Discovery is skipped and manual entry is used when the bridge is running, the bot has a webhook configured, or the network request fails. Start the bot and send it a message first.
4. The summary shows channels, recipient count, test notification, Claude Code user-level settings path, and sending scope; save after one confirmation. Input errors can be retried; Ctrl+C cancels.
5. After confirmation, a fixed-content test notification is sent by default (`--no-test` skips it). A failed test does not roll back successfully saved configuration.
6. After confirmation, Claude Code notification hooks are merged and installed by default (`--no-hooks` skips it). Existing integrations are left as-is and are not added again.
7. Remote reply authorization is not requested in setup; when Telegram is available, it prompts you to run `reply setup` separately to choose specific trusted private-chat users and confirm separately.

Editing an existing configuration no longer asks a second time whether to continue; leaving a secret blank preserves the stored value, and entering `-` for an optional signature clears it. Channels that are not selected are disabled, and new entries retain credentials only for the selected channels. Environment variables still take precedence (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` / `TELEGRAM_CHAT_IDS`, `FEISHU_WEBHOOK`, `FEISHU_SECRET`); the wizard indicates which variables are overriding configuration. Tests and subsequent runtime operations use the effective values after environment overrides, but persistence saves the wizard-entered credentials and selected recipients; environment overrides are not automatically written back to configuration or system credentials. See the complete list in "Paths, templates, and environment variables".

For automation, use the secret-free template and CI secrets:

```sh
dev-notify setup --template --yes
```

To save configuration only without sending a test or installing hooks, use `setup --no-test` / `setup --no-hooks` (they can be combined). The template does not overwrite existing configuration. `--yes` can only be used with `--template`; interactive confirmation is still required before saving secrets.

## Claude Code notification integration

Requires a recent Claude Code that supports command hooks in `command` + `args` form (no shell exec) and `async`. Confirm actual loading in Claude Code's `/hooks`; if an older version does not support these fields, upgrade Claude Code. This tool does not fall back to unsafe path concatenation.

When notification channel configuration already exists, credentials do not need to be entered again:

```sh
dev-notify integration claude-code install
dev-notify integration claude-code status
dev-notify integration claude-code remove
```

`install` / `remove` accept `--yes` to skip confirmation, for automation or `update` maintenance flows.

For source verification, replace `dev-notify` above with `node dist/cli.js`. Installation can use `--config <absolute or relative path>` to bind a specified notification configuration; at execution it resolves the path to absolute and saves it in the hook arguments. Users with a custom `DEV_NOTIFY_HOME` should set that variable during installation.

- **Configuration scope**: by default user-level `~/.claude/settings.json`; when `CLAUDE_CONFIG_DIR` is set, `settings.json` under that absolute directory, covering all projects under that Claude Code configuration directory. Per-project settings are not scanned or modified.
- **Sending scope**: Stop directly uses the event's `last_assistant_message` to forward the final reply; when there is no body, it sends an explicit completion notice and does not use a possibly lagging transcript to fill in body text. Only when the footer template uses `{time}` does it read the timestamp of the last assistant record at the end of the transcript, without reading message text. It does not send thinking processes or tool results. The notification footer includes the project absolute path, session name (when readable from the local session registry), and session ID. After remote replies are enabled, it also sends structured questions, options, and separately authorized tool permission request parameters; these may contain sensitive information, so check the recipients before enabling.
- **Waiting reminders**: forwards `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, and `agent_needs_input`; ignores `idle_prompt`, authentication success, and other notifications. When the current session's last call is a question, there are no other unfinished calls, and the structured notification has been fully delivered, duplicate `permission_prompt` is suppressed per recipient; Feishu separately verifies successful delivery and target. Completed-question override state is retained briefly to handle late reminders; it is not reused after a new round of input, subsequent other tool calls, a session switch, or interaction validity expiry. Recipients not covered, partial or failed delivery, and unverifiable cases still receive the general reminder; other notification types are unaffected. The Notification event itself does not contain complete options, so answers are not guessed from prompt text; reliable option interaction is described in the next section. Unsupported MCP form/URL requests remain handled locally.
- **Merging and removal**: preserves permissions, environment variables, and other hooks; repeated installation does not accumulate. This tool's hooks in the same user-level settings are updated to the current Node, CLI, and notification configuration paths after confirmation. Only handlers carrying this tool's markers and matching argument structure are removed; the settings file and credentials are not deleted.
- **Coexistence with old tools**: old, project-level, or plugin hooks are not automatically deleted and may cause duplicate notifications. Installation reports other handlers in the current user-level file; old integrations must be disabled by the user's own decision.
- **Events and timing**: installs Stop, Notification, SessionStart, UserPromptSubmit, SessionEnd, PreToolUse, PermissionRequest, PostToolUse, PostToolUseFailure, and PermissionDenied, 10 event types. Notification is asynchronous; other events register state synchronously. PreToolUse only registers call identity, sends no notification, and does not wait for Telegram, with a 10-second timeout cap; only PermissionRequest waits for remote answers. Stop includes notification sending and may delay the local return; the notification/lifecycle limit is 120 seconds.
- **Interaction and failure**: the PermissionRequest hook limit is 720 seconds and the remote answering window is 10 minutes; normal interactive terminals retain the native window, and Claude arbitrates the first complete answer. The hook stays synchronous, is not changed to async, and does not simulate keystrokes. When there is no answer, authorization is revoked, a timeout occurs, or sending fails, no default selection is made. Internal errors print a safe summary to stderr and exit 0; exit code 2, which would let Stop continue, is not used. The current parallel implementation has been checked against Claude Code 2.1.316; other versions, background subtasks, and special hosts require separate acceptance, and this cannot be used to infer that all hosts are parallel.
- **Input boundaries**: hook stdin is at most 8 MiB with a 15-second receive timeout; over-limit is rejected rather than truncated. Normal long bodies continue to use two-channel segmentation. Completion notifications are not sent for continuation turns with `stop_hook_active: true`.
- **Loading limits**: after installation, check and confirm in `/hooks`, and restart the session if necessary. `disableAllHooks` is not removed, and managed policy is not bypassed. `status` checks only that user-level file, not runtime loading state or network connectivity.
- **Environment and paths**: asynchronous processes use Claude Code's environment, which may differ from a manual terminal; the environment variable precedence rules are unchanged. After switching Node versions or moving the source/package directory, re-run `install` to update the fixed paths.
- **Write protection**: uses an exclusive `.dev-notify.lock`, content snapshots, same-directory temporary files, and atomic replacement; invalid JSON is never overwritten. External editors do not honor the lock, so do not edit concurrently during installation. Force-kill or power loss may leave a lock or `.dev-notify-*.tmp`; confirm no installation process is running before cleaning up.

If replies were enabled, first run `reply disable` to revoke authorization and stop the bridge, then run `integration claude-code remove` before uninstalling the npm package; npm uninstall does not automatically remove hooks. If the package has already been uninstalled, reinstall it and remove, or handle the corresponding entries manually in `/hooks`. Removing hooks alone does not clear notification credentials.

## Claude Code replies and option interaction

When notification channel configuration already exists, use the following limited flow (for source use, replace `dev-notify` with `node dist/cli.js`):

```sh
dev-notify integration claude-code install
dev-notify reply setup
dev-notify reply start
dev-notify reply status
```

The first command updates to this version's complete hooks after confirmation; if lifecycle events are missing, Stop is still asynchronous, another configuration is bound, or user-level hooks are disabled, enabling or using replies is refused. Normal terminal replies also require actually observing the session's UserPromptSubmit, so old turns that were not registered during an upgrade may only receive notifications, and buttons become available only after the next normal submission. The second command **separately authorizes** specific Telegram private-chat users. Notification recipients, group members, and people who can see Feishu cards do not automatically gain input rights. `reply setup` does not grant tool permission approval capability by default; you must select Yes separately. It does not automatically migrate old credentials, nor does it agree to permissions by default.

### Normal replies

- Every segment of the completion notification offers "💬 Reply to Claude"; clicking it automatically enters reply state; you can also directly reply to the corresponding Telegram message. The Feishu button jumps to the same bot's Telegram private chat and clears the old auto-reply target through a normal prompt; it does not automatically open the reply box; long-press the prompt or target notification and choose "Reply" before typing. A manually selected reply target is not cleared and must be closed by yourself. The general `send` does not include session reply functionality.
- Buttons are shown only when the bot has started and been verified and the session can be precisely located; when the bridge is not ready, normal notifications are still sent and a safe error is reported. Enter from notifications created after enabling; old messages and mappings from before the new authorization are not inherited.
- After stripping newlines and control characters, text is submitted as **one** terminal input; at most 4000 Unicode characters; over-limit is rejected, not truncated or split into multiple tasks. Input may contain Claude commands and has the same effect as submitting locally; it is not a read-only operation.
- Normal replies received while Claude is working are first queued locally; input is attempted only after Stop, and normal replies are never used to fill tool permission dialogs. Queued entries are canceled after 5 minutes; submitting a new local task cancels the not-yet-injected queue and does not preempt local input.
- "Queued", "Forwarded", and "Claude received the reply" are three distinct states: only a `UserPromptSubmit` matching the same session/process and text digest triggers a receipt confirmation. A receipt confirmation means Claude has received the reply, and a final notification is sent after the task completes. The confirmation is sent back to the original Telegram private chat, and a receipt notice without the reply text is sent to the configured Feishu. If injection fails or the result is unknown, it is not retried automatically.
- Mappings are valid for 24 hours; the target must match session ID, PID, process birth identifier, and TTY. If the session is closed or switched, the PID is reused, multiple matches exist, or the target is uncertain, submission is rejected. Only one unconfirmed remote reply is kept per session; Telegram updates register their offset before processing, so a crash may lose the update, but submitted input is never replayed.

### Waiting questions and custom input

- **AskUserQuestion**: displays the actual question and all option text, with long content split into segments. Single-select submits on click; multi-select selects items one by one and then submits; every question has "Custom input". Multiple questions are completed one by one, and the original `questions` and `answers` are returned via the official `PermissionRequest.decision.updatedInput`; direction keys and Enter are not simulated. Old question buttons and expired custom input cannot answer new questions.
- **Tool permissions**: only after separate authorization in `reply setup`, displays the tool name/arguments and "Allow this time", "Deny", "Custom denial reason". Outputs a one-time allow/deny via `PermissionRequest`; custom text is used only for denial feedback and does not become an approval in disguise. It does not output `updatedPermissions`, does not change the default mode, and does not write persistent rules; relevant operations remain subject to Claude's managed and deny rules.
- **Local buttons are not fully replicated**: the official documentation explicitly states that `permission_suggestions` is not the complete option list of the local permission UI, so buttons such as "Always allow" are not fabricated here. MCP Elicitation forms/URLs and similar currently only have waiting reminders and must be handled on the local machine.
- The local native interface always remains available. Telegram provides an entry to "Close remote answering (local operation still available)"; on remote timeout or close, no answer is selected by default. Telegram is the option-click entry; Feishu uses jump links and does not provide a Feishu callback service.
- **Two-stage feedback**: each answer submission first reports "Registered, awaiting confirmation"; multiple questions must all be completed before returning. Then, based on the actual answers from PostToolUse, feedback reports "Answer content took effect" or "This submission did not take effect". When both ends submit the same answer, only content consistency is confirmed, and it is not claimed that Telegram definitely took effect. Permission allow is conservatively confirmed by tool completion; for deny, cancellation, or tool execution failure, when it cannot be proven that the remote decision was actually adopted, the result is explicitly reported as unknown.
- **Expiry and exceptions**: when answered locally first, timed out, or the session ends, the bridge attempts to replace old options with "Handled / Timed out / Invalid" status buttons, clearly stating whether anyone answered, and no longer accepts answers; if editing fails, old callbacks are also rejected. After returning, it waits up to 10 minutes for confirmation; if the result is missing, it reports "Unable to confirm for now" and does not replay the answer. Feedback depends on the bridge being online; after network errors, force-kill, or authorization revocation, feedback may not be delivered. This tool does not re-authorize in order to resend notifications, nor does it retry indefinitely. State is registered before the final feedback is sent; send failure is recorded as delivery unknown to prevent duplicate sends after a crash; if you only receive a waiting prompt and no final feedback, check the terminal and `reply status`.
- **Misdelivery prevention**: PreToolUse saves `tool_use_id` and the input digest, and PermissionRequest binds only to a unique matching call; completion events end requests by `tool_use_id`. If the association is missing, the same content appears repeatedly within one prompt causing ambiguity, fields are rewritten by other hooks, or the call has ended, remote answering is refused and local handling is retained, without guessing the target.

### Platforms and background services

- **Windows**: native `claude` process; the system PowerShell compiles a console helper class; after verifying the birth identifier, uses AttachConsole / WriteConsoleInputW and does not preempt the foreground. If another claude process shares the console, input is refused. Old Node-hosted CLIs are outside the currently verifiable input scope.
- **macOS**: verifies the foreground claude process and exact TTY; prefers the tmux literal paste buffer, otherwise uses Ghostty AppleScript; text is not executed as shell arguments. The system may request Accessibility/Automation permission; when permission is denied, input is not redirected to an arbitrary window. Both adapters have been simulation-tested, **but macOS real-machine input acceptance testing has not been done**.
- Automatic fallback is not supported for VS Code integrated terminal, WSL, SSH, or other terminals; when metadata is missing or a CLI upgrade changes the internal session file format, input is refused rather than scanning the transcript to guess the target. Native input and local activity are not atomic: do not manually edit or switch sessions in the same terminal during a reply.
- The bridge is a local Node background process; it does not listen on a public port and does not set up system auto-start. After explicit authorization, you can manually run `reply start`, or supported subsequent hook events can start it on demand. It exits after 24 hours without Telegram updates; it exits after 5 consecutive polling failures or a 409 conflict, and status reports only safe summaries.
- Only one getUpdates consumer is allowed per bot. Stop old bridges and other machines' instances of the same bot yourself; instances of this tool for the same user are mutually excluded by a bot fingerprint lock, but it cannot span machines or constrain programs that ignore the lock. This tool does not delete webhooks or force-kill other processes; sharing multiple instances causes conflicts and message loss.

```sh
dev-notify reply stop       # request that this bridge stop, without revoking authorization; later hooks may start it again
dev-notify reply disable    # revoke authorization and request stop after confirmation; use this to shut it down completely
dev-notify reply run        # start in the foreground to diagnose startup/network issues; do not run in parallel with a start instance
```

Stop sends a request through a control file with a random instance identifier and does not force-kill based on an old PID. System input that has already started cannot be withdrawn. `status` reflects only the local process and heartbeat; Telegram end-to-end and real Claude still require separate acceptance.

Authorization is in `<notification config>.reply.json`; messages/sessions/offset/queue/interaction state in `<notification config>.reply-data/`; the bot lock in `reply-bots/` under the data directory shown by `paths`. Queued reply text, questions, tool input, and answers pending return are briefly written to local state; normal reply text is removed before submission; structured interactions are retained until completion or confirmation timeout, after which question, argument, and answer text are cleared, while result receipts and message IDs are retained briefly for feedback and for rejecting old buttons. Validity checks are logical decisions only; files are not automatically erased after shutdown. POSIX uses 0700/0600; Windows relies on account directory ACLs; other processes of the same user can still read them. Do not commit, share, or package these files (already added to ignore rules and kept out of the npm whitelist).

Force-kill may leave locks; first confirm that the relevant bridge/writer process has exited, then handle residual locks manually, and do not delete them while the process is running. `reply disable` does not delete historical state on its own; to clear it, first disable or stop, then manually delete the dedicated files after confirmation. Clearing credentials, removing hooks, and deleting reply state are three independent operations.

## System credentials and compatibility

The Node version uses **Windows Credential Manager / macOS Keychain**, passing secrets through native Node APIs; secrets are not placed in command-line arguments and are not written to plaintext JSON.

- Underlying library: `@napi-rs/keyring`, with the pinned version recorded in the lockfile.
- service: `dev-notify.node.credentials.v1`; account: random 32-hex-digit ID.
- Configuration reference: `"credentials": {"backend":"keyring","id":"..."}`.
- To accommodate Windows generic credential blob sizes, the credential bundle is limited to 2400 UTF-8 bytes; over-limit is an error, not truncation.
- When native component loading fails, storage is locked, or access is denied, it reports an explicit error and does not fall back to a plaintext file. macOS may request system authorization; system prompts may still appear in offline environments.
- By default it does not enumerate system entries and accesses only the current reference or a random entry created in this run.

The old prototype used `backend: "system"`, which on Windows is a DPAPI file and not the same store as Node Credential Manager. Node does not read or delete it. For old configurations, run `setup` to re-enter and generate a Node reference; the original credentials remain unchanged. This compatibility restriction does not affect configurations already using `keyring` references.

## Paths, templates, and environment variables

| Platform | Configuration | Reserved data directory |
| --- | --- | --- |
| Windows | `%APPDATA%\DevNotify\config.json` | `%LOCALAPPDATA%\DevNotify\data` |
| macOS | `~/Library/Application Support/DevNotify/config/config.json` | `~/Library/Application Support/DevNotify/data` |

`DEV_NOTIFY_HOME` must be an absolute path; configuration is at `config/config.json` under it. You can also explicitly specify a file with `--config <path>`. An explicitly specified missing file is an error; when the default file is missing, using only environment variables is allowed.

```json
{
  "version": 1,
  "language": "zh",
  "notifications": {
    "events": {"stop": true, "waiting": true},
    "projects": {"allow": [], "deny": []}
  },
  "telegram": {"enabled": true, "chat_ids": [], "token_env": "TELEGRAM_BOT_TOKEN"},
  "feishu": {"enabled": true, "webhook_env": "FEISHU_WEBHOOK", "secret_env": "FEISHU_SECRET"}
}
```

### Interface language

`--lang zh|en` switches the interface language for a single command, and `DEV_NOTIFY_LANG=zh|en` sets it for the current environment; the persistent setting is stored in the `language` field of the configuration (`zh` or `en`). Precedence is `--lang` > `DEV_NOTIFY_LANG` > configuration > default `zh`. Run `dev-notify language` to view the effective language, and `dev-notify language zh|en` to save a change. CLI output, error messages, notification content, interaction buttons, and reply bridge messages all use the selected language; `setup` saves the current language when creating a new configuration.

### Notification filtering and quiet hours

The `notifications` section only affects Claude Code completion notifications and waiting reminders; the `send` command, reply bridge, question answering, and tool-permission handling are unaffected. Every field is optional; omitting it keeps the default of sending everything.

- `events.stop` controls Stop completion notifications and `events.waiting` controls waiting reminders such as permission requests; both default to `true`.
- `projects.allow` / `projects.deny` use absolute path prefixes, with `deny` taking precedence. When `allow` is non-empty, only notifications from those directories are sent; when the project path is missing, `allow` does not match and `deny` does not match. Paths are resolved for the local platform; Windows comparisons are case-insensitive.
- `quiet_hours` uses local time and supports ranges that cross midnight; identical `start` and `end` disable it. During quiet hours, ordinary notifications and reply buttons are suppressed; the bridge, local question answering, and permission handling still run, but waiting reminders are suppressed. Do not rely on notifications during quiet hours if you need to handle permission requests remotely.

```json
"notifications": {
  "events": {"stop": true, "waiting": false},
  "projects": {"allow": ["/Users/me/work"], "deny": []},
  "quiet_hours": {"start": "22:00", "end": "08:00"}
}
```

### Message templates

`templates.footer` replaces the project, topic, and session lines at the bottom of Claude Code notifications. Omit it to use the built-in bilingual format; set it to an empty string to hide the footer entirely. Templates are limited to 1000 characters, support newlines, and accept these variables:

- `{project}`: absolute project path
- `{topic}`: session name (when the local session registry provides one)
- `{session}`: session ID
- `{time}`: time in `YYYY-MM-DD HH:mm:ss` format. Stop notifications first read the timestamp of the last assistant record at the end of the local transcript, which is when Claude Code actually finished; if the transcript is unreadable or the time is implausible, it falls back to the hook trigger time rather than the time the notification is sent. Notification events use the hook trigger time. The transcript is read only when the template contains `{time}`.

Unknown placeholders are left as-is. Variable values have control characters removed and are truncated with an ellipsis when they exceed their limits.

```json
"templates": {"footer": "Project: {project}\nFinished: {time}\nSession: {session}"}
```

### Credentials and recipients

- `TELEGRAM_BOT_TOKEN`: Telegram bot token.
- `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_IDS`: primary recipient and comma-separated recipients; if either is explicitly present, it completely replaces the file list; when both exist, they are merged and deduplicated. An explicitly empty list revokes all recipients. Large integer chat_id values must be strings.
- `FEISHU_WEBHOOK`: Feishu China site HTTPS custom bot URL.
- `FEISHU_SECRET`: optional signing secret.
- The `token_env`, `webhook_env`, and `secret_env` fields in configuration can rename the above variables to other valid environment variable names.

### Paths

- `DEV_NOTIFY_HOME`: absolute path; configuration is at its `config/config.json` and data at its `data/`.
- `CLAUDE_CONFIG_DIR`: absolute path of the Claude Code configuration directory; hooks are written to its `settings.json`; when unset, `~/.claude` is used.
- On Windows, `APPDATA` and `LOCALAPPDATA` can also override the default configuration/data roots; for Linux development helper paths, `XDG_CONFIG_HOME` and `XDG_STATE_HOME` are available.

Credential environment variables take precedence when explicitly present, including empty values; only when absent is the system reference read lazily, once per configuration load. A disabled channel does not open the backend just to read system secrets. Tokens, webhooks, and secrets cannot be written directly into JSON.

## Update and cleanup safety

Save flow: write a new random system entry → verify readability → atomically replace JSON → delete the old Node entry. If failure occurs before the configuration switch, the old configuration is retained and the newly created credentials are cleaned up where possible; cleanup failure reports only non-sensitive reference IDs. Old prototype entries are never deleted.

Configuration writes use an exclusive `.setup.lock`, and the original file is checked before writing and before switching. Avoid concurrently editing configuration with an editor while the wizard is saving; editors do not honor this lock. Power loss or force-kill may leave locks or orphaned entries, and storage and JSON are not cross-system atomic transactions. Only after confirming that no wizard is running should residual locks be handled; the program does not proactively scan or delete unknown entries.

```sh
dev-notify credentials clear
```

Cleanup requires interactive confirmation; it first removes the current JSON reference, then attempts to delete its Node entry; environment variables remain unchanged. Configuration copies sharing the same old reference are also affected, and this is communicated before the operation. Deletion failure is clearly warned and is not shown as cleaned.

## Format, sending, and exit codes

Supports titles, bold, italic, strikethrough, inline code, code blocks, quotes, lists, task lists, and monospaced tables. Telegram segments by UTF-16 length, Feishu by UTF-8 request budget, and emoji are never split across surrogate pairs. Tags spanning segments are completed, titles carry `(1/N)`, and footer information is retained on every segment. Links are displayed as "text (URL)", and plain-text fallback preserves the address. This is not a complete CommonMark engine; complex escaping or nesting may not render exactly as written.

If one recipient fails midway, its subsequent segments stop, while Telegram continues sending to other recipients. HTML/card format errors fall back; when Telegram explicitly returns `429`, limited retries follow the server's requirements. After a timeout, it does not blindly resend, and exactly-once delivery cannot be promised.

- `send` uploads the specified content to third parties; check recipients and sensitive information.
- `--dry-run` prints no body text or credentials and does not use the network.
- `doctor` / `status` may read local credentials and do not verify network access or actual authorization.
- Missing files, corrupted configuration, or UTF-8 errors fail immediately and do not fall back to sending only the title.

| Code | Meaning |
| --- | --- |
| 0 | All selected configured channels sent successfully, or a configuration/read-only operation succeeded |
| 1 | Partial or total delivery failure; or doctor/status found no usable channel |
| 2 | Argument, configuration, file, or credential operation error |
| 130 | Canceled by the user |

If the test notification fails after the wizard saves successfully, the command still ends as a successful save and clearly shows the test failure; the two are clearly distinguished. Canceling hook configuration after saving still returns 0 and keeps channels; a hook configuration error returns 1 and clearly states that channels were saved. Integration `status` returns 1 when entries are missing, duplicated, or hooks are disabled in the current user-level file. Internal hook failures are reported via stderr with a non-blocking exit status for the host. This does not mean asynchronous or immediate completion: synchronous hooks awaiting remote answers still wait within their documented timeout.

## Development and verification

Clone the [GitHub source repository](https://github.com/QueCue/dev-notify) and run these commands from its directory. npm restores pinned dependencies from the lockfile; no communication-library checkout is required:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli.js setup
node dist/cli.js doctor
node dist/cli.js send --title "Build complete" --content "Installer generated"
npm test
npm pack --dry-run
```

For other CLI examples, replace `dev-notify` with `node dist/cli.js`; no global installation is required.

`node-src/` is TypeScript source, `dist/` is compiled output, and `test-js/` is tests. Default tests use only fake credentials and mock backends/network; the local native fake-entry round-trip test requires explicitly setting `DEV_NOTIFY_NATIVE_TEST=1`, is enabled only on Windows, uses random IDs, and cleans up afterward.

For the current 0.2.2 source, the package whitelist includes only this application's compiled CLI JavaScript, README, SECURITY, CHANGELOG, LICENSE and package.json. Library copies, tests, real configuration, ciphertext and dependency tarballs are excluded. npm resolves runtime dependencies separately. Published package contents depend on the corresponding version. There is no postinstall, auto-start, or self-written download script; prebuilt native dependencies are resolved by npm's platform optional packages, **do not use `--omit=optional`**. macOS x64/arm64 and Windows x64/arm64 prebuilt packages are provided by dependencies; providing packages does not mean this project has completed real-machine acceptance.

See [CHANGELOG.en.md](CHANGELOG.en.md) for verification results of published versions. The regression record for this 0.2.2 source on Windows x64 with Node 24 is 219 tests: 218 passed, 0 failed, and 1 opt-in native credential test skipped. This record does not describe verification of the published npm package.

Automated coverage includes temporary hooks, reply/authorization/expiry/anti-replay, single-select/multi-select/custom input, one-time permission JSON, two-sided races, feedback exceptions, and per-recipient duplicate reminder suppression. The actual CLI subprocess completes the loop of background start → PreToolUse registration → PermissionRequest → fake bot button → JSON answer → simulated PostToolUse → final feedback → notification deduplication/subsequent tool reminder → stop; this loop uses mock network and process metadata and cannot replace real-machine input verification. Automated tests for the Windows native input helper class only verify compilation/layout and do not perform a real Send.

Real-machine acceptance is separate from automated results: question-answering acceptance on Windows native Claude Code 2.1.316 with real Telegram covers local-first, remote-first, multi-select, custom input, competing different answers, and delayed general reminder deduplication. Those question-answering tests do not verify terminal input injection for ordinary replies. Both macOS terminal adapters have only simulation verification; macOS real-machine testing, the minimum Node version, version manager switching, and tool permission answering on a real machine have not yet been accepted. This project has not completed a security audit.

Licensed under MIT, see [LICENSE](LICENSE). Security boundaries are in [SECURITY.en.md](SECURITY.en.md). Source changes reach installed users only after a new npm release. Ordinary branch pushes do not publish; matching `v*` version tags trigger the repository's publishing workflow. Maintainers should see the [npm publishing guide](https://github.com/QueCue/dev-notify/blob/main/.github/NPM_PUBLISH.en.md).

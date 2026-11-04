# Changelog

English | [简体中文](CHANGELOG.md)

## 0.2.0 — 2026-11-04

### Added

- `setup` now reads the Telegram bot's recent updates, lists recent chats that have talked to the bot, and supports selecting them with `#1,#3`; it falls back to manual entry when the bridge is running, the bot has a webhook configured, or the network request fails. Only chat_id and name are extracted; message text is never displayed or saved.
- New `notifications` configuration section: `events.stop` / `events.waiting` control completion notifications and waiting reminders; `projects.allow` / `deny` filter by absolute project path prefixes; `quiet_hours` supports local time and ranges that cross midnight.
- New `templates.footer` custom footer template with `{project}`, `{topic}`, `{session}`, and `{time}`. `{time}` prefers the timestamp of the last assistant record at the end of the transcript (when Claude Code actually finished) and falls back to the hook trigger time, never the time the notification is sent.

### Improved

- Quiet hours and project filtering suppress only ordinary notifications; they do not start the reply bridge or create reply buttons. Remote question answering, tool permissions, and lifecycle events are unaffected.
- The transcript is read only when the template contains `{time}`, only up to the last 2 MiB, only under the Claude config directory's `projects` folder, and only to extract the timestamp without reading or sending body text.

### Verification

- Automated regression totals 203 items: 202 passed, 0 failed, and 1 native credential test requiring explicit enablement was skipped.
- Windows x64 / Node 24 real-machine verification covered the four-line footer template, real Telegram/Feishu notifications, and remote-reply state cleanup.

## 0.1.5 — 2026-11-04

### Fixed

- `reply run`, bridge status, and the CLI now show the specific reason a network request failed instead of only a generic failure message; secrets are still never included in the output.

## 0.1.4 — 2026-11-04

### Added

- The interface now supports Simplified Chinese and English: CLI output, error messages, notification content, interaction buttons, and reply bridge messages can all switch language. Set it with `--lang`, `DEV_NOTIFY_LANG`, the `language` configuration field, or `dev-notify language [zh|en]`; Chinese remains the default.
- Added English README, SECURITY, CHANGELOG, and npm publishing documentation, with language links between the Chinese and English versions.

## 0.1.3 — 2026-11-03

### Improvements

- `dev-notify update` now performs hooks and bridge maintenance even when already up to date, making it convenient to finish post-upgrade work with the same command; `--check` still only checks, and `--no-post` skips maintenance.

## 0.1.2 — 2026-11-03

### Improvements

- After a successful installation, `dev-notify update` automatically reinstalls the Claude Code hooks bound to the current configuration and restarts a running reply bridge; a new `--no-post` option skips these maintenance steps.
- `integration claude-code install` / `remove` support `--yes` for automation or `update` maintenance flows.

## 0.1.1 — 2026-11-03

### Added

- Added `dev-notify update`: checks the latest npm version and, after confirmation, invokes the npm global install; `--check` only checks without installing, and `--yes` skips confirmation. Actual integrity verification, registry configuration, and native dependency resolution are still handled by npm.

## 0.1.0 — 2026-11-03

### Improvements

- `setup` merged into a single summary confirmation: by default it saves the notification configuration, sends a test notification, and installs Claude Code notification hooks at the same time, with `--no-test` / `--no-hooks` to skip.
- All hidden input prompts now explicitly say "hidden input, not echoed".
- README and `--help` now include the complete environment variable list and path variable descriptions.
- Editing an existing configuration no longer first asks whether to continue; channel selection shows the current values, and pressing Enter keeps them.
- Remote reply authorization moved out of the main `setup` flow and now prompts you to run `reply setup` separately.
- Unified polish of user-visible Chinese prompts and documentation into more natural, direct wording; security boundaries and operational meaning remain unchanged.
- Removed early prototype source, tests, and documentation; the main branch now retains only the Node/TypeScript implementation; migration prompts for old `system` credential references are retained.

### Fixed

- The Feishu "Reply to Claude in Telegram" jump now sends a normal prompt and clears the client's cached old forced reply target instead of automatically entering the reply box, preventing input from being submitted to the wrong session; Telegram inline buttons still enter reply state automatically. Long-press the prompt or target notification and choose "Reply" before typing.

## 0.1.0-alpha.3 — 2026-11-03

### Added

- Optional Claude Code notification integration: install, query, and remove user-level hooks while preserving other settings.
- Telegram "Reply to Claude", direct replies to notifications, and Feishu jumps to Telegram; remote input requires separate authorization of specific private-chat users.
- Session and process identity binding, queueing replies while Claude is working, anti-replay, and confirmation after Claude actually receives input.
- AskUserQuestion single-select, multi-select, multiple questions, and custom input; tool allow/deny for this time requires additional authorization and does not create persistent permission rules.
- The npm package links to the GitHub source repository, issue feedback entry, and changelog.

### Fixed

- PreToolUse only registers calls, and remote waiting uses PermissionRequest; normal interactive terminals retain the PC native question interface, and both ends can operate.
- Telegram submission distinguishes "registered" from actual effectiveness; feedback reports effective, ineffective, or unknown result, without automatic replay.
- When both ends submit the same answer, only final content consistency is confirmed, without claiming that the source of the answer can be determined.
- Old buttons are invalidated after a local answer, a session switch, or a timeout.
- Suppress duplicate general permission reminders after a question selection based on complete per-recipient delivery results; send failures, uncovered recipients, and subsequent other tool permission reminders are still retained.

### Upgrade

- Existing installations need to re-run `dev-notify integration claude-code install` to install the complete 10 hook types and confirm loading in Claude Code `/hooks`; restart the session if necessary.
- Existing reply bridges need to be stopped and restarted so the background process loads the new version. Saved notification credentials do not need to be re-entered; existing valid reply authorizations continue to work.
- First use of remote replies requires running `dev-notify reply setup` for separate authorization. Users with custom notification configurations should continue to use the original `--config` path in the relevant commands.
- npm install/upgrade itself does not rewrite Claude Code settings or start background services.

### Verification and limitations

- Windows x64 / Node 24: PC-first, Telegram-first, multi-select, custom input, competing different answers, and the duplicate reminder fix have been accepted by the user on a real machine.
- Automated regression totals 157 items: 156 passed, 0 failed, and 1 native credential test requiring explicit enablement was skipped; includes a mock-network loop with the real dev-notify CLI/background process.
- The Claude Code version checked is 2.1.316; other versions and special hosts may use different parallel paths.
- macOS terminal input and the permission flow, as well as the Node 22 minimum version, have not been accepted on a real machine. Real-machine acceptance of tool permission answering is not included in the above question-answering tests.
- After network interruption, force-kill, or authorization revocation, final receipts cannot be guaranteed to be delivered; see SECURITY.en.md for details.

## 0.1.0-alpha.1

- First public npm Alpha: general Telegram/Feishu notifications, long-body segmentation, interactive channel configuration, and system credential storage.
- Does not include Claude Code hooks or remote reply interaction.

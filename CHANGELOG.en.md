# Changelog

English | [简体中文](CHANGELOG.md)

## 0.2.8-beta.1 — 2026-11-07

A bounded fix and finer diagnostics based on the `0.2.8-beta.0` macOS evidence (both send units reset during connection setup and neither request was written). It updates only npm `beta`; the stable `latest` remains 0.2.7.

- Completion-notification Telegram sends reconnect the same unit only when this process confirmed that the request was created, connection setup failed, and no request headers/body were written and no response was received: at most 2 reconnects per unit (about 1 s, then 3 s) and 4 per notification. A written request, a received response, HTTP errors, non-network errors, or missing diagnostics events never reconnect. Content and recipients are unchanged, nothing is queued persistently, and plain CLI `send` is unchanged. The decision uses internal flags rather than the capped stage arrays.
- Connection setup diagnostics are finer: `tcp-connected` and `tls-secure` stages; `connectFailure` (`tcp` TCP connect failure / `read`, `write` read or write error during TLS after TCP was established / `tls-closed` peer closed before TLS completed / `timeout` / `other`); `tcpMs`; `family` for failed or successful connections; and the attempted address-family sequence `attemptedFamilies` (4/6 only, no addresses). A new attempt kind `reconnect` is added; up to 6 attempts per unit and 12 stages per attempt are recorded.
- This mitigates confirmed unwritten failures; it does not identify the reset source. The new fields let the next Mac capture show whether resets happen during TLS and on which address family.
- Full regression on Windows x64 / Node 24.12.0: 384 tests, 383 passed, 0 failed, 1 explicit native-credential test skipped. New tests cover successful reconnects, exhausted allowances, every never-reconnect case, classification and family mapping, real undici loopback (reconnect succeeds after TCP refusal; a TLS-stage RST is classified as `read`), and a real Stop hook delivering after reconnecting. Not yet accepted on a Mac.

## 0.2.8-beta.0 — 2026-11-07

Prerelease for collecting partial-delivery evidence on macOS. It updates only npm `beta`; the stable `latest` remains 0.2.7.

- Completion notifications now record per-send-unit stages for Telegram delivery (`channels.telegram.trace`) so a partial delivery shows which recipient ordinal/part failed and at what stage: unit index, recipient order within the plan (not a chat ID), part number, whether the unit carried a button, the final outcome (accepted, rejected, failed, or skipped after an earlier part to the same recipient failed), and for each attempt its kind (initial, 429 wait-and-resend, plain-text fallback), undici stages (connect, connected, connect error, headers written, body written, response, request error), new or reused connection, prior uses and idle milliseconds for a reused connection, address family, HTTP status, API error code, and allow-listed error codes.
- The observer subscribes to Node's built-in diagnostics events only inside the hook process for the current notification, starting before the identity query so connection reuse can be identified, and unsubscribes when delivery ends. It adds no requests, retries, resends, or timers, and observer errors never affect delivery. It records at most 8 units, 4 attempts per unit, and 10 stages per attempt. Stages describe only events this process observed; they do not establish whether the server received a request or whether resending is safe.
- No temporary `NODE_OPTIONS` or hook change is needed: after a normal update, the next real completion notification writes this into the existing diagnostic files.
- macOS field capture (15:34:55 UTC, first notification after installing this release and running maintenance): reply `attached`, `identityRetries: 1`, `identityFallback: "bridge"`; Feishu delivered with a button; Telegram 0/2. The two units belonged to two recipients with one part each, and both went `create → connect → connect-error → error` with `ECONNRESET` after about 767 ms, with no connected or headers-written stage, so neither request was written to any connection. Both identity queries in the same hook process had also reset while the resident bridge was available. The conclusion is limited to what this process observed: new Telegram connections were reset during connection setup. TCP vs TLS was not distinguished, the failed connections' address family is unknown, the reset source is undetermined, and end-to-end acceptance failed.
- Full regression on Windows x64 / Node 24.12.0: 378 tests, 377 passed, 0 failed, 1 explicit native-credential test skipped. Seven new tests cover both partial-delivery allocations, connect failure, reset on a reused connection, 429 / plain-text fallback, skipped units, bounds, malformed events, unsubscription, and redacted persistence from a real hook.

## 0.2.7 — 2026-11-07

Promote the diagnostics and recovery improvements from `0.2.7-beta.0` through `beta.3`, together with user-interface error codes, to the stable npm `latest` channel.

- Retain safe notification-failure and bridge parent/worker summaries across recovery; distinguish historical failures, failures during retry, and final state when troubleshooting.
- Read-only bridge initialization queries `getWebhookInfo`/`getMe` share one delayed retry for explicit `ECONNRESET`. Completion-notification identity lookup also permits only one explicit-reset retry, with authorization and session revalidation. Only after both button identity lookups reset may the current active bridge's initialization identity be reused under full checks. No additional network replay for notification sending, update consumption, or input.
- Before stable release, a controlled upgrade on macOS / Node 26.13.0 produced a first notification that the user confirmed completed on both channels with buttons, recording `attached` and `identityRetries: 1` without exercising the bridge-identity fallback. Earlier bridge-initialization failures remain documented; the reset source and stable triggering conditions are unknown. This release does not promise removal of the root cause.
- The first real notification after the stable update, at 13:16, did not fully pass: button preparation recorded `attached`, `identityRetries: 1`, and `identityFallback: "bridge"`, confirming actual use of the bridge identity fallback. Feishu completed and the user confirmed its button; Telegram had only 1 API-acknowledged send unit out of 2 planned, with `DN-NET-CONNECTION-RESET`, while the user saw no TG message. This summary does not establish whether the unconfirmed unit was accepted, which recipient or segment it concerned, or whether the earlier worker connection-stage observation applies to this send. No automatic resend was added; the root cause remains unknown and full end-to-end acceptance failed.

- Add fixed `[DN-…]` codes to user-interface errors for configuration, credentials, updates/maintenance, bridges, button preparation, and delivery, consistent across Chinese and English. Unclassified CLI validation/credential failures and unknown system exceptions retain safe fallback codes without underlying exceptions.
- Startup parents display allowlisted failure categories and stages directly from their own worker's new lease. Without reliable details, use a generic code rather than inferring the current cause from historical failures. Readiness timeout explicitly remains unconfirmed, without assuming process exit or recommending another `reply run`.
- `reply status` labels retained lease failures instead of printing their original error text. Button-skip notices add understandable explanations; ordinary send failures display the channel, API-acknowledged part count, and safe category without forwarding arbitrary error text. Error presentation does not change network retries, input, authorization, or exit-code rules.
- README additions cover only error-code reporting and necessary troubleshooting. Keep code-maintenance rules in CONTRIBUTING and allowlist/legacy-lease boundaries in SECURITY. These additions ship in this stable release without changing the published beta.3 package.
- Full isolated regression on Windows x64 / Node 24.12.0 totals 371 tests: 370 passed, 0 failed, and 1 opt-in native credential test skipped. Coverage includes language-independent codes, actual CLI status rendering, legacy-lease/arbitrary-exception redaction, current-child failure propagation, unconfirmed timeouts, no stale-failure reporting after recovery, and no send retries. An actual CLI invalid-argument smoke check preserves exit code 2. New messages have not yet been accepted on a real Mac.

## 0.2.7-beta.3 — 2026-11-07

- Preserve the existing `getMe` query and single connection-reset retry order for completion notifications. Only after both attempts explicitly fail with `ECONNRESET`, revalidate authorization, session, and bridge before allowing the bot username verified during the current active lease's initialization to be reused. Older bridges without that metadata retain ordinary-notification degradation without restarting a live worker. No fallback for 401, invalid usernames, or other errors.
- Bind bridge identity metadata to the full authorization identity and current owner; require confirmed process liveness, a fresh heartbeat, ready state, no error, and no stop request for that owner. Recheck session state in the button-token commit transaction so new local input during the query does not inherit stale buttons. Diagnostics mark actual use only as `identityFallback: "bridge"`, without storing the username.
- Leave network-reset send retry boundaries and the shared communication dependency unchanged. This adds a guarded fallback for identity-query failures, not an established fix or explanation of the macOS reset source. This prerelease updates npm `beta` only, without moving stable `latest`. macOS real-machine feedback: one maintenance run after installation reported bridge startup failure; the 10:34 worker exited on connection reset at `getWebhookInfo`. The first notification reached both channels without buttons and recorded `bridge-unready`, without entering the identity-fallback path. Acceptance failed for this run; the reset source remains unknown.
- A later single beta.2→beta.3 real-machine comparison on macOS / Node 26.13.0 passed: old-version initialization succeeded; the new worker's first `getWebhookInfo` reset at undici's `connectError` stage, before observed connection readiness or request-body transmission. The existing single retry connected successfully and received HTTP 200, followed by successful `getMe` and polling. The first real notification recorded `attached` and `identityRetries: 1`, both channels completed, and the user confirmed buttons on both. No `identityFallback` appeared, so this run validates recovery through existing retries rather than exercising beta.3's identity fallback. Retain the earlier failed run; this neither establishes a root-cause fix nor identifies the failed connection's address family from the successful connection's IPv4.
- Full isolated regression on Windows x64 / Node 24.12.0 totals 353 tests: 352 passed, 0 failed, and 1 opt-in native credential test skipped. Added coverage combines real bridge initialization with simulated default notification transport, buttons on both channels after two resets, no resend on delivery failure, authorization/session-change guards, legacy/invalid lease degradation, and diagnostics without sensitive data. These automated results are not macOS real-machine or actual terminal-input acceptance.

## 0.2.7-beta.2 — 2026-11-07

First-notification handling prerelease; updates npm `beta` only, without moving stable `latest`. macOS real-machine feedback: after installation and one maintenance run, without extra warm-up, the first real notification reached both Telegram and Feishu but had no reply buttons. The summary records `getMe` failing with `ECONNRESET` despite one retry. Button acceptance failed for this run; the issue is not established as fixed, and the reset source remains unknown.

- Extend the single read-only retry for confirmed `ECONNRESET` to completion notifications' `getMe` button identity lookup, rather than only bridge initialization. Revalidate authorization, session identity, input tracking, and bridge readiness after the delay without weakening access controls. Notification summaries record the count as `identityRetries`.
- Ordinary Telegram notifications and bridge requests share the safe connection-reset classification, but notification sending is still not retried on network reset. Other channels are not mislabeled as Telegram resets; the shared communication-library dependency is unchanged.

- Refocus both READMEs on user installation, usage, and necessary troubleshooting. Move source-build/testing guidance to CONTRIBUTING and keep verification history in CHANGELOG instead of adding iteration notes to README.
- Regression totals 320 tests: 319 passed, 0 failed, and 1 opt-in native credential test skipped. Coverage includes full first-notification reset/recovery, bounded persistent failure without message replay, authorization rechecks, and README documentation boundaries.

## 0.2.7-beta.1 — 2026-11-07

Connection-reset handling prerelease; updates npm `beta` only while stable `latest` remains `0.2.6`. macOS real-machine validation is still pending.

- Preserve a safe category for identifiable underlying `ECONNRESET` errors in Telegram bridge requests without storing URLs, tokens, raw exceptions, or server bodies. Other network or certificate failures are not inferred to be connection resets.
- Only read-only bridge initialization queries `getWebhookInfo` and `getMe` may retry once after 500 ms on connection reset, sharing one allowance per startup and rechecking authorization and stop state before retrying. Another failure still exits with retained diagnostics. This adds no retries to notification sending, update consumption, or terminal input, does not establish the reset source, and still awaits macOS real-machine validation.

- Regression totals 307 tests: 306 passed, 0 failed, and 1 opt-in native credential test skipped. Coverage includes underlying-error classification, the shared retry allowance, revocation/stop guards, simulated recovery through the real transport adapter, and no added send retries.

## 0.2.7-beta.0 — 2026-11-07

Diagnostic prerelease using only the npm `beta` tag, without moving stable `latest`. Intended to investigate post-upgrade bridge startup and notification failures; it does not establish or fix their macOS root cause.

- Retain the latest notification failure per session separately from the latest notification snapshot, so subsequent success does not overwrite the failure. No message body, credential, or recipient is saved.
- Retain separate parent/worker bridge failure snapshots with a safe stage, monotonic elapsed time, and outcome, covering authorization, locks, leases, Telegram initialization, and exit. A readiness wait timeout is unconfirmed rather than proof of exit. Recovery preserves the record; diagnostic write failures do not change startup outcomes or trigger retries.

- Windows x64 / Node 24 regression totals 288 tests: 287 passed, 0 failed, and 1 opt-in native credential test skipped. The macOS upgrade scenario still awaits user verification.

## 0.2.6 — 2026-11-07

- Distinguish unavailable session verification from confirmed exit: denied access, query failures, and damaged or incomplete registries pause remote input while retaining unsubmitted queues with their original expiry. New local input still cancels old queues; submitted or unknown-result input is never requeued.
- Hook readiness checks verify accessible Node/CLI files and POSIX Node execute permission. Status reports missing, denied, or invalid paths without claiming to prove actual hook execution or Windows execution-policy acceptance.
- Distinguish existing settings locks, denied write access, and other filesystem failures instead of describing permission errors as stale locks.
- When Windows denies a zero-signal process probe, use the fixed system `tasklist.exe` to confirm the exact PID read-only, avoiding false bridge unreadiness across elevation levels. No elevation or lock preemption; failed queries remain unknown, and only `ESRCH` establishes exit.
- Report reply-button skips separately for unverifiable sessions, missing state, working sessions, unobserved input, and changed process identity, without weakening input safety checks.
- Keep the last completed-notification button reason and channel API-acknowledgment summary locally per session so successful hook exit does not discard diagnostics. No body, token, or underlying exception is saved; diagnostic write failures do not trigger resending.
- Windows x64 / Node 24 regression totals 276 tests: 275 passed, 0 failed, and 1 opt-in native credential test skipped. The user confirmed reply-button recovery when normal and elevated sessions share a bridge; this does not establish acceptance of every terminal-input permission combination, macOS, or the minimum Node version.

## 0.2.5 — 2026-11-07

- Distinguish Telegram `getMe` failures during reply-button preparation, bridge unreadiness, and notification-delivery failures. Retain bounded API error codes and report safe delivery categories and API-acknowledged part counts, without exposing underlying exceptions or server bodies. Do not infer exact send error codes discarded by the communication library.
- Add isolated regressions for Telegram failure with successful buttonless Feishu delivery, bridge unreadiness with ordinary delivery on both channels, and recovery with buttons on both channels. No new retries, replays, or authorization.
- Cover explicit channel rejection, unknown exceptions, and successful API delivery followed by local message-mapping failure without incorrectly claiming non-delivery or resending. Windows x64 / Node 24 totals 247 tests: 246 passed, 0 failed, and 1 opt-in native credential test skipped; not macOS real-machine acceptance.
- This release improves diagnostics; it does not establish or fix the specific cause of historical missing notifications on any particular device.

## 0.2.4 — 2026-11-07

- Recover valid bot locks belonging to confirmed exited processes so a crashed reply bridge does not permanently remove Reply to Claude buttons. Live processes, reused PIDs, unknown permissions, and damaged locks are not preempted; concurrent recovery is serialized.
- Maintain an independent bridge heartbeat and distinguish process liveness from readiness. Bound startup waiting at 15 seconds and ignore errors left by an exited instance while a new instance starts.
- Restore an authorized but stopped bridge during `update` maintenance; wait for the old process to exit rather than treating a stale heartbeat as an exit. After npm installation, verify the current entry's package version and report a mismatch instead of maintaining hooks from an old Node/npm installation.
- Add dead-lock, concurrent recovery, actual isolated child-process termination, heartbeat, stale-error, and update-maintenance regressions. Current totals: 237 tests, 236 passed and 1 opt-in native credential test skipped; not acceptance on every platform.

## 0.2.3 — 2026-11-07

- Change `@quecue/notify-core` from exact `0.1.0` to the compatible range `^0.1.0`, allowing stable releases `>=0.1.0 <0.2.0`. The lockfile still pins the tested `0.1.0`; update package validation and tests accordingly. This does not change the published `0.2.2`.
- Regression on Windows x64 / Node 24 totals 219 tests: 218 passed, 0 failed, and 1 opt-in native credential test skipped; this does not establish real-machine acceptance on every platform.

## 0.2.2 — 2026-11-07

Communication dependency extraction, Windows file-replacement fixes, and documentation updates. Actual version availability is authoritative on the npm registry; the changes below are not included in `0.2.1`.

- Extract Telegram/Feishu communication into the standard npm runtime dependency `@quecue/notify-core@0.1.0`, with source at [QueCue/notify-core](https://github.com/QueCue/notify-core). Do not embed the library or link sibling source; npm users do not install this dependency manually. The CLI entry point, languages, and reply button protocol remain compatible. The library's `0.1.0` has been published through GitHub Actions, and this application's lockfile now pins the official registry source and matching SHA512.
- When a Windows state file is temporarily busy, retry only the same atomic replacement without repeating message or input operations.
- Update Chinese and English installation, dependency, credential cleanup, and security boundary documentation to distinguish published packages from unreleased source.
- Share package-file verification between local maintainer checks and CI, covering application runtime, the standard communication dependency declaration and public documentation; remove the obsolete alpha default from the manual publishing form.
- Regression results for this source revision: 219 tests, 218 passed, 0 failed, and 1 opt-in native credential test skipped. These results do not establish real-machine acceptance on each platform.

## 0.2.1 — 2026-11-04

### Fixed

- Fixed mixed Chinese and English Telegram messages after switching the interface language: the reply bridge is a long-running process and previously read the language only once at startup; it now follows the configured language on every polling cycle, so subsequent messages immediately use the new language after `dev-notify language`. An already running bridge must be restarted once (`reply stop` / `reply start`) to load the fix.

### Verification

- Automated regression totals 204 items: 203 passed, 0 failed, and 1 native credential test requiring explicit enablement was skipped.

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

# Follow-up review of local board QA

This checklist accounts for every inline comment and the summary in
[PR #7170's review](https://github.com/boardsesh/boardsesh/pull/7170#pullrequestreview-5727661145).
Marco merged that PR for the driving-only lightbulb fix and requested the
remaining feedback in a separate PR based on the merged release branch.

| Original comment | Disposition |
| --- | --- |
| [4435308427](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435308427) | Read UUIDs from visible presence text; positive Start plus absent presence proves inactivity. Guarded root metadata omits null IDs. |
| [4435308738](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435308738) | Space fresh wall queries by two seconds across all boards; retain rate-limit code, operation and retry guidance. |
| [4435308998](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435308998) | Subscribe anonymously; authenticated HTTP analytics effects are explicitly documented. |
| [4435309176](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435309176) | Wait for native readiness inside every iPhone restart. |
| [4435309382](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435309382) | Apply zero-link/inactive-Record boundaries to all independent solo cases. |
| [4435309527](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435309527) | Check the run abort before enqueue and immediately before fixture writes; retain read-only diagnostics and owned release. |
| [4435309667](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435309667) | Retain the exact session ID until durable End; record ambiguous creation for recovery. |
| [4435309861](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435309861) | Handle stdin errors, reject dead-child writes, preserve first cause and await owned transport shutdown. |
| [4435310125](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435310125) | Emit typed receiver failures immediately; enforce file and terminal-exclusive serial ownership. |
| [4435310376](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435310376) | Disable gym Arduino/C++ logging; override SDK host logging after sdkconfig. Compile-time guards and a CI native regression using actual gym flags enforce effective levels. |
| [4435310551](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435310551) | Allocate the QA JSON DOM in PSRAM; renew ownership without a snapshot; document bounded snapshot allocation under the mutex. |
| [4435310727](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435310727) | Accept probe exit 1 as absent prerequisites so doctor returns blocked. |
| [4435310995](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435310995) | Block missing display names; redact refresh credentials and clear JWT memory. Account-wide revoke is deliberately avoided; rationale below. |
| [4435311339](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435311339) | Keep never-answered transport timeouts as infrastructure; retry stale reads within the original deadline. |
| [4435311487](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435311487) | Clear kill-path timers and retain cleanup handlers for repeated signals. |
| [4435311634](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435311634) | Reject successful polling reads that return after the deadline. |
| [4435311826](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435311826) | Report missing notification prerequisites as blocked; retry malformed dumps; decode entities once; collapse the shade. |
| [4435312027](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435312027) | Validate hierarchy framing and actual intent errors; allow successful existing-activity delivery warnings. |
| [4435312439](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435312439) | Prepare geometry only while driving; narrow frost inputs and remove redundant aliases/conditions. |
| [4435312679](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435312679) | Remove the unreachable swipe frost branch; update stories and gesture comments for flat progress. |
| [4435312889](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435312889) | Distinguish unreadable archives from missing ABI; accept both ABI flag syntaxes and document explicit APK validation. |
| [4435313018](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435313018) | Supply per-phone locale labels for readiness, picker and Session Summary; document the remaining English suite baseline. |
| [4435313190](https://github.com/boardsesh/boardsesh/pull/7170#discussion_r4435313190) | Add the mocked USB vp task and firmware CI step; document uv/Python and link the runbook. |

The review summary also identified stale instructions in `docs/help-clips.md`,
an overloaded PR test step, and real QA emails in the public sample. The
follow-up corrects the clip instructions, uses separate short tap/see steps,
and replaces the sample emails with `example.com` addresses. Private local
credentials and phone configuration are preserved. The subsequent Codex review
of the original head completed without additional findings.

The current native revoke endpoint revokes every refresh token and disables
notification devices for the account. Calling it during QA cleanup would sign
out the phones. The runner marks refresh credentials secret immediately and
discards them; it does not call that account-wide endpoint. Discarding is not
server-side revocation: these tokens remain valid until expiry. Individual-token
revocation needs a separate backend contract. This is the explicit disposition
of the review's optional revoke suggestion.

Astra independently reviewed the complete follow-up, including firmware/BLE
ownership, renewal, memory handling and logging. Author validation covers the
host suite, mocked USB transport, full mobile suite, types, lint and native
bundles; precise results are included in the follow-up PR.

Initial follow-up verification used source, unit and build checks. The later
device window is recorded below. Earlier evidence remains eight distinct
complete hardware cases, with no complete collaboration case or full 18-case
matrix pass. Simulator smoke and
screenshot commands skip in the current environment; headless bundle checks
are separate evidence and do not replace hardware coverage.

Marco later reconnected the phones for a 20-minute attempt. The Kilter/iPhone
session case passed physical Connect and Start/Join/rosters, then failed an
Android history label missing the configured angle suffix. The exact board/angle
matcher was corrected and proved on Android. Normal iPhone End, Summary dismissal,
durable End and Disconnect passed; final fixture links were zero. A separate
Android-host UI attempt stopped before Start because the history sheet still
covered Record. Normal close restored inactive Record. The host now closes the
observed sheet explicitly, preserving the open-sheet clear oracle; that final
repair has source/unit review and awaits another physical run. Generic Maestro
assertion help also no longer misclassifies a failed assertion as transport loss.
These results add no complete hardware-case pass. Device work and owned processes
were stopped at the end of the availability window.

# Issue 6575: iOS freeze investigation checkpoint

Issue: https://github.com/boardsesh/boardsesh/issues/6575

Status: claimed by `marcodejongh`; investigation incomplete. No application fix,
regression guard, or PR exists. The user approved investigation followed by a
verified fix, then requested a checkpoint and transfer to `vibetunnel-dev` before
a flight. Do not describe this checkpoint as fixing the issue.

## Established evidence

- Feedback 10328 reports iPhone 13, version 2.6.0 (18), freezing after about
  30 seconds even after reinstall. The bottom queue marquee keeps moving.
  Reanimated animation continuing does not prove that JavaScript is responsive.
- Prior-art checks covered issue state, assignees, PR bodies, and sibling
  worktrees. No existing unmerged fix was found. Related #6504 also lacked a
  confirmed reproduction. The issue was claimed with `--add-assignee @me`.
- Native build 18 source is tagged `build-ios-v2.6.0-18-84dca13e7422`, resolving
  to `a988d35c03`. It includes #6372's native touch-handler ownership lease fix.
  The managed-sheet coordinator already serializes presentation; changing it
  without a reproduction would be speculative.
- A coordinator-only read of feedback 10328 established the exact reporter
  account. Identifiers remain in the private transfer artifacts, outside Git.
- PostHog found 14 historical reporter sessions, October 12–16, all version
  2.5.0 (1), Kilter layout 1, iPhone 13 / iOS 26.6.2. No linked recordings or
  reporter events reconstruct the October 18 freeze. Missing telemetry does not
  prove an absence of activity or errors.
- Two historical offline-sync errors correlate PostHog and Sentry within
  matching timestamps and metadata. The likely same physical device emitted a
  handled BLE timeout at October 18 18:46:52.986 UTC, about 27 minutes before
  feedback. It ran build 18, iOS 26.6.2, native runtime
  `84dca13e7422d1aea95e45ecff524eef269f7a71`, nonembedded production OTA
  `04db072a-0657-5371-f660-eda0764cfed5`. No hang near feedback was captured.
  Reinstall can change identifiers; this OTA is the last observed target, not
  proof of the update running when feedback was submitted.
- A different device's Sentry hang captured synchronous Expo file writing and
  recovered after about 4.5 seconds. It is unrelated to this reporter. Both
  PostHog persistence and snapshot sidecars use synchronous `File.write`; the
  native stack does not identify its JavaScript caller.

## OTA provenance still to resolve

[Run 39082281525](https://github.com/boardsesh/boardsesh/actions/runs/39082281525)
records baseline `342d21de-e4f5-2e19-bb1b-e185548f980a` becoming the observed
`04db072a-0657-5371-f660-eda0764cfed5` after the October 18 rollback.
[Run 39082312050](https://github.com/boardsesh/boardsesh/actions/runs/39082312050)
reverted the October 14 canary. Rollback republishes control bytes with a new UUID
and null commit hash.

[Run 38495400716](https://github.com/boardsesh/boardsesh/actions/runs/38495400716)
published numeric update `17919416292721` from `a988d35c03` on October 14 01:34 UTC.
Use the existing read-only `XpremAdminClient.getUpdateDetails` to establish
whether its UUID is the control baseline before calling that the exact source.

Potential existing fix to compare: #6452 / `50397fb911` batches query invalidation
across the full outbox drain. The reporter's earlier BLE timeout included 67
GraphQL responses over 30 seconds; operation names and outbox evidence are needed
before attributing any freeze to query pressure.

## Local checks and their limits

- Source baseline: `f5b88a161ca45d3bd33cd43b3e567b2bb4af9df7`, clean before this
  checkpoint. Dedicated iPhone 13 simulator, iOS 26.5, ordinary Debug app mode,
  local seeded backend. This does not match the reporter's release bytes or OS.
- Existing `sheet-presentation-provider.test.tsx`: 28 tests passed using
  `vp test run --project mobile --reporter=agent`. No new regression test exists.
- Native build stage succeeded, zero errors, 18 warnings. The wrapper was stopped
  after install; do not claim its overall exit was zero. Exported and installed
  executable, debug dylib, and Expo configuration hashes matched.
- One actual player close/reopen loop completed in 101 seconds with 91 seconds
  of repeated input, video, route samples, and a 250 ms JavaScript heartbeat.
  Largest heartbeat gap: 336 ms. Reviewed endpoint screenshots show the list and
  player. Full video review remains pending. Artifact: `runs/player-loop-02`.
- An earlier text assertion failed because XCTest exposes no player text even
  though screenshots show it. It is an automation limitation, not proof of the
  reported freeze. Native-stack and screenshot capture were verified on failure.
- Cold-start, pull-down/immediate-reopen, profile filters, queue/log handoffs,
  background recovery, and three repetitions per scenario remain unverified.
- PostHog is disabled in ordinary Debug builds. Simulator no-repro cannot rule
  out production analytics behavior. Physical BLE is unverified.

## Private transfer artifacts and continuation

The private archive contains `.boardsesh/6575`, QA notes, Metro output, the
feedback lookup script, and this session's history. Generated native app copies
may be retained separately; they are caches, not a fix. Do not commit private
reporter identifiers or raw session history to the public repository.

Read `AGENTS.md`, the single-issue guidance in
`.claude/skills/bug-bash-campaign/SKILL.md`, and the private telemetry notes before
continuing. The user requested one heavy foreground job at a time and `vp`-only
validation. Keep production DB reads with the coordinator.

1. Resolve rollback source provenance, then reproduce the reported behavior.
2. If a cause is verified, implement and obtain paired review. Commit before
   temporarily removing a fix to prove regression guards fail without it.
3. Run scoped checks and follow native fingerprint/review requirements. Open a
   draft PR with Release Notes, Test plan, and Risk. Monitor CI and feedback until
   merged or closed; mark ready when green, resolved, and conflict-free. Never
   merge the PR yourself.

The Mac simulator and local services are stopped for travel. Keep the owned Mac
worktree `/Users/marco/Projects/github/boardsesh/wt-6575` and pane open: no merged
PR exists. Only after GitHub confirms a merge may that exact clean worktree be
removed, followed by `tmux kill-pane -t %201`. Do not remove another worktree or
kill a whole window.

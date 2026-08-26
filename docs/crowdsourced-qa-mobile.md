# Crowdsourced QA — the mobile half

The app side of the flow described in `docs/crowdsourced-qa.md` (which owns the backend, the
GitHub round-trip, and the `qaPreviews` / `submitQaVerdict` contract). This file is only about what
runs on the device.

## What a tester sees

A user whose profile has `isTester`, running a store or TestFlight build with Branch Surfing
headers, gets one prompt per cold start:

- **On production** — a list of the `pr-<n>` OTA branches this build could load. Each row shows the
  PR title, author, risk (`Risk: N/5` from the PR body) and how fresh the branch is, plus chips for
  Draft, a verdict they already filed, and a branch the server refused because it crashed here.
  Tapping one surfs onto it and reloads. **Skip** (or a swipe-dismiss) closes it.
- **On a `pr-<n>` bundle** — the brief: what this PR is and its `## Test plan`, once per branch +
  bundle. From there: **Start testing**, **Finish testing**, **Open on GitHub**, **Leave preview**.

The user drawer keeps both reachable afterwards: **Finish testing #N** / **Test plan #N** while on a
preview, **Test a PR preview** on production. Finishing opens a sheet with Approve / Decline plus
notes, files the verdict, and clears the branch pin.

Everyone else — every non-tester, every dev client, every binary without the surfing headers — sees
none of it, ever.

## Where the pieces live

| Piece                                           | File                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Launch gate (renders nothing)                   | `src/components/qa/QaTesterGate.tsx`                                             |
| The policy, as a pure function                  | `src/lib/qa/qa-gate-decision.ts`                                                 |
| Pick list / brief screens                       | `src/components/qa/Qa{Pick,Brief}Screen.tsx` (routes: `app/qa/{pick,brief}.tsx`) |
| Verdict sheet                                   | `src/components/user-drawer/QaVerdictSheet.tsx`                                  |
| xprem wrapper (the only deep-import site)       | `src/lib/qa/qa-surf.ts`                                                          |
| Branch-name parsing, session keys, row ordering | `src/lib/qa/{pr-branch,qa-keys,qa-pick-rows}.ts`                                 |
| GraphQL hooks                                   | `src/lib/qa/use-qa-previews.ts`                                                  |
| Event names                                     | `src/lib/qa/qa-analytics.ts`                                                     |

## Four things that are easy to get wrong

**The branch list is the spine, not the PR list.** A branch the backend knows nothing about (GitHub
down, PR closed) still gets a tappable row, rendered as bare `pr-N`. Testing must never be blocked
on metadata. A PR with no loadable branch is dropped instead — this build cannot serve it.

**Leaving a preview usually does not reload the app.** `surfTo(config, null)` clears the pin, but
production is not _newer_ than a freshly published `pr-N` bundle, so `checkForUpdateAsync` answers
"nothing available" and the tester keeps running the preview until production publishes again. That
is why a verdict is persisted as `qaVerdictSubmittedKey` (a `<branch>:<updateId>` session key): the
marker, not the reload, is what stops the gate re-prompting and the drawer re-offering.

**`isTester === undefined` is not `false`.** The profile is network-only, so on a cold offline start
it is undefined for a moment. `decideQaGate` returns `wait` there. Treating it as "not a tester"
would silently switch QA off for anyone whose profile lands a second late.

**Nothing prompts before xprem's migration settles.** A surfing-capable binary's first launch clears
a retired channel override and calls `Updates.reloadAsync()`. `app/_layout.tsx` publishes that state
through `src/lib/ota-branch-surfing-state.ts`; the gate waits for `ready` so it never pushes a route
the reload throws away.

## The two settings keys

Both live in `src/settings/types.ts`, both default to `null`, and both hold a
`qaSessionKey(branch, updateId)` — `pr-4792:abc123`, or `pr-4792:embedded` for a launch with no
update id.

- `qaBriefSeenKey` — the brief has been shown for this branch + bundle.
- `qaVerdictSubmittedKey` — a verdict has been filed for this branch + bundle.

Keying on the bundle rather than the branch is deliberate: when the author pushes again, that is a
different thing to test, so the brief shows again and a second verdict is possible.

## Telemetry

`QA Preview Prompted` → `QA Preview Picked` (or `QA Preview Skipped`) → `QA Brief Shown` →
`QA Verdict Submitted`. `QA Surf Failed` and `QA Preview Left` are the two ways out without a
verdict, and telling them apart is the point: a surf failure is our bug, leaving on purpose is not.

## In a dev build

`qaSurfingAvailable()` is false, so every surf action renders disabled with a hint rather than
throwing. The screens are still openable — More → **QA: pick a PR (dev)** — so the layout and the
empty/error states can be checked without a store build.

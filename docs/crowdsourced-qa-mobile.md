# Crowdsourced QA — the mobile half

The app side of the flow described in `docs/crowdsourced-qa.md` (which owns the backend, the
GitHub round-trip, and the `qaPreviews` / `submitQaVerdict` contract). This file is only about what
runs on the device.

## Who sees what

Two different questions, and they have different answers.

**The entry point is open to everyone.** Any user on a store or TestFlight build with Branch Surfing
headers gets **Test a PR preview** in the user drawer and under **Previews** on the More tab. It
opens the pick list: the `pr-<n>` OTA branches this build could load, each row showing the PR title,
author, risk (`Risk: N/5` from the PR body) and how fresh the branch is, plus chips for Draft, a
verdict they already filed, and a branch the server refused because it crashed here. Tapping one
surfs onto it and reloads.

The row stays put when that list is empty, and that is the point. The screen is the only surface
that can SAY *"Previews are switched off"* or *"Nothing to test right now"* — xprem's blue edge
marker renders nothing at all in exactly those cases, so while this was tester-only, "no button" and
"no previews" were indistinguishable from the outside and reports read as "the preview option is
gone". Hiding it now needs a real reason: a binary that cannot surf, where the row would offer
something the app genuinely cannot do.

**The cold-start prompt is still tester-only.** A user whose profile has `isTester` gets one prompt
per cold start without asking for it — the pick list on production, or on a `pr-<n>` bundle the
brief: what this PR is and its `## Test plan`, once per branch + bundle, with **Start testing**,
**Finish testing**, **Open on GitHub**, **Leave preview**. Everyone else reaches the same screens
when they go looking, and is never interrupted. `decideQaGate` owns that line.

**Filing a verdict is open; moving the label is not.** Anyone signed in can finish testing —
Approve / Decline plus notes — and it is recorded and posted as a comment on the PR. Only a tester's
verdict moves the `qa-approved` / `qa-declined` label, because that label gates a merge on a public
repo. The backend records which it was on the row (`qa_verdicts.by_tester`); see
`docs/crowdsourced-qa.md`.

Once a verdict is filed for the running bundle the drawer drops back to **Test a PR preview**, even
though the app is usually still running that preview — see the second gotcha below.

Signed out, the pick list still works: the branch list is an unauthenticated device endpoint, so the
rows render as bare `pr-N` without their PR metadata. Dev clients and any binary without the surfing
headers see none of it.

## Where the pieces live

| Piece                                           | File                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Launch gate (renders nothing)                   | `src/components/qa/QaTesterGate.tsx`                                             |
| The policy, as a pure function                  | `src/lib/qa/qa-gate-decision.ts`                                                 |
| Pick list / brief screens                       | `src/components/qa/Qa{Pick,Brief}Screen.tsx` (routes: `app/qa/{pick,brief}.tsx`) |
| Verdict sheet                                   | `src/components/user-drawer/QaVerdictSheet.tsx`                                  |
| xprem wrapper (the only deep-import site)       | `src/lib/qa/qa-surf.ts`                                                          |
| Branch-name parsing, session keys, row ordering | `src/lib/qa/{pr-branch,qa-keys,qa-pick-rows}.ts`                                 |
| Search parsing, filtering, list state           | `src/lib/qa/qa-pick-rows.ts` (`parsePrQuery`, `filterQaPickRows`, `qaPickListState`) |
| The search field itself                         | `src/components/SearchField.tsx` (shared with climber search)                    |
| Which QA rows a menu offers                     | `src/lib/qa/qa-drawer-rows.ts`, `src/lib/qa/use-qa-menu.ts`                      |
| GraphQL hooks                                   | `src/lib/qa/use-qa-previews.ts`                                                  |
| Event names                                     | `src/lib/qa/qa-analytics.ts`                                                     |

## Searching, and the PR that isn't in the list

The pick list has a search field that matches the PR's **title** and its **number**.
`5203`, `#5203`, `pr-5203` and `PR 5203` are all the same query. Titles match as an AND of
whatever words you type, so `fix queue` finds "Fix the queue reducer".

Numbers match by **prefix**, never by their tail: `520` finds #5203, `203` does not. That is not
fussiness. The list has to be able to narrow all the way to zero, because reaching zero matches is
what offers the escape hatch below — under substring matching, `5` would keep #4795 and #1523
alongside #5203 and the hatch would be unreachable for exactly the short queries that need it.

Only rows that exist can be searched by title. A PR with no preview has no title on the device
(`qaPreviews` is asked about the branches we have), so its title finds nothing. The number is the
only handle that works for a PR this build has never heard of — which is what the next section is
for.

**When a number matches nothing, the screen offers to load `pr-<n>` anyway.** It re-asks the
update server first, because the branch list is cached for 30s and the commonest honest reason a
PR is missing is that it published a moment ago; if it turns up, the ordinary path takes over. If
it still is not there, `surfToUnlistedPr` pins it speculatively — and puts the pin back if the
server has nothing to serve.

## Seven things that are easy to get wrong

**The branch list is the spine, not the PR list.** A branch the backend knows nothing about (GitHub
down, PR closed) still gets a tappable row, rendered as bare `pr-N`. Testing must never be blocked
on metadata. A PR with no loadable branch is dropped instead — this build cannot serve it.

**Except a PR that is mid-publish.** That one is the exception the rule needed: a tester who just
pushed has no branch yet, and dropping it left them staring at an empty list wondering whether
previews were broken. `qaPreviews(includeBuilding: true)` returns those PRs too, and they render as
a dimmed, unpressable **Building** row. A PR that already has a branch AND a newer bundle building
stays tappable on the published one and shows **Building newer** — never block testing on a build
that has not landed.

The signal is the `pr-preview` GitHub deployment that `mobile-ota-preview.yml` opens before it
publishes, read by `packages/backend/src/services/github-ota-deployments.ts`. It is the same state
store that workflow's own fork reconciler and cleanup job key off, rather than a second source of
truth. `failed` and `unavailable` (native change, behind main, torn down) are carried on
`QaPreview.otaBuild` but render no row of their own today.

**Rows mirror the PR's GitHub labels.** Whatever is on the PR shows up as chips, so a tester sees
`backend` — CI stamps that on any PR that changes `packages/backend`, `packages/db` or
`packages/shared-schema` *as well as* the app, meaning the preview bundle alone will not exercise
it until the server ships. `visibleLabels` puts `backend` first, caps the row at six chips, and
drops `qa-approved` / `qa-declined` because the row already renders this tester's own verdict.
`labelChipColor` uses GitHub's own hex unless it is too pale to read, in which case the theme's
colour wins.

**Leaving a preview usually does not reload the app.** `surfTo(config, null)` clears the pin, but
production is not _newer_ than a freshly published `pr-N` bundle, so `checkForUpdateAsync` answers
"nothing available" and the tester keeps running the preview until production publishes again. That
is why a verdict is persisted as `qaVerdictSubmittedKey` (a `<branch>:<updateId>` session key): the
marker, not the reload, is what stops the gate re-prompting and the drawer re-offering.

**A speculative pin has to be undone, and not with `surfTo`.** A branch pin is persistent. `surfTo`
sets the header BEFORE `checkForUpdateAsync` and restores it only inside its own `catch`, so a
branch that answers "nothing available" leaves the device pinned to it across relaunches. For a
real branch that is wanted — its next publish lands on relaunch. For a branch that does not exist
it is a device that has silently stopped receiving production updates, which is why
`surfToUnlistedPr` exists and why it drives the pin, the check and the reload itself: xprem tracks
the previous pin in a module-private variable, so a restoring `surfTo(previous)` would record the
BOGUS branch as its own rollback target and re-pin it if the restore threw. The restore target is
`readLoadedState().branch` — the branch that actually served the running bundle — because xprem's
own bookkeeping reads as `undefined` on a fresh launch even while an override persists.

**`isTester === undefined` is not `false`.** The profile is network-only, so on a cold offline start
it is undefined for a moment. `decideQaGate` returns `wait` there. Treating it as "not a tester"
would silently switch the cold-start prompt off for anyone whose profile lands a second late. The
menu entry does not consult `isTester` at all, so it is unaffected — only the prompt is.

**Nothing prompts before xprem's migration settles.** A surfing-capable binary's first launch clears
a retired channel override and calls `Updates.reloadAsync()`. `app/_layout.tsx` publishes that state
through `src/lib/ota-branch-surfing-state.ts`; the gate waits for `ready` so it never pushes a route
the reload throws away. `ready` also covers the store's pre-launch state — `OtaBranchControlCenter`
is the LAST root sibling, so its publishing effect runs after the gate's — which is why
`decideQaGate` waits on `surfingReady` alone rather than on `surfingBuild && !surfingReady`. Reading
an unpublished store as "this build cannot surf" would resolve to `none`, and the gate marks the
session decided on a `none`: QA would switch itself off with nothing said anywhere.

## The two settings keys

Both live in `src/settings/types.ts`, both default to `null`, and both hold a
`qaSessionKey(userId, branch, updateId)` — `9f3c…:pr-4792:abc123`, or `9f3c…:pr-4792:embedded` for a
launch with no update id.

- `qaBriefSeenKey` — the brief has been shown to this account for this branch + bundle.
- `qaVerdictSubmittedKey` — this account has filed a verdict for this branch + bundle.

Keying on the bundle rather than the branch is deliberate: when the author pushes again, that is a
different thing to test, so the brief shows again and a second verdict is possible.

Keying on the account is not tidiness either. The settings store is device-wide and a phone at a gym
gets shared: without the user id, tester A signing off `pr-4792` swallowed tester B's brief and hid
B's "Finish testing" row the moment B signed in. Every read passes the current profile id, and while
that id is unknown the markers read as **wait**, never as "unseen" — `decideQaGate` returns `wait`,
`runningQaPrNumberToOffer` returns `null`, and the verdict sheet refuses to submit. Nothing migrates
the old two-part keys; they stop matching, which re-arms the brief once per branch + bundle.

## Telemetry

`QA Preview Prompted` → `QA Preview Picked` (or `QA Preview Skipped`) → `QA Brief Shown` →
`QA Verdict Submitted`. `QA Surf Failed` and `QA Preview Left` are the two ways out without a
verdict, and telling them apart is the point: a surf failure is our bug, leaving on purpose is not.

`QA Preview Skipped` fires only for the **launch prompt**, which the gate marks by pushing
`/qa/pick` with `origin=launch` (`LAUNCH_ORIGIN`). The same screen opened by hand — the drawer's
"Test a PR preview", the dev row on More — emits nothing when it is closed, and a non-tester bounced
off the route guard emits nothing either. Otherwise the denominator counted prompts that were never
shown and prompted → picked/skipped stopped adding up.

## In a dev build

`qaSurfingAvailable()` is false, so every surf action renders disabled with a hint rather than
throwing. The screens are still openable — More → **QA: pick a PR (dev)** — so the layout and the
empty/error states can be checked without a store build.

## No PRs listed?

The screen has three states and they come straight off the update server, so diagnose it there
rather than on a device — `/branch_lists` needs no credentials:

```bash
vp run mobile:ota-surf-doctor -- --platform ios --runtime-version <hash>
```

- **"Previews are switched off"** — Branch Surfing is off for the `production` channel. Turn it on in
  the xprem dashboard: Channels → select `production` → Branch surfing → on, pattern `pr-*`. The card
  sits inside the selected channel's detail pane, not on the channel list.
- **"Nothing to test right now"** — surfing is on, but nothing matches this build. Either no PR has
  published a preview, or a native change has landed on `main` since they did: a `pr-<n>` branch is
  offered only to a binary whose runtimeVersion matches it exactly, so every un-rebased PR goes
  invisible at once. Rebasing those PRs onto `main` republishes them.

Take `<hash>` from a native build's `EXPO_UPDATES_FINGERPRINT_OVERRIDE`. Run the command bare to
check only the switch — the branch list needs a real fingerprint, so the script declines to read it
without one rather than showing you a misleading empty list. Full detail:
`docs/mobile-ota-updates.md` ("Previews go stale when `main`'s fingerprint moves").

# Sessions & board control: "preview before you send"

Status: proposal for discussion · Surface: Boardsesh mobile (React Native) · Sessions
are cross-platform, so web is noted where it matters.

## TL;DR

In a shared session, tapping a climb to look at it instantly takes over the wall for the
whole crew. We want **browsing to be safe** and **changing the wall to be deliberate**.
The good news: the pieces to do this already exist in the app — a view-only preview
drawer, a commit button, and a "who's on the wall" indicator. This is mostly wiring, not
new machinery. It does **not** bring back the old "driver" role.

There's one real open question — *should solo taps still light the wall instantly, or
should every tap preview?* — that this doc lays out with data so we can decide together.
The recommended rollout is **measure first**: ship the safety net (instrumentation +
a louder takeover signal + undo) before flipping the default.

## The problem

> "If I'm the one connected to the board and I go search for the next climb, tapping one
> just to look at it puts it straight on the wall, usually while someone's mid-send.
> Browsing is destructive right now."

That's exactly what the code does today. A tap on a climb sets it as the current climb,
broadcasts that to every session peer, and the phone holding the Bluetooth link writes it
to the LEDs — all on one tap, with no confirmation, last-writer-wins. There's no way to
*just look*.

## How it works today (verified)

- **Tap → wall, in one step.** Tapping a search/list row calls `setCurrentClimb`, which
  dispatches the change locally, broadcasts `SET_CURRENT_CLIMB` to peers, and the
  holder's auto-sender pushes frames to the board. Silent, immediate, last-writer-wins.
- **"Always-live" sessions (post PR #2875).** Any participant can change the wall. There
  is no "driver" — that role system was removed in June (net −3,938 lines) because it was
  complex and added friction. Whoever's phone holds the BLE link is the "connection
  holder" / relay; the holder is just "last phone to connect," nothing exclusive.
- **A preview already exists.** The play drawer can open a climb **view-only**: it renders
  the holds in-app with a "Preview" badge, lets you swipe through locally, and a
  **"Set active"** button promotes it — without touching the queue, the server, or the
  board. Today this path only triggers when you open a playlist for a *different* board.
- **"Who's on the wall" already exists.** A capsule shows who lit the wall and what's lit,
  separate from your own browsing. It's just quiet.
- **Adding to the queue is already non-destructive.** Swipe-left enqueues a climb without
  changing the current climb or the wall. The queue is the shared list the crew builds.

So the building blocks are there. What's missing is: routing a tap to preview by default,
turning "Set active" into a deliberate "Send to the wall," making takeovers loud, and
(separately) a way to free a hogged board.

## What the data says

From PostHog (last 30–90 days, this is real production usage):

- **Multiplayer is real but mostly small.** ~1,429 sessions in 90 days had a remote
  joiner. ~1,375 were exactly two people; ~54 had three or more (up to 7). Peak ~470
  session-joins/week. Most "sessions" are solo (a session of one).
- **Mobile is now the main way people drive the board.** Native 2.0 launched June 8;
  mobile went from 0 to ~523 weekly wall-setters and overtook web by late June. Whatever
  we decide, mobile is where it matters most.
- **The old wall-control handshake is already gone from mobile** (it flatlined June 24–26
  as an OTA update removed it); web still runs its own older "Wall Control / Wall Advance"
  chrome. Sessions are cross-platform, so a mobile change shares a room with web.
- **We can't yet measure the actual harm.** Board-control events (`Set Active Climb`,
  `Board Now Playing Received`, `Wall Advance`) carry **no session id and no participant
  count**, so we can't see how often a tap clobbers a peer mid-send. The pain is reported,
  not yet quantified. That's the first thing to fix — it gates the bigger decision below.

## The model: a tap previews, a Send changes the wall

One rule: **tapping a climb previews it; the wall only changes when you deliberately
Send.** An accidental tap can only ever preview. Replacing what's up always takes a
separate action you can't trigger by fumbling — and that action doubles as a deliberate,
announced takeover of the board.

**Key insight: in a session, who holds the board doesn't matter for this.** A tap is
disruptive either way — if you hold the link it relights your own wall mid-send; if a
peer holds it, your change makes *their* phone relight; if nobody holds it, you still
yank the shared current-climb on everyone's screen. So the line is simply **"is anyone
else here,"** not "who's connected." (This is why the holder who taps to browse — Helter's
exact case — needs preview too.)

### The "Send to the wall" action

In the preview drawer, the existing "Set active" button becomes a primary **"Send to the
wall"**. Pressing it:

1. Makes the previewed climb the shared current climb (commits + broadcasts to peers).
2. Makes sure the wall lights: if you already hold the link, the auto-sender pushes it; if
   not, it connects (becomes the holder — last-connection-wins, the deliberate takeover)
   and sends. If there's no board to connect to (e.g. a web peer), it just sets the shared
   current climb, same as today.
3. Announces the takeover to the crew (see "Announced takeover" below).

If there's no one else in the session and no board connected, "Send" is labeled
"Set as current" and simply does that.

### The open question (let's decide this together)

Should **solo** taps still light the wall in one step, or should **every** tap preview?

**Option A — "Auto" (solo unchanged, preview in sessions).** Tap = wall when you're alone
(matches Kilter / Aurora); the preview step appears only when someone else is in the
session.
- *For:* no extra tap on the dominant solo flow; familiar; preview only shows up when it
  protects someone.
- *Against:* "session" is an invisible mode — behavior changes under your fingers the
  moment a second person joins. Mitigation: make the mode legible (the wall capsule says
  "Shared wall — tap Send to change"), so the switch is visible, not silent.

**Option B — "Preview everywhere" (one consistent rule).** Tap always previews, even solo.
- *For:* one mental model, no invisible mode, arguably less branching in code.
- *Against:* one extra tap on every solo send — the 95% flow — to fix a multiplayer-only
  harm. Risk of a confusing solo first-run: tap a climb, nothing lights, "is the app
  broken?" Mitigation: a one-time coachmark and an obvious "Send" button, but the friction
  is real.

**Either way, a single setting reconciles it.** Add one "When I tap a climb" preference
with three values: **Preview in sessions (auto)** / **Always preview first** / **Send
straight to the wall**. Whichever we pick as the **default**, the other camp can opt into
their preference. The decision is only *which is the default*.

A way to settle it with data rather than taste: **ship the session-id instrumentation
first** (Phase 1). If it turns out cross-person clobber is rare, defaulting the dominant
solo flow to preview isn't justified, and "auto" (or even announce-only) is enough. If
it's common, the case for a stronger default gets concrete. Tie the default to an agreed
threshold instead of arguing it cold.

> A note on the setting: keep it **device-local and personal** — it changes only what
> *your* taps do, never what peers must do. Do **not** make it a session- or host-level
> policy ("host turns preview on for the room"). That's the driver/host-permission concept
> by another name, and it's exactly what we just deleted.

### Decision table (for the "auto" default)

| You're… | Board holder | Tap does | Wall changes? |
|---|---|---|---|
| Solo (no one else) | You / nobody | **Send** (1 tap → wall) | Yes (if connected) |
| In a session (≥1 other) | You | **Preview** | No, until you Send |
| In a session (≥1 other) | A peer / nobody | **Preview** | No, until you Send |

Under "always preview" every cell is Preview; under "send straight" every cell is Send.

### This is not the driver feature

The preview-vs-send choice is a **local decision on the tapping device** based on your own
setting and whether anyone else is present. It's identical for every participant — nobody's
tap is gated by anyone else's state, there's no role, no "take control" grant, no handoff.
Send stays last-writer-wins: anyone can Send anytime, a later Send supersedes an earlier
one. The announced takeover is a *notification*, not a lock.

### Edge cases worth stating

- **A peer changes the wall while you're previewing.** Your preview is local and isn't
  disturbed — you keep swiping. You see the takeover toast and the "on the wall" capsule
  update. Your eventual Send is last-writer-wins from that moment.
- **You hold the board and tap to browse (Helter's case).** In a session this previews;
  Send writes via your already-connected link with no reconnect. Solo, it sends in one tap.
- **Queue vs current stay distinct.** Swipe-left = add to the shared queue (unchanged).
  Tap = preview. Send = put it on the wall now. Three clear verbs.
- **Re-tapping the climb that's already up:** preview of the same climb; Send re-asserts it
  (handy if the wall secretly went dark).
- **Cross-board / incompatible climb:** preview renders the holds; Send is hidden in favor
  of the existing "switch board" overlay, so you can't push an incompatible climb.

## Announced takeover (make it loud)

Today a wall change is silent last-writer-wins. Because (under preview-default) the only
way to change the shared wall in a session is a deliberate Send, we can announce every one
of them without false positives:

- When someone Sends, peers get a short toast — **"{name} put up {climb}"** — plus a light
  pulse on the lightbulb / capsule. The actor's name and the climb name are already in the
  `CurrentClimbChanged` event we broadcast, so this needs **no backend change**. (One
  refinement to consider: use a dedicated "takeover" event rather than the every-relight
  confirm signal, so auto-advances don't over-notify.)
- Self-echoes are suppressed (we already tag who changed it).

This alone makes the system legible: even with no other change, you'd at least *know* who
moved the wall and to what.

## Undo / "restore my climb"

For the person who just got clobbered: a quick **"restore"** that re-asserts the prior
shared climb. In the always-live model that's a re-assert broadcast, and the re-assert /
undo plumbing already exists. This is the lowest-tax relief — it heals the bad moment
without adding a tap to anyone's happy path.

## Optional: auto-disconnect timer

Separate problem, same neighbourhood: a board that stays claimed after everyone's done with
it. Proposal: a configurable **auto-disconnect timer** — after N minutes with no sends, the
holding phone drops the BLE link and frees the board — with a **countdown shown on the
lightbulb** as it nears expiry.

- Setting values: **Never (default)** / 5 min / 15 min / 1 hour. Default Never means this
  is inert until someone opts in.
- **Important risk, called out:** a session has only **one** BLE relay. Auto-dropping it
  darkens the wall for *everyone*, not just the idle user. Guards: measure *idle* time
  (no sends), so an actively-driven session never auto-disconnects; warn via the countdown
  before it fires; the current climb is preserved so any peer can re-light with one tap.
- This solves "free a hogged board" (gym etiquette), **not** destructive browsing. Keep it
  opt-in and clearly separate so its edge cases don't hold up the main fix. It composes
  cleanly with the tap model (it only changes *who holds*, which doesn't affect routing).

## Recommended rollout (measure first)

**Phase 1 — safety net (low risk, mostly already built).**
- Add `session_id` + `participantCount` (and `isHolder`, `previewedFirst`) to board-control
  events, and standardize the session-id key across web (`session_id`) and mobile
  (`sessionId`). This makes the harm measurable.
- Make the takeover **loud** (the toast + pulse above).
- Add **undo / restore-my-climb**.
- Result: we can finally measure cross-person churn, and the worst moment is healed — with
  zero extra taps for anyone.

**Phase 2 — preview-default (after the data).**
- Ship the tap-routing model and the "Send to the wall" button behind the new setting.
- Choose the **default** ("auto" vs "preview everywhere") using Phase-1 data against an
  agreed threshold, instead of guessing.

**Phase 3 — optional / parallel.**
- Auto-disconnect timer + lightbulb countdown.

**Web parity** is a non-blocking follow-up. The mobile preview decision is purely local
(a previewing phone simply doesn't broadcast until Send), so a preview-default mobile
client and a current web client share a session fine. Mirroring the takeover toast on web
and adopting the standardized session-id key are nice-to-haves, not blockers.

---

## Appendix A — Implementation notes (mobile, file-path level)

All paths under `packages/`. Every file below was read while writing this; cited behavior
is confirmed.

**Tap routing (Phase 2).**
- New pure helper `mobile/src/lib/playlists/resolve-tap-activation.ts`:
  `resolveTapActivation({ mode, isMultiplayer, isHolder }) -> 'preview' | 'activate'`.
  Recommended rule treats the holder like everyone else in a session (preview), matching
  the "holder is a red herring" insight; an "exempt the holder" variant is a one-line
  change if we decide otherwise.
- `mobile/src/lib/playlists/use-playlist-activation.ts` is the single chokepoint every list
  tap funnels through (`activate(toQueueClimb(climb))`). Add a `previewInSession` option;
  read `isMultiplayer` from `useQueueSessionControls().sessionMemberUserIds.size > 1`,
  `isHolder` from the Bluetooth context's `isConnected`, and the setting from the new
  preference. Insert a preview branch **before** the existing activate path that reuses the
  same `openPlayDrawer({ previewQueueItem, playlistSuggestionSource })` call the wrong-board
  branch already uses (lines ~391–414), against the active board.
  `mobile/app/(tabs)/climbs/index.tsx` (the search/list screen, `handleClimbPress` ~line
  664) opts in by passing `previewInSession`.
  Also update `mobile/src/components/play-drawer/use-queue-sheet-handlers.ts` (its
  `handleClimbPress` is the chokepoint for the in-drawer queue list **and** the play
  screen — `mobile/app/play.tsx:87` pulls it and wires it to `onClimbPress` at line 132,
  so updating the handler covers both) and the board-sheet tap, so queue / play-screen /
  board-sheet taps aren't left destructive.

**"Send to the wall" (Phase 2).**
- `mobile/src/components/play-drawer/PlayDrawer.tsx`: evolve `handleSetActive` (line 536,
  currently `setCurrentClimb(drawerPreviewItem, …)`) into `handleSendToWall`: keep the
  commit, then if not connected call `bluetooth.connect(frames, mirrored,
  reconnectSerialForCurrentBoard)` to take the link and light it; fire the announce.
- `mobile/src/components/play-drawer/PlayDrawerPreviewBanner.tsx`: relabel the action
  "Send to the wall" (primary) when a board is connectable; keep "Set as current" otherwise.
  Keep the existing `showSetActive={!boardMismatch}` gate.

**Announced takeover (Phase 1).**
- New `mobile/src/hooks/use-takeover-announcements.ts`, mounted once under the queue
  provider: subscribe to queue events, on `CurrentClimbChanged` from a peer (not self),
  toast "{holderDisplayName} put up {climb name}". Name comes from the existing board-
  presence holder (`useBoardConnectionState().holderDisplayName`) / the event payload.
  Consider a dedicated `WallTakenOver` session event if over-toasting on auto-advance shows
  up.

**Undo (Phase 1).**
- Reuse the existing re-assert / `undoWallChange` path in
  `mobile/src/providers/bluetooth-provider.tsx`; surface a "restore" affordance on the
  clobbered peer (e.g. on the takeover toast or the capsule).

**Settings (Phase 2 / 3).**
- New `mobile/src/lib/tap-preview-preference.ts` and
  `mobile/src/lib/ble-auto-disconnect-preference.ts`, both modeled exactly on
  `mobile/src/lib/grade-format-preference.ts` (module store + `useSyncExternalStore` +
  `preference-store.ts` AsyncStorage). Defaults: tap = `preview-in-session` *or*
  `always-send` depending on the default we choose; auto-disconnect = `Never (0)`.
- Add rows to `mobile/app/(tabs)/profile/more.tsx` next to the Grade format / Display
  options sections (segmented for tap mode, select for the timer). Add i18n keys under
  `mobile.more.*`.

**Auto-disconnect timer (Phase 3).**
- New pure helper `mobile/src/lib/ble/auto-disconnect-timer.ts` (deadline math + the
  idle-only / never-drop-mid-active-session guards, fully unit-testable).
- `mobile/src/providers/bluetooth-provider.tsx`: arm on connect, reset in
  `handleWallConfirmed` and `reassertWall`, fire `wrappedDisconnect()` on expiry, clear on
  board change / unexpected drop. Expose `autoDisconnectDeadline` on the context value.
- Countdown UI: thread the deadline through `use-board-connection-state.ts` and
  `use-lightbulb-control.ts`; add a `countdownSeconds` prop + a pure
  `getLightbulbCountdownLabel` to `mobile/src/components/ble/ble-lightbulb-button-state.ts`
  and render it on `BleLightbulbButton.tsx` (1 Hz tick gated to the last ~60s).

**Instrumentation (Phase 1).**
- `packages/shared/analytics/src/events.ts`: add `Climb Previewed` and `BLE Auto Disconnect
  Fired`. Enrich `Set Active Climb` at its mobile call site (`queue-provider.tsx` ~line
  1480) with `session_id` + `participantCount` (both in scope there) and, via a new
  optional `analytics` field on `SetCurrentClimbOptions`
  (`packages/shared/queue/src/types.ts`), `isHolder` + `previewedFirst`. Standardize on
  `session_id` (snake_case) across platforms; on mobile add it alongside the existing
  `sessionId` for one release before dropping the old key.

**Validation.** `vp run typecheck:mobile` → `vp run test:mobile` →
`vp run check:mobile-bundle`. Unit-test the three pure helpers (routing truth table, timer
math, countdown label). Extend the queue-provider and bluetooth-provider test suites. QA
matrix: {solo, 2-person} × {holder, non-holder} × {BLE on, off} × {each tap mode}.

## Appendix B — PostHog reference (so the numbers are reproducible)

Project 412845. Board-control / session events and the keys that matter:
- `Set Active Climb` — `source` ∈ {`mobile`, `setCurrentClimb`}, `layoutId`; **no session id
  today** (the gap Phase 1 closes).
- `Wall Control Taken` (`mode` ∈ {`party`, `solo`}, `source` `lightbulb_drawer`),
  `Wall Control Released`, `Wall Confirmed`, `Wall Confirm Timeout`, `Wall Advance` — the
  older "wall control" chrome; **web-only now** (mobile stopped emitting these June 24–26).
- `Board Now Playing Received`, `Board Lightbulb Connect`, `Bluetooth Disconnected`
  (rich disconnect reason/source), `Session Started` / `Joined` / `Ended` (only Joined/Ended
  carry a session id, under mismatched keys `session_id` / `sessionId`).

Headline queries run while writing this (re-run after Phase 1 to validate the new props):
- Multiplayer size distribution from `Session Joined` over 90d: ~1,375 two-person, ~54 with
  3+ remote joiners (up to 7).
- Weekly `Session Started` / `Session Joined` and `Set Active Climb` users by `$lib` to show
  the mobile-overtakes-web crossover after native 2.0 (June 8).

## Relationship to other specs

There's an earlier proposal in `docs/collaborative-picks-spec.md` (written May 7–14) that
tackles the same root problem — accidental sends / destructive browsing in shared
sessions. It proposes a different model: **per-user picks + an "active climber"** whose
pick is on the LEDs, with `claimTurn` / `yieldTurn` handoffs (a web-focused change with new
DB tables and GraphQL types). That doc **predates the always-live decision** (PR #2875,
June 15) — its "active climber" is the kind of role/turn-taking the team deliberately
removed, and it's referenced only by `docs/queue-control-bar-pivot.md`, which is itself
marked superseded.

This spec is the current direction: it stays inside the always-live, no-roles model and
solves the same pain by making **browsing safe** (preview) and **changing the wall
deliberate** (Send) — without per-user picks or a turn-holder role. Treat
`collaborative-picks-spec.md` as historical context, not a competing plan.

## Appendix C — History (why no "driver")

The "you're driving" / driver role (added May 16: `Session.driverParticipantId`,
`takeControl`/`releaseControl`, role gating) was removed in **PR #2875** (June 15, "Retire
driver/preview; make group sessions always-live", net −3,938 lines) because the role
branching was complex to build, test, and use. It was replaced by the always-live model +
the board-presence connection holder. Inert deprecated GraphQL shims remain for stale
clients. **This proposal stays inside the always-live model and adds no roles.**

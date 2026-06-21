# Queue Control Bar Pivot — Bar Mirrors the Wall, Lightbulb Controls the Driver

> **Superseded (2026-06): the driver / preview-only model described below has been retired.** Group sessions are now always-live — any participant's climb change broadcasts to everyone and is relayed to the board by whoever holds a BLE connection. The lightbulb is now a send/re-assert affordance, not a driver claim; when the relaying connection drops, a `WallDisconnected` session event turns the lightbulb off for everyone while preserving the current climb. See docs/websocket-implementation.md for the current model.

**Status:** Phases 1–3 + simplified Phase 4 shipped in #2198 on 2026-05-18. A follow-up PR (2026-05-23) closes the remaining gaps: Phase 3 queue-list 5-item history + center-on-open, Phase 5 `Wall Advance` + `Session Board Serial Set` events, bar prev/next "on the wall" aria-label polish, hand-off toast (Open Q2), stale board-serial defensive clear (Open Q5), `isLeader` audit. See the "What shipped vs spec" appendix at the bottom for the full divergence list. Earlier stack (#2188, #2195, #2197) collapsed into #2198 after the design simplification on 2026-05-17.
**Decision date:** 2026-05-16 (original); simplified 2026-05-17
**Driven by:** Observed user-testing pain in large-group party sessions, supported by 3 months of Vercel Analytics + 1 week of PostHog
**Owner (assign on pickup):** TBD
**Supersedes:** [`docs/collaborative-picks-spec.md`](./collaborative-picks-spec.md). The collab-picks spec proposed per-user `picks[userId]` rows + new DB tables / mutations to solve the same "mixed-ability group, everyone wants their own line" problem; this pivot solves it with a shared-queue + explicit-driver model instead. The collab-picks spec was never implemented; an implementing agent should follow this doc, not the older spec.

---

## Problem

The current Queue Control Bar collapses two distinct concepts into one piece of state:

1. _What the user is looking at / has just tapped_ (browse state).
2. _What is physically lit up on the climbing wall_ (wall state).

Every tap, swipe, list click, or list-cover click currently mutates the "active climb" and therefore the wall.

_In large-group party sessions this is observed user pain (user-tested)._ Non-climbing party members — resting between turns and trying to line up what to climb next — cannot browse the catalogue without immediately changing what is lit on the wall for whoever is currently climbing. This isn't a problem inferred from event ratios; it is a problem we have watched happen in user research.

The analytics review supports the observed pain: the persistent Queue Control Bar UI is essentially dead as an interaction surface (~20 events vs 28,795 underlying queue operations over 3 months), and explicit queue building is rare (53:1 sends-to-explicit-adds). Both are consistent with users not safely interacting with a control surface that has destructive side effects.

## The pivot

Decouple _wall state_ from _browse state_. Introduce a single explicit control gesture — the lightbulb — that mediates whether the current user is driving the wall. The lightbulb lives in _one place only_: the Play View drawer's action bar. The Queue Control Bar itself no longer carries a lightbulb; its job is purely to mirror the wall and offer navigation that doesn't transfer leadership.

Four rules:

1. _The Queue Control Bar mirrors the wall._ It always shows what is physically lit, regardless of who put it there. In solo it's whatever the user last sent. In party it's whatever the current driver has on the wall, streamed in over the existing party WS subscription. The bar carries no lightbulb — only the drawer does.
2. _The lightbulb means "I am driving."_ It lives in the drawer. Press to take control. Press again to release. Yank-on-press with no negotiation — strictly better than today, where any list-tap from anyone yanks the wall with no affordance at all. There is exactly one lightbulb in the app.
3. _Browsing is consequence-free._ Tapping a climb in the list, swiping through the Play View drawer, opening climb details — none of it touches the wall or the wall mirror. Only an explicit lightbulb-press in the drawer broadcasts.
4. _Bar prev/next advance the wall but never transfer the driver. Drawer prev/next remain driver-only._ Anyone — driver or not, in any session mode — can press the bar's prev/next; the wall advances instantly with no confirmation gesture. The presser does not become the driver. The drawer prev/next still belong to the driver (the drawer is a browsing surface; non-driver button-presses there are ambiguous). The Live Activity widget prev/next remain driver-only and hidden for non-drivers (pocket-press griefing risk on a lock-screen widget). Non-drivers get swipe-as-preview in the drawer (rule 5) and the always-available bar prev/next instead.
5. _Swipe in the drawer is preview-only for non-drivers, broadcast for drivers._ The swipe gesture stays available for everyone (the dominant interaction in the data — 4,753 next-swipes per week). For non-drivers it walks the suggested-climbs feed only (skips the queue, since the queue represents what the driver is committed to climbing — not a non-driver's browsing surface) and does not broadcast. For drivers it walks queue → suggestions and broadcasts each step, identical to driver-side prev/next buttons.

Two further design notes worth naming explicitly:

_BLE is transport, not scope._ If any party member has an active BLE connection to the board, anyone in the party can drive the wall. With this simplification, we no longer track BLE-holder presence as session state. Instead, the backend broadcasts a `WallConfirmedClimb` event whenever any phone successfully delivers a climb to the board over BLE. Every drawer that pressed the lightbulb listens for this event; if it doesn't arrive within 2 seconds, that drawer falls back to either auto-connecting (mobile, with a known board serial) or opening the device picker (web or unknown serial). The "who is relaying for whom" stays implicit — the confirmation event is the only signal anyone needs.

_No hold-to-confirm gesture._ The earlier design gated non-driver bar prev/next behind a 3-second press-and-hold with a snackbar countdown. We removed it. The hold added friction to the most common navigation gesture (prev/next) for the cohort that needs it most (non-driver party members lining up the next climb), in exchange for a safety net that real user pain didn't ask for. Today any list-tap from anyone yanks the wall instantly; instant bar prev/next from any participant is strictly safer than that and matches how a remote works.

## The queue and suggestions model

Two distinct lists, both already represented in code (`QueueContext.tsx`):

- _Shared session queue (`state.queue`)._ One per party. Anyone in the session can append to it via Add to Queue. Lightbulb-press on a specific climb also appends. The queue is per-session — it persists for the life of the session and becomes the session history on close. Represents "the climbs we agreed on."
- _Suggested climbs (`suggestedClimbs`)._ Derived from the user's current browse context (filter, search results, list view) — see `use-queue-data-fetching.tsx:234`. Updates as the user navigates the catalogue. Represents "what else is interesting right now." Filtered to exclude items already in the queue.

Navigation rules layer on top:

- _Driver, any surface (drawer buttons, drawer swipe, bar buttons, Live Activity buttons):_ walks `queue` first; when the queue is exhausted, walks `climbSearchResults` from the anchor's position (skipping climbs already in the queue), and falls back to `suggestedClimbs[0]` if the anchor isn't in current search results. Playlist mode short-circuits to `suggestedClimbs` (the curated next-up feed) instead. Each step broadcasts immediately on tap. The driver fall-through lives in `getNextClimbQueueItem` / `getPreviousClimbQueueItem` in `QueueContext.tsx` — the pivot keeps it and gates the broadcast on driver status.
- _Non-driver, drawer swipe:_ walks `suggestedClimbs` only. Does not touch the queue. Does not broadcast. Pure preview.
- _Non-driver, bar buttons:_ instant. Advances from the current wall climb (queue → search-results → suggestions fall-through), broadcasts. _Driver does not change_ — bar prev/next is shared queue-navigation, not a driver-transfer.
- _Non-driver, Live Activity buttons:_ not present. Live Activity prev/next are driver-only and hidden from non-drivers entirely.
- _No-BLE state (nobody in the party can deliver the climb to the wall):_ the bar prev/next mutation still fires and broadcasts in the session, but the wall doesn't physically change. The lightbulb is the only path that detects this and falls back — see Phase 4 for the 2-second-timeout flow that opens the device picker or auto-connects.

A separate "personal saved climbs" library (cross-session, private) is a future concept and _out of scope for this PR_.

## Queue list rendering rules

The expanded queue list view (`packages/web/app/components/queue-control/queue-list.tsx`) renders three regions in order:

1. _History_ — climbs already sent to the wall in this session. _Default: render the most recent 5 history items._ A "Show full history" button at the top of the history region expands to show every history item from the session. Today's `scrollToHistoryIndex = historyItems.length - 2` logic in `queue-list.tsx:230` should be reworked around this 5-item default.
2. _Current item_ — the climb currently lit on the wall.
3. _Upcoming queue_ — items added via Add to Queue that haven't been broadcast yet, followed by a position-anchored walk through the current `climbSearchResults` once the queue is exhausted, with `suggestedClimbs` as a last-resort continuity fallback (same fall-through as navigation).

_Open behavior:_ when the list is opened (drawer or full-screen view), scroll so the current item is vertically centered in the visible area. Existing `scrollToCurrentClimb` API at `queue-list.tsx:50` is the right hook — its scroll target needs to be the center of the viewport, not the top. If there aren't enough history items to push the current item to true center (e.g. session just started), let it sit at its natural position rather than padding artificially.

## Wall-view drawer (tap the bar)

_Shipped state (post-PR #2198 + follow-ups #2238 and the open queue-pivot finish PR)_: the drawer has a "wall-view mode" rather than a separate drawer instance — opened from a bar tap with the wall climb pinned, the same component flips into a non-driver-locked state. The pivot's original "separate drawer" framing was simplified during review; the final shape uses chips and a header strip inside the existing drawer.

How it actually works today:

- _Opened from a bar tap_, the drawer pins to `state.currentClimbQueueItem` (the wall climb) via the `openedFromBar` payload.
- _Header strip_ renders "Currently on the wall" / "{username} is on the wall" via `playView.wallViewHeader` / `wallViewHeaderDriver` and a `LockOutlined` indicator. Tapping the strip's "Browse from here" link exits wall-view mode without closing the drawer.
- _`DRIVING` chip_ when the local user is the driver (so the user can tell at a glance that their drawer is the authoritative one).
- _`Preview` chip_ when the local user is a non-driver actively previewing — appears once they swipe inside the drawer; the wall-view header collapses to make room. Paired with a coachmark explaining "Tap the lightbulb to send it to the wall."
- _Swipe gesture is enabled for drivers_ inside wall-view (so drivers can drive without exiting), _disabled for non-drivers_ in wall-view (the preview path requires explicitly tapping past the lock).
- _No drawer prev/next buttons_ for non-drivers — they remain driver-only as the spec required.
- _Drawer lightbulb stays available_ with the same outlined/filled/pending states everywhere else, giving anyone in the drawer a take-control path without backing out.
- _Standard climb actions remain_ — Add to Queue, Open in Aurora, Mirror, Fork, tick logging, etc.

Contrast with the normal drawer (opened by tapping a climb in the list): same component, but no wall-view header / chips / lock. Drivers swipe to broadcast; non-drivers swipe to preview through `suggestedClimbs` only.

## User flows after the pivot

### Solo, BLE quickstart from Home

1. User connects via BLE quickstart on Home. Lightbulb auto-engages.
2. User taps a climb in any list → Play View Drawer opens (current behaviour).
3. The drawer's primary action is the lightbulb. Solo + connected = auto-on, so pressing it sends to the board.
4. Drawer also shows prev/next (driver-only controls). They walk the session queue and broadcast.
5. Closing the drawer leaves the wall as-is. The Queue Control Bar mirrors the lit climb with prev/next visible.

_Net for solo: essentially unchanged._ Once BLE is connected, tap-and-send still works as today. The model is the same; the abstraction is just consistently applied.

### Solo, no BLE

1. Tap → drawer opens → lightbulb is in "press to send" state.
2. Pressing the lightbulb claims driver and starts the 2-second confirmation timer. No `WallConfirmedClimb` arrives because nothing is paired, so the timer expires.
3. _Mobile app + we have a stored board serial:_ auto-connect is attempted against the remembered serial. On success, `BluetoothAutoSender` ships the still-current climb.
4. _Web, or no stored serial:_ the existing `DevicePickerDialog` opens. The user picks a board; once BLE establishes, `BluetoothAutoSender` ships the climb automatically. Single press, one optional pick.

### Party member, joining an existing session, not driving

1. User joins party. The drawer's lightbulb is in "take wall control" state.
2. Queue Control Bar mirrors the current driver's climb live via party WS. Tapping the bar itself opens the wall-view drawer ("Currently on the wall" label + driver avatar; no prev/next, no swipe; lightbulb available to take control).
3. Bar prev/next are visible and instant for everyone — non-drivers can advance the wall through the shared queue without becoming the driver. Drawer prev/next remain driver-only and are hidden for non-drivers. Live Activity prev/next are hidden for non-drivers entirely. To take over the wall, press the drawer lightbulb.
4. User browses freely — tap list rows, open drawer, search, filter. Swipe in the drawer walks the suggested-climbs feed (preview only, does not broadcast, does not navigate the shared queue). No wall-side consequences from drawer interaction.
5. User finds a climb they want to suggest → press "Add to Queue". Appends to the shared session queue; visible to everyone but does not change the wall and does not take control.
6. User wants to take a turn → press lightbulb in the drawer on the chosen climb. Yanks control from current driver, broadcasts new climb, drawer starts the 2-second wall-confirmation timer, party WS pushes update to every member's bar.
7. New driver's prev/next controls appear in their drawer; Live Activity widget activates. Previous driver's lightbulb releases automatically; their drawer prev/next disappears.

### Party host with no BLE, while another member has BLE

The host presses the drawer lightbulb. The climb broadcasts to all members over WS. A different member's phone (the BLE holder) sends the climb to the board and the backend emits `WallConfirmedClimb`. The host's drawer sees the confirmation arrive before the 2-second timer expires; nothing else happens locally. From the host's perspective the wall just changed — no picker, no auto-connect, no "via {name}" attribution.

### Nobody in the party has BLE

The host presses the drawer lightbulb. The climb broadcasts; no `WallConfirmedClimb` is emitted because no phone delivered it. After 2 seconds the host's drawer falls back: auto-connect against the stored session serial if available, otherwise open `DevicePickerDialog`. Once BLE is up the climb sends automatically. The same flow runs for whichever participant first decides to press the lightbulb after a BLE drop — there is no separate "Wall offline" state machine.

## Out of scope for this PR

- "Personal saved climbs" library (cross-session, private). Future work, not needed for the pivot.
- Bulk-tick / session-summary surface. The natural next pivot built on the cleaner session history this work produces. Tracked separately.
- Workout Generator surfacing changes. Separate workstream.
- Climber-on-wall safety detection (accelerometer-based, modal-confirm, or otherwise). The pivot ships without one; richer detection is a v2 conversation if real pain shows up.
- Internal driver-state UI affordances ("press the lightbulb to take the wall" reject hints, leadership-changed toasts, etc.) — internal driver state is intentionally not surfaced to users.

## Implementation phases

Each phase should ship behind a small, scoped change and be independently verifiable in dev. Phases 1–3 plus the simplified Phase 4 are all landing together in #2198; the phase numbering is preserved here as conceptual milestones rather than separate PRs.

### Phase 1 — Stop browse actions from mutating the active climb

_Goal:_ `state.currentClimbQueueItem` already represents the wall climb (it's what the party WS broadcasts and what triggers the BLE send in solo). The bug is that browse actions also mutate it. This phase removes the implicit mutations so the existing field becomes a clean source of truth for "what's on the wall" — no new field needed.

- Audit every call to `setCurrentClimb` in the web app and identify which ones are browse side-effects (list-row click, list-cover click, drawer-open) vs explicit user gestures (the existing `Set Active Climb` menu action, prev/next button presses, swipe). Browse side-effects get removed in this phase; explicit gestures are kept temporarily and replaced with the lightbulb / bar-button paths in Phase 2.
- The drawer's "currently displayed climb" when opened from a list tap is _local state inside the drawer_, not a write to `state.currentClimbQueueItem`. The drawer component should track its displayed climb internally and only call `setCurrentClimb` when the user invokes an explicit broadcast action (currently the menu action; after Phase 2, the lightbulb).
- Verify: opening the drawer on a climb, swiping inside it, and tapping list items no longer changes `state.currentClimbQueueItem` — and therefore no longer changes the Queue Control Bar's primary display, no longer broadcasts to party members, and no longer triggers a BLE send.
- The Queue Control Bar's render logic in `queue-control-bar.tsx` doesn't need to change — it already reads `state.currentClimbQueueItem` and will now correctly show the wall climb once browse stops mutating it.

Files: `queue-control-bar.tsx`, `graphql-queue/QueueContext.tsx`, the list-row + list-cover click handlers in `climbs-list.tsx`, the Play View Drawer for its newly-local "displayed climb" state. No backend changes — the party WS already broadcasts `currentClimbQueueItem` correctly; we're just narrowing what causes it to change on the client.

### Phase 2 — Drawer lightbulb + driver-only drawer navigation + Set Active rename

_Goal:_ browsing stops mutating active state. The drawer lightbulb becomes the only way to claim driver and broadcast a climb. Drawer prev/next become driver-only. Bar prev/next become available to everyone, instant, and never transfer the driver. `Set Active Climb` is renamed to "Send to board" and `Queue` is renamed to "Up next" in user-facing copy.

- Add a lightbulb action to the Play View Drawer's bottom action row. Pressing it triggers what used to be `setCurrentClimb` — claims driver, sends to board (solo), or broadcasts to party.
- _The bar no longer carries a lightbulb._ Its job is to mirror the wall (climb name + driver avatar) and expose prev/next. The driver indicator on the bar lives on the driver's avatar (lit-bulb badge in the `AvatarGroup`) — not on a separate bar lightbulb.
- Change `setCurrentClimb` in `QueueContext.tsx:383` so it no longer fires on tap. The implicit append-to-queue side effect (`shouldAddToQueue: true, insertAfterCurrent: true`) fires from the lightbulb path only.
- List-row clicks (`Climb List Row Clicked`, `Climb List Cover Clicked`) continue to open the drawer; they no longer call `setCurrentClimb`.
- Solo default: lightbulb auto-engages once BLE is connected (so quickstart-from-home → first tap → first lightbulb press feels like the old tap-to-send flow).
- Party default: lightbulb is in "take wall" state on join; user presses to take a turn.
- Yank-on-press in party: pressing lightbulb sends a `TakeControl` message; server broadcasts new driver to all members. Previous driver's lightbulb releases.
- _Driver is a new field, not an overload of `isLeader`._ The schema already has `isLeader: Boolean!`, `leaderId`, `leaderConnectionId`, and a `LeaderChanged` event with comments saying "presentation/backward compatibility only". Earlier drafts proposed loading driver semantics onto those fields; the adversarial review pushed back and won. Reason: `isLeader` has at least four existing dependencies (auth checks at `packages/backend/src/graphql/resolvers/sessions/mutations.ts:408-409`, the OG share image headline at `packages/web/app/api/og/session/route.tsx:34, 65`, `LeaderChanged` event consumers, GraphQL operations that already filter by `isLeader`) — overloading the field silently changes their behavior and risks regressions. _Add a new `driverParticipantId: ID` field on the `Session` type_ at `packages/shared-schema/src/schema/session.ts:175`. Add a new `DriverChanged` event type. `isLeader` keeps its existing semantics untouched. The wall-control authority lives on `driverParticipantId`; the new advance and take-control mutations check against this field, not `isLeader`.
- _Audit existing `isLeader` / `leaderId` / `leaderConnectionId` / `LeaderChanged` references_ during this PR. Grep across `packages/backend/src`, `packages/web/app`, the iOS native code, and the shared schema. Confirm each call site is for "presentation / share image / auth on legacy mutations" — not for wall-control. If any leader-only path turns out to gate wall control today, port it to `driverParticipantId` explicitly rather than relying on the field name.
- _Driver-only prev/next in the drawer:_ `next-climb-button.tsx` and `previous-climb-button.tsx`, _when used inside the Play View Drawer_, render only when the local user holds the lightbulb. Navigating prev/next here walks the shared session queue first; when the queue is exhausted, walks `climbSearchResults` from the anchor's position (skipping climbs already in the queue), and falls back to `suggestedClimbs[0]` if the anchor isn't in current search results. Broadcasts each step. The driver fall-through lives in `getNextClimbQueueItem` / `getPreviousClimbQueueItem` in `QueueContext.tsx`; the change is gating the broadcast on driver status.
- _Bar prev/next visible to everyone, always instant._ Render for all participants. Driver or non-driver, the press fires immediately, advances the wall through the shared queue (then falls through to suggestions), and broadcasts. The presser does not become the driver. The advance mutation must accept from any session participant (the existing leader-only check at `sessions/mutations.ts:408-409` is not on the advance path — it gates legacy admin mutations; confirm in the audit and route the new advance through a participant-accessible mutation).
- _Live Activity widget prev/next are driver-only._ Hidden entirely for non-drivers — a lock-screen remote-control widget exposed to all members invites pocket-press griefing. The widget renders the wall climb + driver attribution for non-drivers but no advance controls. See `packages/backend/src/handlers/widget-navigate.ts` for the widget-navigation handler; only invoke from the widget surface when the user is the current driver.
- _Wall-view drawer mode._ Tapping the body of the Queue Control Bar (not its prev/next buttons) opens the existing Play View Drawer in a new wall-view mode: hides prev/next, disables swipe-to-navigate, shows a "Currently on the wall" header with the driver's avatar inline, keeps the drawer lightbulb and standard climb actions. The drawer component shouldn't fork — pass an `openedFromBar: boolean` prop (or equivalent) that toggles the read-only nav state and the header treatment. When opened from the bar, the drawer's displayed climb is `state.currentClimbQueueItem` (the wall climb, since Phase 1 made that field clean). When opened from a list tap, the displayed climb is whatever the user tapped (local drawer state).
- _Non-driver swipe handler:_ drawer swipe stays available for non-drivers but walks `suggestedClimbs` only (skips `state.queue`) and does not broadcast. This is a different code path from the driver swipe — extract a shared helper or split the navigation hook so the driver/non-driver split is explicit.
- _Rename `Set Active Climb` → "Send to board"_ in `set-active-action.tsx` and the i18n catalog (`packages/web/i18n/locales/en-US/common.json`). The PostHog event name stays `Set Active Climb` for analytics continuity — only the user-facing label changes.
- _Rename "Queue" → "Up next" in user-facing copy_ in the same i18n pass. The internal data-structure names (`state.queue`, `addToQueue`, the GraphQL type, the event names `Add to Queue` / `Queue Navigation`, queue-list component name) all stay unchanged for analytics + code continuity. The change is strictly UI strings: any visible label that today reads "Queue", "Add to Queue", "Queue list", etc. becomes "Up next" / "Add to Up next" / "Up next list" or close equivalent. Run the i18n string audit across `packages/web/i18n/locales/en-US/*.json` and update every match. Spanish + French catalogs follow the project's existing fallback policy.
- _Delete the existing play-view drawer hint animation._ The bar-bounce-to-hint-the-drawer-exists code at `queue-control-bar.tsx:577-643` (the `playViewHintPlayedRef` state machine, the IndexedDB-gated trigger at `:616`, and the `setPreference('swipeHint:playViewSeen', true)` write at `:643`) is teaching the wrong model post-pivot. The bar's role is now self-evident from its content (wall mirror + driver avatar with lit-bulb badge + prev/next + tap-for-wall-view); the bounce animation that previously hinted "there's something behind here" is obsolete and misleading. Also remove the `'swipeHint:playViewSeen'` entry from `packages/web/app/lib/user-preferences-db.ts:29`. The new lightbulb first-run coachmark in Phase 3 conceptually replaces it.

Files: `play-view-drawer.tsx`, `queue-control-bar.tsx`, `QueueContext.tsx`, `set-active-action.tsx`, `next-climb-button.tsx`, `previous-climb-button.tsx`, backend `queue-navigation.ts`, `room-manager.ts`, possibly new `take-control` message type in `packages/shared-schema`, i18n `common.json`.

### Phase 3 — Visual states + accessibility

The lightbulb appears in exactly one place (the drawer action bar). Its visual states and the bar's driver-attribution treatment must be unambiguous and screen-reader-correct.

- _Drawer lightbulb visual states._ Outlined + neutral when the local user is not the driver ("take the wall"). Filled + glow when the local user is the driver and the wall is in sync ("you're driving"). A transient pressed/pending state for the 2-second window between press and `WallConfirmedClimb` (subtle progress treatment — a soft pulse on the bulb is enough; full progress rings are too loud for a 2-second wait). Falls into the picker / auto-connect flow silently if the timer expires.
- _Driver-first avatar group on the Queue Control Bar._ The party member `AvatarGroup` (currently in `queue-control-bar.tsx:1025-1045` and the expanded variant at `:1112+`) sorts the participant whose id matches `Session.driverParticipantId` first. The driver's avatar carries a small lit-up lightbulb badge in the corner (overlay). Non-driver avatars render without a badge in their existing order. The expanded roster view follows the same ordering and badging rules so the driver is unambiguous wherever members are listed. _Avoid resort jitter on rapid driver changes:_ if rapid yanks become a visual nuisance (e.g. >1 change per 10s), debounce the reorder by 500ms — the badge change can be instant, the reorder can wait briefly.
- _VoiceOver/TalkBack labels_ must be role-and-state distinct:
  - Drawer + driving: "Send '{climbName}' to the wall."
  - Drawer + not driving: "Take wall control and send '{climbName}'."
  - Bar avatar with badge: "{name} is driving."
  - Bar prev/next: "Previous climb on the wall." / "Next climb on the wall." (unchanged for driver vs non-driver — the action is identical).
- _State must not be encoded by colour alone_ (WCAG 1.4.1). Use fill/outline variants on the lightbulb + the avatar-badge attribution on the bar.
- _Hit targets_ minimum 48×48dp. The lightbulb in the drawer must sit in the bottom action row (thumb-zone-aligned for iPhone Pro Max one-handed use).
- _First-run coachmark:_ on the user's first drawer-open after this ships, pulse the lightbulb once with a brief tooltip ("Send to the wall"). Persist a `lightbulbSeen` flag in IndexedDB per the existing `swipeHint:*` pattern in `queue-control-bar.tsx`.

Use existing tokens from `packages/web/app/theme/theme-config.ts`. No new colours or spacing primitives.

### Phase 4 — Wall confirmation + session-stored board serial

_Goal:_ make BLE delivery observable as a backend-visible event, and use that event to handle "no BLE on this phone" silently from the drawer lightbulb. This replaces the earlier wall-offline / BLE-holder-presence state machine. The user-visible behaviour is: press the drawer lightbulb, and within 2 seconds either the wall lights up or a board picker appears. No "Wall offline" indicator, no grace-period counters, no surfaced internal state.

- _New event `WallConfirmedClimb`._ Schema: `{ climbUuid: ID!, confirmedAt: String (ISO 8601)!, confirmedByParticipantId: ID! }`. When any phone successfully delivers a climb to the board over BLE, that phone calls a `confirmClimbOnWall` mutation; the backend broadcasts the event to every member of the session over the existing party WS subscription. Each drawer that has an in-flight lightbulb press matches on `climbUuid` to clear its pending state. (Note: `confirmedAt` is emitted as an ISO 8601 `String` rather than a custom `DateTime` scalar — the schema has no `scalar DateTime` and the ISO string keeps the wire format forward-compatible without introducing a new scalar dependency.)
- _New session field `lastConnectedBoardSerial: String` (nullable)._ Added to the `Session` type in `packages/shared-schema/src/schema/session.ts`. When any participant successfully connects to a board, the client calls `setSessionBoardSerial(sessionId, serial)`. Backend stores the value in room state and broadcasts a `SessionBoardSerialChanged` event so other clients can pick it up (relevant if the original connector drops and a different phone wants to auto-reconnect to the same board on next press).
- _Drawer-lightbulb 2-second timer._ On press, the drawer broadcasts the climb and starts a local 2-second timer. The timer is cleared if a `WallConfirmedClimb` with the matching `climbUuid` arrives. If it expires:
  - _Mobile (native shell) + `lastConnectedBoardSerial` is known:_ trigger auto-connect via the existing `connect(frames, mirrored, targetSerial)` path. After connection, `BluetoothAutoSender` ships the still-`currentClimbQueueItem` climb. No picker.
  - _Web, or no stored serial:_ open `DevicePickerDialog`. User picks a board, BLE establishes, `BluetoothAutoSender` ships automatically.
- _Bar prev/next is not gated by this state._ Bar prev/next still fires the advance broadcast unconditionally. If nobody has BLE, the wall doesn't physically change — but the next time anyone presses the drawer lightbulb, that drawer's 2-second timer expires and they fall through to the picker / auto-connect flow, which fixes the situation. We accept that bar prev/next can be a no-op on the wall in the no-BLE case; the drawer lightbulb is where the system recovers.
- _Why this replaces the old Phase 4._ The earlier design tracked BLE-holder presence in the room manager, fired `WallOffline` / `WallOnline` events, ran a 5-second grace period on disconnect, and routed advance mutations to specific holders. That mechanism is gone. The relay is implicit: any phone with BLE that receives the broadcast can deliver, and the `WallConfirmedClimb` event tells everyone whether delivery happened. The driver concept stays (it gates the drawer lightbulb's take-control semantics), but it is not coupled to whether the wall is online.

#### Trust model for `setSessionBoardSerial`

`setSessionBoardSerial` is gated only by `requireSessionMember`, which accepts anonymous participants (the same trust level we grant for `addToQueue` and other browse mutations). That means any anonymous joiner with a valid share link can redirect the party's stored auto-connect target to an arbitrary board serial. Unlike `takeControl` / `releaseControl` — which are transient (driver state flips back the next time someone takes control) — this is a persistent side-effect: the next lightbulb-fallback auto-connect across the whole session will dial that serial.

We accept this for now because party sessions are share-link gated and the failure mode is recoverable (the next legit BLE-connector overwrites the stored serial). If we see griefing in production, tighten the guard to authenticated-only or "current driver only" before the write.

Files: `packages/shared-schema/src/schema/session.ts`, `packages/shared-schema/src/types/events.ts`, `packages/backend/src/services/room-manager/room-manager.ts`, `packages/backend/src/graphql/resolvers/sessions/mutations.ts` (new `confirmClimbOnWall` and `setSessionBoardSerial` mutations), `packages/web/app/components/play-view/play-view-drawer.tsx` (the timer + fallback logic), `packages/web/app/components/board-bluetooth-control/bluetooth-context.tsx` (call `setSessionBoardSerial` after a successful connect; call `confirmClimbOnWall` after a successful frame send).

### Phase 5 — Instrumentation

Update analytics so we can verify the pivot works in production. _Critical: do not change the semantics of any existing event_ — that would break the time series and make it impossible to measure success against today's baseline.

- _New event_ `Wall Control Taken` — properties: `source: 'lightbulb_drawer' | 'send_to_board_menu' | 'auto_solo'`, `previousDriver: 'none' | 'self' | 'other'`, `mode: 'solo' | 'party'`, `boardLayout`. (Note: no `lightbulb_bar` source — the bar carries no lightbulb.)
- _New event_ `Wall Control Released` — properties: `reason: 'manual' | 'yanked' | 'disconnect'`, `mode`, `boardLayout`.
- _New event_ `Wall Advance` — fired on every successful advance broadcast from the bar / Live Activity / driver drawer. Properties: `source: 'bar_button' | 'drawer_button' | 'drawer_swipe' | 'live_activity'`, `pressedByRole: 'driver' | 'non_driver'`, `direction: 'next' | 'previous'`, `mode`, `boardLayout`. (No `bar_button_held` source — the hold gesture has been removed.)
- _New event_ `Wall Confirmed` — fired client-side when a phone receives a `WallConfirmedClimb` matching one of its in-flight lightbulb presses (or fires it independently when the local phone is the one that delivered). Properties: `climbUuid`, `latencyMs` (press-to-confirm), `confirmedByRole: 'self' | 'other'`, `mode`, `boardLayout`. Lets us measure how often the 2-second fallback actually triggers in production.
- _New event_ `Session Board Serial Set` — fired when a client calls `setSessionBoardSerial`. Properties: `mode`, `previousSerialKnown: boolean`. Sanity check that the field is getting populated on real sessions.
- _Existing event_ `Set Active Climb` — semantics unchanged. Still fires from the (now renamed-in-UI to "Send to board") menu action. The lightbulb path fires `Wall Control Taken` instead. Do not collapse the two — keep them distinct so the time series is interpretable.
- _Existing event_ `Queue Navigation` — semantics unchanged. After the pivot it fires from the now-driver-only drawer prev/next paths and from the any-participant bar prev/next path; we differentiate via the `Wall Advance` `source` + `pressedByRole` properties above rather than splitting the legacy event.
- _Existing `Queue Operation`_ — expect a dramatic drop in `setCurrentClimb` operations (today 60% of all queue ops, ~18K events / 3 months) because browsing no longer mutates. The cleaner signal that survives is the explicit lightbulb-press.
- _Existing `Add to Queue`_ — semantics unchanged; expect modest growth as the feature has a clearer purpose ("suggest for the session") distinct from broadcast. Watch the `swipe` vs `climbActions` split (today 57:43).

_Pre-registered success metric (lock in before launch):_

- _Primary:_ within 4 weeks of rollout, `Wall Control Taken` events per active party-mode user should exceed today's `Set Active Climb` event rate per active party-mode user.
- _Primary:_ party-cohort retention (sessions per user over a 30-day window) should not decline relative to the 4 weeks before launch.
- _Counter-metric (solo-mode regression):_ solo-cohort retention (sessions per user over a 30-day window, restricted to users who never joined a party in the measurement window) should not decline relative to the 4 weeks before launch. Solo is the larger cohort by far — 2,419 board-senders vs ~1,400 party users over 3 months — and the pivot's main behavior change (tap-to-set-active no longer broadcasts in party; in solo, the Phase 3 "Send to board" rename touches the same path) lands on solo users too. Catch a solo regression early; do not let a party-only metric mask it.
- _Counter-metric (anti-griefing / anti-confusion):_ the rate of `Wall Control Released` within 30s of `Wall Control Taken` should not exceed 15% of takes. A high rapid-release rate would indicate users are fighting for or accidentally claiming control — the new model would look "active" in the primary metric but actually be confusing. Record the baseline rate (close to zero today since the lightbulb concept doesn't exist) and define the kill threshold at 15%.
- _Counter-metric (silent-no-BLE-recovery):_ among `Wall Control Taken` events from the drawer lightbulb, the share that are _not_ followed by a `Wall Confirmed` event within 2 seconds should stay below 20%. A higher share means the 2-second fallback is firing routinely and users are seeing a board picker on most presses — which is a UX regression even if it functionally succeeds. Set the kill threshold at 20% and investigate before raising it.

If any of the four misses, the pivot is reverted or revised. Record all baselines before Phase 2 ships.

Update `packages/web/app/lib/queue-metrics.ts` if the operation sampling logic needs to accommodate the new events.

### Phase 6 — QA + dev-server validation

Standard project flow per CLAUDE.md:

- Write `.boardsesh/qa-notes.md` with the QA plan before starting `vp run dev`.
- Cover: solo BLE quickstart → tap → press drawer lightbulb path; solo no-BLE → press lightbulb → 2s timer expires → device picker opens → pick → wall lights (web) or stored-serial auto-connect (mobile native); party join → browse without consequence → take control via drawer lightbulb → driver's drawer prev/next appear → released-and-yanked flows; non-driver presses bar prev/next, wall advances instantly, presser does not become driver; non-driver does NOT see prev/next in the drawer or Live Activity; driver presses drawer / bar / Live Activity prev/next, all instant; BLE drops mid-session — next drawer-lightbulb press from any participant runs the 2-second timeout → picker / auto-connect and recovers silently; `WallConfirmedClimb` arrives within 2s of a press from a different BLE-holding member → the host's drawer clears its pending state with no picker; tapping the bar body opens the wall-view drawer (no prev/next, no swipe, "Currently on the wall" header, driver avatar inline, drawer lightbulb still works).
- Confirm normal drawer prev/next buttons disappear for non-drivers; bar prev/next visible to all and instant; Live Activity prev/next hidden for non-drivers.
- Confirm "Send to board" label appears wherever "Set Active Climb" did, and "Up next" appears wherever "Queue" did in user-facing copy.
- Confirm the bar carries no lightbulb visual at all (only the driver-avatar badge).
- Run `vp check` and `vp run typecheck` before pushing.
- Open a PR with screenshots / screen recordings of the new drawer lightbulb states, the driver-avatar badge on the bar, and the 2-second fallback path.

## Background — why this design

_Observed pain (user-tested):_ in large-group party sessions, climbers resting between turns cannot browse the catalogue to line up what they want next, because tapping a climb in the list immediately changes what is lit on the wall for the climber currently on the route. This pattern has surfaced repeatedly in user testing. The pivot's primary job is to fix this.

_Supporting analytics_ — three months of production data from Vercel Analytics dashboard (no API access; PostHog only went live this week so its window is ~7 days):

| Metric                           | 3-month total | Visitors |
| -------------------------------- | ------------: | -------: |
| Climb Sent to Board Success      |        79,735 |    2,419 |
| Queue Operation (sampled)        |        28,795 |    4,071 |
| Session Started + Session Joined |        ~1,800 |   ~1,400 |
| Add to Queue                     |         1,492 |      494 |
| Queue Control Bar swipe + button |           ~20 |       ~7 |

Queue Operation breakdown (3-month, sampled at max 5 per op-type per session; visitor counts are accurate, event totals are floors):

- `setCurrentClimb` — 60%, 4,000 visitors (essentially every user). Fires on every tap-to-make-active and currently auto-appends to the queue.
- `setCurrentClimbQueueItem` — 29%, 1,900 visitors. Navigating through queue history.
- `addToQueue` — 6%, 425 visitors.
- Long tail: `replaceQueueItem` 2%, `setQueue` 2%, `mirrorClimb` 1%.

`Add to Queue` UI events (3 months) by source: `swipe` 240, `climbActions` 183. The dedicated `queueButton` source fires zero events because the component (`packages/web/app/components/climb-actions/queue-button.tsx`) is exported from the climb-actions index but _never rendered on any route_ — verified via grep for `<QueueButton` JSX. The `track('Add to Queue', { source: 'queueButton' })` call inside it is wired correctly; it simply has no caller. The file now carries a `TODO(queue-bar-pivot)` marker at the top pointing back to this doc; pick it up alongside other follow-up cleanups (either delete or re-mount as a third entry point). The zero-event signal is "no surface", not "instrumentation gap".

`Queue Navigation` UI events (PostHog week — directionally stable): 4,753 next-swipes + 1,085 previous-swipes inside the Play View drawer. 20 events combined on the Queue Control Bar arrows/swipe. 8 events on the bar's button arrows. The persistent control bar is structurally unused as an interaction surface.

Board concentration: Kilter Original 78% of sends, Kilter Homewall 17%, everything else combined 5%. Design Kilter-first; cross-board parity is a tax that returns nothing.

The 1,650-visitor gap between "queue-touching" (4,071) and "board-sending" (2,419) is consistent with hesitant-to-tap behaviour: users who would explore the catalogue but don't because the cost of tapping is "you change the wall." The pivot drops that cost to zero.

## Code pointers (verified, may drift)

- Queue state machine + context: `packages/web/app/components/graphql-queue/QueueContext.tsx`. `setCurrentClimb` is the function at line 383; the `shouldAddToQueue: true, insertAfterCurrent: true` payload at line 397 is what makes the implicit queue an auto-history of every tap. The driver fall-through (queue → search-results walk → suggestion fallback) lives in `getNextClimbQueueItem` / `getPreviousClimbQueueItem`.
- Suggestions derivation: `packages/web/app/components/queue-control/hooks/use-queue-data-fetching.tsx:234` (`suggestedClimbs` memo, derived from `climbSearchResults`).
- Queue Control Bar UI: `packages/web/app/components/queue-control/queue-control-bar.tsx`. Party member `AvatarGroup` lives at `:1025-1045` (mini bar) and `:1112+` (expanded variant) — both need driver-first ordering and the lightbulb badge on the driver's avatar.
- Queue list view: `packages/web/app/components/queue-control/queue-list.tsx`. History default count, "Show full history" button, and current-item-centered-on-open all land here. Existing `scrollToCurrentClimb` (`:50`), `history-item` / `history-divider` row types (`:40-41`), and `scrollTargetFlatIndex` logic (`:218+`) are the hooks to reuse.
- Session participant schema: `packages/shared-schema/src/schema/session.ts:147` (`SessionParticipant` type), `:175` (`participants` field on `Session` — add `driverParticipantId: ID` and `lastConnectedBoardSerial: String` here as new fields). The existing `isLeader` / `leaderId` / `leaderConnectionId` fields (`:18`, `:43`) keep their current semantics; do _not_ overload them.
- Existing `LeaderChanged` event type at `packages/shared-schema/src/types/events.ts:99`. Add `DriverChanged`, `WallConfirmedClimb`, and `SessionBoardSerialChanged` events next to it; do not repurpose `LeaderChanged`.
- Audit targets for the `isLeader`-overload-avoidance task: `packages/backend/src/graphql/resolvers/sessions/mutations.ts:280, 344, 408-409`, `packages/web/app/api/og/session/route.tsx:34, 65`, and any references found in iOS native code + `packages/shared-schema/src/operations.ts`. Goal of the audit: confirm none of these gate _wall-control_ behaviour today; if any do, port that path to the new `driverParticipantId` field explicitly.
- Play View Drawer (where the lightbulb action and the 2-second wall-confirmation timer live): `packages/web/app/components/play-view/play-view-drawer.tsx`.
- Prev/next button components: `packages/web/app/components/queue-control/next-climb-button.tsx`, `previous-climb-button.tsx` (both still exist; instant for everyone on the bar, driver-only in the drawer).
- BLE send + connection: `packages/web/app/components/board-bluetooth-control/bluetooth-context.tsx`, `auto-connect-handler.tsx`, `use-board-bluetooth.ts`. The `connect(frames, mirrored, targetSerial)` signature is what the 2-second mobile auto-connect fallback calls; `BluetoothAutoSender` is what ships the climb after a connection. After a successful frame send, fire the new `confirmClimbOnWall` mutation here.
- "Send to board" action (renamed from Set Active Climb): `packages/web/app/components/climb-actions/actions/set-active-action.tsx`.
- Backend party / queue state: `packages/backend/src/services/room-manager/queue-state.ts`, `room-manager.ts`, `client-lifecycle.ts`, `queue-navigation.ts`.
- Live Activity widget navigation: `packages/backend/src/handlers/widget-navigate.ts`.
- Analytics wrapper: `packages/web/app/lib/analytics.ts`. Queue Operation sampling: `packages/web/app/lib/queue-metrics.ts`.

## Open questions (remaining)

Not blockers. The implementing engineer should make the call in code review with whoever owns UX.

1. _Lightbulb hold without an output device (solo + no BLE)._ Resolved by the Phase 4 fallback: pressing the lightbulb claims driver and starts the 2-second timer; on expiry we auto-connect or open the picker. A single discoverable affordance regardless of connection state.
2. _Hand-off notification UX._ When someone yanks control from you, what does your phone do? Recommend: a quiet toast ("Alice took the wall"), no haptic, no sound — climbing flow shouldn't have negotiation friction.
3. _Add to Queue placement under the new model._ The action stays, but its UX placement may want revisiting (still swipe-on-list-row? still a menu item? both?). No change in this PR; flag for the design pass that follows.
4. _Swipe-in-drawer for non-drivers._ Resolved: swipe stays available and walks `suggestedClimbs` only (preview, no broadcast, skips the shared queue). See "The queue and suggestions model" above.
5. _Stale `lastConnectedBoardSerial`._ If the field points at a board that has since left the gym (host switched home walls, etc.), mobile auto-connect will time out trying to reach the wrong serial. Recommend: on auto-connect failure, fall through to the device picker rather than silently doing nothing, and clear the stored serial on a successful pick of a different board. Implement defensively in the bluetooth context; don't surface a separate UI state.
6. _Two phones racing on the same press._ If two BLE-paired phones both receive the broadcast and both deliver to the wall, we'll see two `WallConfirmedClimb` events for the same `climbUuid`. The drawer should clear its pending state on the first one and ignore subsequent matches. The board itself is idempotent (sending the same frames twice is harmless); we just don't want the UI to flicker.

## Non-goals / explicit nos

- Do not change the `Add to Queue` swipe gesture or menu entry. They already work and the 57:43 swipe:menu ratio suggests the gesture is the preferred path. (The user-facing label becomes "Add to Up next" per the Phase 2 rename; the gesture and underlying event name don't change.)
- Do not pre-build a session-summary / bulk-tick surface in this PR.
- Do not change Workout Generator or Onboarding in this PR.
- Do not collapse the existing `Set Active Climb` event into the new `Wall Control Taken` event. Keep them distinct for analytics continuity.
- Do not surface a "Wall offline" indicator, BLE-holder attribution, or any other internal connection-state UI on the bar. The 2-second drawer fallback is the only legible recovery surface; everything else stays implicit.

## What shipped vs spec

PR #2198 (merged 2026-05-18) shipped Phases 1–3 + simplified Phase 4. A follow-up PR closes the remaining gaps. The list below captures the deviations from the original spec that landed so a future reader doesn't trip on them.

- _Wall-view drawer mode_ — the spec described a separate drawer mode opened from a bar tap (lines 69-80 above, now rewritten). Commit `0317b3147` (design churn) deleted the dedicated mode and replaced it with an `ON WALL` chip on the bar. Commit `18a3c1069` moved the chip back into the drawer. Commit `489e1686f` added a `DRIVING` chip in the drawer for drivers. End state: the drawer has wall-view chrome (header strip + lock indicator + DRIVING chip for drivers + Preview chip for non-drivers after swipe + "Browse from here" exit link) but is the same component as the normal drawer.
- _Component consolidation_ — `next-climb-button.tsx` + `previous-climb-button.tsx` were merged into a single `queue-nav-button.tsx`. Driver-only gating in the drawer happens at the drawer level, not inside the button.
- _Wall Confirm Timeout event_ — added beyond spec as a kill-switch counter-metric (`use-wall-confirm-fallback.ts:180-201`). Pairs with `Wall Confirmed` to compute the silent-no-BLE-recovery share without inferring it from a missing event.
- _Group-session ride-along (#2238)_ — `setSessionBoardPath` mutation + `SessionBoardPathChanged` event broadcast angle changes between members. Not pivot scope but related plumbing.
- _Doc-vs-shipped queue-list rendering_ — Phase 3's 5-item history default, "Show full history" toggle, and center-on-open scroll were missing from PR #2198 and ship in the follow-up. Spec line 63-67 still describes the target behaviour; code now matches.
- _Phase 5 instrumentation backfill_ — PR #2198 wired `Wall Control Taken`, `Wall Control Released`, and `Wall Confirmed`. The follow-up adds `Wall Advance` (bar button, bar swipe, drawer button, drawer swipe — all broadcast paths) and `Session Board Serial Set`. Live Activity widget `Wall Advance` is intentionally deferred to a separate iOS-touching PR.
- _isLeader audit (Phase 2, 2026-05-23)_ — the spec required confirming no `isLeader` / `leaderId` / `leaderConnectionId` / `LeaderChanged` site gates wall-control. Confirmed across backend, web, shared-schema, and iOS native code. The only authorization use of `isLeader` is `endSession` (`mutations.ts:870`), which gates session termination — not wall control. Wall-control authority lives on `driverParticipantId`. A short audit comment at the top of `mutations.ts` records the result; no porting was needed.
- _Hand-off toast (Open Q2)_ — the follow-up wires a quiet info-level snackbar on `DriverChanged` for non-self transitions ("Alice is driving the wall.", "Alice took the wall from Bob.", "Alice took the wall.") using the existing `previousDriverParticipantId` field on the event.
- _Stale board serial recovery (Open Q5)_ — `bluetooth-context.tsx` now skips redundant `setSessionBoardSerial` writes when the new serial matches the stored one, and overwrites the field on every successful pick of a different board. No new UI; defensive only.

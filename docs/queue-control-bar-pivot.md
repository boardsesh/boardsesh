# Queue Control Bar Pivot — Bar Mirrors the Wall, Lightbulb Controls the Driver

**Status:** Plan, ready for implementation
**Decision date:** 2026-05-16
**Driven by:** Observed user-testing pain in large-group party sessions, supported by 3 months of Vercel Analytics + 1 week of PostHog
**Owner (assign on pickup):** TBD

---

## Problem

The current Queue Control Bar collapses two distinct concepts into one piece of state:

1. **What the user is looking at / has just tapped** (browse state).
2. **What is physically lit up on the climbing wall** (wall state).

Every tap, swipe, list click, or list-cover click currently mutates the "active climb" and therefore the wall.

**In large-group party sessions this is observed user pain (user-tested).** Non-climbing party members — resting between turns and trying to line up what to climb next — cannot browse the catalogue without immediately changing what is lit on the wall for whoever is currently climbing. This isn't a problem inferred from event ratios; it is a problem we have watched happen in user research.

The analytics review supports the observed pain: the persistent Queue Control Bar UI is essentially dead as an interaction surface (~20 events vs 28,795 underlying queue operations over 3 months), and explicit queue building is rare (53:1 sends-to-explicit-adds). Both are consistent with users not safely interacting with a control surface that has destructive side effects.

## The pivot

Decouple **wall state** from **browse state**. Introduce a single explicit control gesture — the lightbulb — that mediates whether the current user is driving the wall.

The rules:

1. **The Queue Control Bar mirrors the wall.** It always shows what is physically lit, regardless of who put it there. In solo it's whatever the user last sent. In party it's whatever the current driver has on the wall, streamed in over the existing party WS subscription.
2. **The lightbulb means "I am driving."** Press to take control. Press again to release. Yank-on-press with no negotiation — strictly better than today, where any list-tap from anyone yanks the wall with no affordance at all. A climber-on-wall safety lock (cooldown / "wall in use" modal) is explicitly v2; the v1 model is already a large improvement over the status quo.
3. **Browsing is consequence-free.** Tapping a climb in the list, swiping through the Play View drawer, opening climb details — none of it touches the wall or the wall mirror. Only an explicit lightbulb-press broadcasts.
4. **Prev/next button visibility splits by surface and role.** The Queue Control Bar prev/next are visible to _everyone_ (the bar mirrors the wall; its buttons are unambiguous wall-control gestures regardless of driver state). The Play View Drawer prev/next are _driver-only_ (the drawer is a browsing surface; buttons there would be ambiguous for non-drivers). The Live Activity widget prev/next are _driver-only and hidden for non-drivers_ (a lock-screen widget is a remote control; non-drivers shouldn't have prev/next on the lock screen — pocket-press griefing risk). Non-drivers get swipe-as-preview in the drawer (rule 5) and the always-visible bar (rule 6) instead.
5. **Swipe in the drawer is preview-only for non-drivers, broadcast for drivers.** The swipe gesture stays available for everyone (the dominant interaction in the data — 4,753 next-swipes per week). For non-drivers it walks the suggested-climbs feed only (skips the queue, since the queue represents what the driver is committed to climbing — not a non-driver's browsing surface) and does not broadcast. For drivers it walks queue → suggestions and broadcasts each step, identical to driver-side prev/next buttons.
6. **Bar prev/next advance the wall without transferring leadership; non-drivers must press-and-hold for 3 seconds.** Any party member can press bar prev/next, driver or not. For the driver, the press is instant. For a non-driver, the button requires a 3-second press-and-hold to fire — releasing early cancels. The presser sees a snackbar counting down during the hold ("Advancing in 3... 2... 1..."); release dismisses it. The hold is the climber-on-wall safety gate (in lieu of the modal-confirmation lock the reviewers flagged as needed; the hold is cheaper and gives the presser a visible cancel window). Once the hold completes, the wall advances along the shared queue (then falls through to suggestions) and broadcasts to every member. The driver stays the driver — pressing prev/next here is "advance what we've agreed on", not "take over the session." This narrows the lightbulb's purpose: the lightbulb is the driver-transfer gesture (commit a specific climb / claim the wall); the bar prev/next is the shared queue-navigation gesture that doesn't change who's driving.

A seventh, already-implemented rule worth naming: **BLE is transport, not scope.** If any party member has an active BLE connection to the board, anyone in the party can drive the wall — the lightbulb-press travels via WebSocket to whichever member holds BLE and they relay to the board. The lightbulb controls session state, not the current phone's pairing.

## The queue and suggestions model

Two distinct lists, both already represented in code (`QueueContext.tsx`):

- **Shared session queue (`state.queue`).** One per party. Anyone in the session can append to it via Add to Queue. Lightbulb-press on a specific climb also appends. The queue is per-session — it persists for the life of the session and becomes the session history on close. Represents "the climbs we agreed on."
- **Suggested climbs (`suggestedClimbs`).** Derived from the user's current browse context (filter, search results, list view) — see `use-queue-data-fetching.tsx:234`. Updates as the user navigates the catalogue. Represents "what else is interesting right now." Filtered to exclude items already in the queue.

Navigation rules layer on top:

- **Driver, any surface (drawer buttons, drawer swipe, bar buttons, Live Activity buttons):** walks `queue` first, falls through to `suggestedClimbs` when the queue is exhausted. Each step broadcasts immediately on tap. This is exactly the existing `getNextClimbQueueItem` logic in `QueueContext.tsx` (around line 566; queue → suggestions fall-through) — the pivot keeps it and gates the broadcast on driver status.
- **Non-driver, drawer swipe:** walks `suggestedClimbs` only. Does not touch the queue. Does not broadcast. Pure preview.
- **Non-driver, bar buttons:** press-and-hold for 3 seconds, then advance from the current wall climb (queue → suggestions fall-through), broadcast. Release before 3s cancels. Presser sees a snackbar with a countdown during the hold. **Driver is unchanged** — bar prev/next is shared queue-navigation, not a driver-transfer.
- **Non-driver, Live Activity buttons:** not present. Live Activity prev/next are driver-only and hidden from non-drivers entirely.
- **No-BLE state (nobody in the party has a Bluetooth connection):** bar buttons disabled with a "Wall offline — connect a board" hint. The advance mutation rejects server-side. Lightbulb-press is still valid (it claims the driver role pre-emptively so you're ready once BLE is up).

A separate "personal saved climbs" library (cross-session, private) is a future concept and **out of scope for this PR**.

## Queue list rendering rules

The expanded queue list view (`packages/web/app/components/queue-control/queue-list.tsx`) renders three regions in order:

1. **History** — climbs already sent to the wall in this session. **Default: render the most recent 5 history items.** A "Show full history" button at the top of the history region expands to show every history item from the session. Today's `scrollToHistoryIndex = historyItems.length - 2` logic in `queue-list.tsx:230` should be reworked around this 5-item default.
2. **Current item** — the climb currently lit on the wall.
3. **Upcoming queue** — items added via Add to Queue that haven't been broadcast yet, followed by suggested-climbs once the queue is exhausted (same fall-through as navigation).

**Open behavior:** when the list is opened (drawer or full-screen view), scroll so the current item is vertically centered in the visible area. Existing `scrollToCurrentClimb` API at `queue-list.tsx:50` is the right hook — its scroll target needs to be the center of the viewport, not the top. If there aren't enough history items to push the current item to true center (e.g. session just started), let it sit at its natural position rather than padding artificially.

## Wall-view drawer (tap the bar)

Tapping the Queue Control Bar itself opens a **wall-view drawer** showing the climb currently lit on the wall. This is a distinct drawer mode from the normal "I tapped a climb in the list" drawer:

- **No prev/next buttons** inside this drawer (the controls live on the bar itself; this view is anchored to the wall climb).
- **No swipe gesture** inside this drawer. The view is locked to whatever is currently lit. To browse other climbs, the user closes the drawer and uses the list or search.
- **"Currently on the wall" label** at the top of the drawer so the mode is unambiguous.
- **Driver's avatar inline near the label** — same avatar that carries the lit lightbulb badge in the bar's `AvatarGroup`. Tap-through behaviour mirrors the bar avatar (opens roster).
- **Lightbulb stays available** with the same semantics and visual rules as everywhere else: filled/lit when the local user is the driver (press to release), empty/outlined when someone else is driving (press to take). Gives the user a take-control path from this view without backing out.
- **Standard climb actions remain** — Add to Queue, Open in Aurora, Mirror, Fork, tick logging, etc. The restriction is navigation-only.

Contrast with the normal drawer (opened by tapping a climb in the list): that one shows the _tapped_ climb (not the wall climb), supports swipe-as-preview for non-drivers / swipe-as-broadcast for drivers, and shows prev/next for drivers. The two drawers share most of the underlying component; the differences are state-driven from how the drawer was opened.

## User flows after the pivot

### Solo, BLE quickstart from Home

1. User connects via BLE quickstart on Home. Lightbulb auto-engages.
2. User taps a climb in any list → Play View Drawer opens (current behaviour).
3. The drawer's primary action is the lightbulb. Solo + connected = auto-on, so pressing it sends to the board.
4. Drawer also shows prev/next (driver-only controls). They walk the session queue and broadcast.
5. Closing the drawer leaves the wall as-is. The Queue Control Bar mirrors the lit climb with the lightbulb in held-state and its own prev/next visible.

**Net for solo: essentially unchanged.** Once BLE is connected, tap-and-send still works as today. The model is the same; the abstraction is just consistently applied.

### Solo, no BLE

1. Tap → drawer opens → lightbulb is off (no output device).
2. Pressing the lightbulb initiates BLE pairing.
3. Prev/next controls are hidden — there's no wall to drive.

### Party member, joining an existing session, not driving

1. User joins party. Lightbulb is off (someone else is driving).
2. Queue Control Bar mirrors the current driver's climb live via party WS. Tapping the bar itself opens the wall-view drawer ("Currently on the wall" label + driver avatar; no prev/next, no swipe; lightbulb available to take control).
3. **Prev/next buttons in the normal drawer are hidden.** They only appear for the driver. The Queue Control Bar's prev/next remain visible to non-drivers — pressing requires a 3-second press-and-hold (with countdown snackbar) and advances the wall through the shared queue without transferring driver. The Live Activity widget's prev/next are hidden for non-drivers (driver-only). To actually take over the wall, press the lightbulb.
4. User browses freely — tap list rows, open drawer, search, filter. Swipe in the drawer walks the suggested-climbs feed (preview only, does not broadcast, does not navigate the shared queue). No wall-side consequences from drawer interaction.
5. User finds a climb they want to suggest → press "Add to Queue". Appends to the shared session queue; visible to everyone but does not change the wall and does not take control.
6. User wants to take a turn → press lightbulb on the climb in the drawer. Yanks control from current driver, broadcasts new climb, party WS pushes update to every member's bar.
7. New driver's prev/next controls appear in their drawer + bar; Live Activity widget activates. Previous driver's lightbulb releases automatically; their drawer prev/next disappears.

### Party host with no BLE, while another member has BLE

Same as above except every wall-mutating action (lightbulb-press, prev/next) routes over WS to the BLE-holding member, which relays to the board. From the user's perspective, identical — with a small "via Alice" microcopy on the bar so the user understands the path.

### BLE-holder drops mid-session in party

1. Bar continues to mirror last-known wall state for a 5-second grace period.
2. If no other BLE-capable member reconnects in that window, bar surfaces a "Wall offline" indicator.
3. Lightbulb becomes a "Claim wall" affordance — any member who can establish BLE can take over.
4. When a new holder establishes BLE, normal operation resumes silently for the current driver.

## Out of scope for this PR

- "Personal saved climbs" library (cross-session, private). Future work, not needed for the pivot.
- Bulk-tick / session-summary surface. The natural next pivot built on the cleaner session history this work produces. Tracked separately.
- Workout Generator surfacing changes. Separate workstream.
- Climber-on-wall _accelerometer-based_ safety detection (knowing whether someone is physically on the wall mid-attempt). The hold-to-confirm gesture on non-driver bar prev/next is the v1 mitigation; richer detection is v2.
- Internal driver-state UI affordances ("press the lightbulb to take the wall" reject hints, leadership-changed toasts, etc.) — internal driver state is intentionally not surfaced to users. Only `NO_BLE` produces a visible reject state.

## Implementation phases

Each phase should ship behind a small, scoped change and be independently verifiable in dev.

### Phase 1 — Stop browse actions from mutating the active climb

**Goal:** `state.currentClimbQueueItem` already represents the wall climb (it's what the party WS broadcasts and what triggers the BLE send in solo). The bug is that browse actions also mutate it. This phase removes the implicit mutations so the existing field becomes a clean source of truth for "what's on the wall" — no new field needed.

- Audit every call to `setCurrentClimb` in the web app and identify which ones are browse side-effects (list-row click, list-cover click, drawer-open) vs explicit user gestures (the existing `Set Active Climb` menu action, prev/next button presses, swipe). Browse side-effects get removed in this phase; explicit gestures are kept temporarily and replaced with the lightbulb / bar-button paths in Phase 2.
- The drawer's "currently displayed climb" when opened from a list tap is _local state inside the drawer_, not a write to `state.currentClimbQueueItem`. The drawer component should track its displayed climb internally and only call `setCurrentClimb` when the user invokes an explicit broadcast action (currently the menu action; after Phase 2, the lightbulb).
- Verify: opening the drawer on a climb, swiping inside it, and tapping list items no longer changes `state.currentClimbQueueItem` — and therefore no longer changes the Queue Control Bar's primary display, no longer broadcasts to party members, and no longer triggers a BLE send.
- The Queue Control Bar's render logic in `queue-control-bar.tsx` doesn't need to change — it already reads `state.currentClimbQueueItem` and will now correctly show the wall climb once browse stops mutating it.

Files: `queue-control-bar.tsx`, `graphql-queue/QueueContext.tsx`, the list-row + list-cover click handlers in `climbs-list.tsx`, the Play View Drawer for its newly-local "displayed climb" state. No backend changes — the party WS already broadcasts `currentClimbQueueItem` correctly; we're just narrowing what causes it to change on the client.

### Phase 2 — Lightbulb + driver-only navigation + Set Active rename

**Goal:** browsing stops mutating active state. The lightbulb becomes the only way to set the wall. Prev/next controls become driver-only. `Set Active Climb` is renamed to "Send to board" in the same change.

- Add a lightbulb action to the Play View Drawer. Pressing it triggers what used to be `setCurrentClimb` — sends to board (solo) or broadcasts to party.
- Add a lightbulb state to the Queue Control Bar that reflects whether the local user is currently driving. Pressing toggles ownership.
- Change `setCurrentClimb` in `QueueContext.tsx:383` so it no longer fires on tap. The current implicit append-to-queue side effect (`shouldAddToQueue: true, insertAfterCurrent: true`) fires from the lightbulb path only.
- List-row clicks (`Climb List Row Clicked`, `Climb List Cover Clicked`) continue to open the drawer; they no longer call `setCurrentClimb`.
- Solo default: lightbulb auto-engages once BLE is connected (so quickstart-from-home → first tap → first lightbulb press feels like the old tap-to-send flow).
- Party default: lightbulb is off on join; user presses to take a turn.
- Yank-on-press in party: pressing lightbulb sends a `TakeControl` message; server broadcasts new driver to all members. Previous driver's lightbulb releases.
- **Driver is a new field, not an overload of `isLeader`.** The schema already has `isLeader: Boolean!`, `leaderId`, `leaderConnectionId`, and a `LeaderChanged` event with comments saying "presentation/backward compatibility only". Earlier drafts of this plan proposed loading driver semantics onto those fields; the adversarial review pushed back and won. Reason: `isLeader` has at least four existing dependencies (auth checks at `packages/backend/src/graphql/resolvers/sessions/mutations.ts:408-409`, the OG share image headline at `packages/web/app/api/og/session/route.tsx:34, 65`, `LeaderChanged` event consumers, GraphQL operations that already filter by `isLeader`) — overloading the field silently changes their behavior and risks regressions. **Add a new `driverParticipantId: ID` (or `driverId: ID`) field on the `Session` type** at `packages/shared-schema/src/schema/session.ts:175`. Add a new `DriverChanged` event type. `isLeader` keeps its existing semantics untouched. The wall-control authority lives on `driverParticipantId`; the new advance and take-control mutations check against this field, not `isLeader`.
- **Audit existing `isLeader` / `leaderId` / `leaderConnectionId` / `LeaderChanged` references** during this PR. Grep across `packages/backend/src`, `packages/web/app`, the iOS native code, and the shared schema. Confirm each call site is for "presentation / share image / auth on legacy mutations" — not for wall-control. If any leader-only path turns out to gate wall control today, port it to `driverParticipantId` explicitly rather than relying on the field name.
- **Driver-only prev/next in the drawer:** `next-climb-button.tsx` and `previous-climb-button.tsx`, _when used inside the Play View Drawer_, render only when the local user holds the lightbulb. Navigating prev/next here walks the shared session queue first, then falls through to `suggestedClimbs` once the queue is exhausted, broadcasting each step. The existing `getNextClimbQueueItem` logic in `QueueContext.tsx` (around line 566; queue → suggestions fall-through) already implements this fall-through; the change is gating the broadcast on driver status.
- **Bar prev/next visible to everyone, with hold-to-confirm for non-drivers.** Render for all participants. Driver press: instant advance + broadcast. Non-driver press: requires a 3-second press-and-hold gesture to fire. The 3-second window shows a snackbar to the _presser only_ counting down ("Advancing in 3... 2... 1..."); releasing the button cancels and dismisses the snackbar. The advance mutation must accept from any session participant (the existing leader-only check at `sessions/mutations.ts:408-409` is not on the advance path — it gates legacy admin mutations; confirm in the audit and route the new advance through a participant-accessible mutation). Server-side, the mutation rejects only on `NO_BLE` (see Phase 4).
- **Live Activity widget prev/next are driver-only.** Hidden entirely for non-drivers — a lock-screen remote-control widget exposed to all members invites pocket-press griefing. The widget renders the wall climb + driver attribution for non-drivers but no advance controls. See `packages/backend/src/handlers/widget-navigate.ts` for the widget-navigation handler; only invoke from the widget surface when the user is the current driver. The server-side advance mutation propagates the `NO_BLE` reject code back so the widget can render the offline reason for drivers when relevant.
- **Wall-view drawer mode.** Tapping the body of the Queue Control Bar (not its prev/next buttons or lightbulb) opens the existing Play View Drawer in a new wall-view mode: hides prev/next, disables swipe-to-navigate, shows a "Currently on the wall" header with the driver's avatar inline, keeps the lightbulb and standard climb actions. The drawer component shouldn't fork — pass an `openedFromBar: boolean` prop (or equivalent) that toggles the read-only nav state and the header treatment. When opened from the bar, the drawer's displayed climb is `state.currentClimbQueueItem` (the wall climb, since Phase 1 made that field clean). When opened from a list tap, the displayed climb is whatever the user tapped (local drawer state).
- **Non-driver swipe handler:** drawer swipe stays available for non-drivers but walks `suggestedClimbs` only (skips `state.queue`) and does not broadcast. This is a different code path from the driver swipe — extract a shared helper or split the navigation hook so the driver/non-driver split is explicit.
- **Rename `Set Active Climb` → "Send to board"** in `set-active-action.tsx` and the i18n catalog (`packages/web/i18n/locales/en-US/common.json`). The PostHog event name stays `Set Active Climb` for analytics continuity — only the user-facing label changes.
- **Rename "Queue" → "Up next" in user-facing copy** in the same i18n pass. The internal data-structure names (`state.queue`, `addToQueue`, the GraphQL type, the event names `Add to Queue` / `Queue Navigation`, queue-list component name) all stay unchanged for analytics + code continuity. The change is strictly UI strings: any visible label that today reads "Queue", "Add to Queue", "Queue list", etc. becomes "Up next" / "Add to Up next" / "Up next list" or close equivalent. Run the i18n string audit across `packages/web/i18n/locales/en-US/*.json` and update every match. Spanish + French catalogs follow the project's existing fallback policy.
- **Delete the existing play-view drawer hint animation.** The bar-bounce-to-hint-the-drawer-exists code at `queue-control-bar.tsx:577-643` (the `playViewHintPlayedRef` state machine, the IndexedDB-gated trigger at `:616`, and the `setPreference('swipeHint:playViewSeen', true)` write at `:643`) is teaching the wrong model post-pivot. The bar's role is now self-evident from its content (wall mirror + driver avatar with lightbulb badge + prev/next + tap-for-wall-view); the bounce animation that previously hinted "there's something behind here" is obsolete and misleading. Also remove the `'swipeHint:playViewSeen'` entry from `packages/web/app/lib/user-preferences-db.ts:29`. The new lightbulb first-run coachmark in Phase 3 conceptually replaces it.

Files: `play-view-drawer.tsx`, `queue-control-bar.tsx`, `QueueContext.tsx`, `set-active-action.tsx`, `next-climb-button.tsx`, `previous-climb-button.tsx`, backend `queue-navigation.ts`, `room-manager.ts`, possibly new `take-control` message type in `packages/shared-schema`, i18n `common.json`.

### Phase 3 — Visual states + accessibility

The lightbulb appears in two places with two roles. They must be visually distinguishable and screen-reader-correct.

- **Drawer lightbulb:** "send/take this climb" — outlined, pressable. State depends on whether the user currently drives.
- **Bar lightbulb:** "I am holding control" — filled / glowing when held by the local user; dimmed with the current driver's avatar inline when held by someone else.
- **Driver-first avatar group on the session mini bar.** The party member `AvatarGroup` (currently in `queue-control-bar.tsx:1025-1045` and the expanded variant at `:1112+`) sorts the participant whose id matches `Session.driverParticipantId` first. The driver's avatar carries a small lit-up lightbulb badge in the corner (overlay), matching the bar lightbulb's filled/glowing visual. Non-driver avatars render without a badge in their existing order. The expanded roster view follows the same ordering and badging rules so the driver is unambiguous wherever members are listed. **Avoid resort jitter on rapid driver changes:** if rapid yanks become a visual nuisance (e.g. >1 change per 10s), debounce the reorder by 500ms — the badge change can be instant, the reorder can wait briefly.
- **Snackbar visual for the hold-to-advance gesture (non-driver bar prev/next).** Renders MUI snackbar at the bottom of the screen, above the bar. Copy: "Advancing in 3..." → "...2..." → "...1..." → fade out as the wall changes. Auto-dismisses on release or completion. Visible to the _presser only_ (not broadcast to other party members — climbs change frequently and party-wide notifications would be too noisy).
- **VoiceOver/TalkBack labels** must be role-and-state distinct:
  - Drawer + driving: "Send '{climbName}' to the wall."
  - Drawer + not driving: "Take wall control and send '{climbName}'."
  - Bar + you're holding: "You're driving. Tap to release."
  - Bar + someone else holds: "{name} is driving. Tap to take over."
- **State must not be encoded by colour alone** (WCAG 1.4.1). Use fill/outline variants + avatar attribution on the bar.
- **Hit targets** minimum 48×48dp. Lightbulb on the drawer must sit in the bottom action row (thumb-zone-aligned for iPhone Pro Max one-handed use).
- **First-run coachmark:** on the user's first drawer-open after this ships, pulse the lightbulb once with a brief tooltip ("Send to the wall"). Persist a `lightbulbSeen` flag in IndexedDB per the existing `swipeHint:*` pattern in `queue-control-bar.tsx`. **Add the key to `UserPreferenceKeyMap` in `packages/web/app/lib/user-preferences-db.ts`** (sits next to the existing `'swipeHint:climbListSeen'` / `'swipeHint:queueBarSeen'` entries) — without the registration, `getPreference` / `setPreference` will return `unknown` and the linter won't flag the missing type. Suggested key: `'swipeHint:lightbulbSeen': boolean` to match the existing prefix convention. Once added, look at `swipeHint:queueBarSeen` (`queue-control-bar.tsx:524`) and decide whether the queue-bar peek animation is also obsolete under the new model (the bar's role is self-evident post-pivot); if obsolete, delete that hint + key in the same pass.

Use existing tokens from `packages/web/app/theme/theme-config.ts`. No new colours or spacing primitives.

### Phase 4 — Wall-offline / no-BLE handling

**Goal:** the wall-offline state must ship in v1, not as a follow-up. A silent stuck-on-last-climb state — or a "successful" advance mutation that doesn't actually change the wall — is worse than today's behaviour and would erode trust in the new model. This state covers both "nobody ever connected BLE" and "the last BLE holder disconnected past grace."

- Track BLE-holder presence in the room manager. On disconnect, start a 5-second grace timer.
- If grace expires with no other BLE-capable member, broadcast a `WallOffline` state to all party members. Same state applies on session start when no member has connected BLE yet.
- Bar UI surfaces a small "Wall offline" indicator (text + muted styling on the wall-climb preview).
- Bar prev/next are disabled with a "Wall offline — connect a board" hint while in this state. Live Activity prev/next (driver-only) are similarly disabled in this state for the driver.
- **Server-side, the advance mutation rejects with a single `NO_BLE` error code while in this state.** This is the only reject code on the advance mutation — the earlier two-state design (`NO_LEADER` + `NO_BLE`) was collapsed to one. Reason: the driver concept isn't surfaced to users most of the time; presenting a "press the lightbulb to take the wall" hint when no one is driving but BLE is up would expose internal state the user doesn't think about. Instead: when no one is driving and BLE is up, bar prev/next is still enabled, hold-to-confirm fires the advance, and the system handles "no driver" silently server-side (no behaviour change for the user). When BLE is down, the disabled state and the offline hint are the user-legible signal.
- Lightbulb becomes a "Claim wall" affordance — pressing it makes you driver even without BLE, so you're ready to drive once BLE comes up. The lightbulb is never disabled by no-BLE; only the advance is.
- On successful BLE establishment by a new holder, broadcast `WallOnline` and resume.

Files: `packages/backend/src/services/room-manager/room-manager.ts`, `client-lifecycle.ts`, `packages/shared-schema` for new message types, `queue-control-bar.tsx` for the offline visual.

### Phase 5 — Instrumentation

Update analytics so we can verify the pivot works in production. **Critical: do not change the semantics of any existing event** — that would break the time series and make it impossible to measure success against today's baseline.

- **New event** `Wall Control Taken` — properties: `source: 'lightbulb_drawer' | 'lightbulb_bar' | 'send_to_board_menu' | 'auto_solo'`, `previousDriver: 'none' | 'self' | 'other'`, `mode: 'solo' | 'party'`, `boardLayout`.
- **New event** `Wall Control Released` — properties: `reason: 'manual' | 'yanked' | 'disconnect'`, `mode`, `boardLayout`.
- **New event** `Wall Advance` — fired on every successful advance mutation from the bar / Live Activity / driver drawer. Properties: `source: 'bar_button' | 'bar_button_held' | 'drawer_button' | 'drawer_swipe' | 'live_activity'`, `pressedByRole: 'driver' | 'non_driver'`, `direction: 'next' | 'previous'`, `mode`, `boardLayout`. `bar_button_held` specifically tags the non-driver hold-to-confirm path so we can measure griefing-vs-deliberate use.
- **New events** `Wall Offline` and `Wall Online` — fired when the BLE-holder grace period expires / a new holder establishes. Properties: `mode`, `previousHolderRole: 'self' | 'other'`, `gracePeriodMs`.
- **Existing event** `Set Active Climb` — semantics unchanged. Still fires from the (now renamed-in-UI to "Send to board") menu action. The lightbulb path fires `Wall Control Taken` instead. Do not collapse the two — keep them distinct so the time series is interpretable.
- **Existing event** `Queue Navigation` — semantics unchanged. After the pivot it fires only from the now-driver-only prev/next paths, so volume will drop in absolute terms (only drivers fire) but each event represents a deliberate broadcast, which is the cleaner signal.
- **Existing `Queue Operation`** — expect a dramatic drop in `setCurrentClimb` operations (today 60% of all queue ops, ~18K events / 3 months) because browsing no longer mutates. The cleaner signal that survives is the explicit lightbulb-press.
- **Existing `Add to Queue`** — semantics unchanged; expect modest growth as the feature has a clearer purpose ("suggest for the session") distinct from broadcast. Watch the `swipe` vs `climbActions` split (today 57:43).

**Pre-registered success metric (lock in before launch):**

- **Primary:** within 4 weeks of rollout, `Wall Control Taken` events per active party-mode user should exceed today's `Set Active Climb` event rate per active party-mode user.
- **Primary:** party-cohort retention (sessions per user over a 30-day window) should not decline relative to the 4 weeks before launch.
- **Counter-metric (anti-griefing / anti-confusion):** the rate of `Wall Control Released` within 30s of `Wall Control Taken` should not exceed 15% of takes. A high rapid-release rate would indicate users are fighting for or accidentally claiming control — the new model would look "active" in the primary metric but actually be confusing. Record the baseline rate (close to zero today since the lightbulb concept doesn't exist) and define the kill threshold at 15%.

If any of the three misses, the pivot is reverted or revised. Record all baselines before phase-2 ships.

Update `packages/web/app/lib/queue-metrics.ts` if the operation sampling logic needs to accommodate the new events.

### Phase 6 — QA + dev-server validation

Standard project flow per CLAUDE.md:

- Write `.boardsesh/qa-notes.md` with the QA plan before starting `vp run dev`.
- Cover: solo BLE quickstart → tap → press lightbulb path; solo no-BLE state; party join → browse without consequence → take control via lightbulb → driver's drawer prev/next appear → released-and-yanked flows; **non-driver pressing bar prev/next: short tap does nothing, 3s hold completes with snackbar countdown, release mid-hold cancels**; non-driver does NOT see prev/next in Live Activity (hidden); driver presses bar/Live Activity prev/next instant; offline-and-back-online in a party; BLE-holder drop with 5s grace and claim-wall handoff; no-BLE state (nobody in party has BLE, fresh session or post-drop) disables bar prev/next with "Wall offline" hint and rejects the advance mutation; pressing the lightbulb still works in no-BLE state and claims driver pre-emptively; tapping the bar body opens the wall-view drawer (no prev/next, no swipe, "Currently on the wall" header, driver avatar inline, lightbulb still works).
- Confirm normal drawer prev/next buttons disappear for non-drivers; bar prev/next visible to all (non-driver needs hold); Live Activity prev/next hidden for non-drivers.
- Confirm "Send to board" label appears wherever "Set Active Climb" did, and "Up next" appears wherever "Queue" did in user-facing copy.
- Run `vp check` and `vp run typecheck` before pushing.
- Open a PR with screenshots / screen recordings of the new lightbulb states and the driver-vs-non-driver UI difference.

## Background — why this design

**Observed pain (user-tested):** in large-group party sessions, climbers resting between turns cannot browse the catalogue to line up what they want next, because tapping a climb in the list immediately changes what is lit on the wall for the climber currently on the route. This pattern has surfaced repeatedly in user testing. The pivot's primary job is to fix this.

**Supporting analytics** — three months of production data from Vercel Analytics dashboard (no API access; PostHog only went live this week so its window is ~7 days):

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

`Add to Queue` UI events (3 months) by source: `swipe` 240, `climbActions` 183. The dedicated `queueButton` source fires zero events — likely an instrumentation gap or invisible affordance.

`Queue Navigation` UI events (PostHog week — directionally stable): 4,753 next-swipes + 1,085 previous-swipes inside the Play View drawer. 20 events combined on the Queue Control Bar arrows/swipe. 8 events on the bar's button arrows. The persistent control bar is structurally unused as an interaction surface.

Board concentration: Kilter Original 78% of sends, Kilter Homewall 17%, everything else combined 5%. Design Kilter-first; cross-board parity is a tax that returns nothing.

The 1,650-visitor gap between "queue-touching" (4,071) and "board-sending" (2,419) is consistent with hesitant-to-tap behaviour: users who would explore the catalogue but don't because the cost of tapping is "you change the wall." The pivot drops that cost to zero.

## Code pointers (verified, may drift)

- Queue state machine + context: `packages/web/app/components/graphql-queue/QueueContext.tsx`. `setCurrentClimb` is the function at line 383; the `shouldAddToQueue: true, insertAfterCurrent: true` payload at line 397 is what makes the implicit queue an auto-history of every tap. The queue → suggestions fall-through lives in `getNextClimbQueueItem` at line ~570-583.
- Suggestions derivation: `packages/web/app/components/queue-control/hooks/use-queue-data-fetching.tsx:234` (`suggestedClimbs` memo, derived from `climbSearchResults`).
- Queue Control Bar UI: `packages/web/app/components/queue-control/queue-control-bar.tsx`. Party member `AvatarGroup` lives at `:1025-1045` (mini bar) and `:1112+` (expanded variant) — both need driver-first ordering and the lightbulb badge.
- Queue list view: `packages/web/app/components/queue-control/queue-list.tsx`. History default count, "Show full history" button, and current-item-centered-on-open all land here. Existing `scrollToCurrentClimb` (`:50`), `history-item` / `history-divider` row types (`:40-41`), and `scrollTargetFlatIndex` logic (`:218+`) are the hooks to reuse.
- Session participant schema: `packages/shared-schema/src/schema/session.ts:147` (`SessionParticipant` type), `:175` (`participants` field on `Session` — add `driverParticipantId: ID` here as a new field). The existing `isLeader` / `leaderId` / `leaderConnectionId` fields (`:18`, `:43`) keep their current semantics; do **not** overload them.
- Existing `LeaderChanged` event type at `packages/shared-schema/src/types/events.ts:99`. Add a new `DriverChanged` event next to it; do not repurpose `LeaderChanged`.
- Audit targets for the `isLeader`-overload-avoidance task: `packages/backend/src/graphql/resolvers/sessions/mutations.ts:280, 344, 408-409`, `packages/web/app/api/og/session/route.tsx:34, 65`, and any references found in iOS native code + `packages/shared-schema/src/operations.ts`. Goal of the audit: confirm none of these gate _wall-control_ behaviour today; if any do, port that path to the new `driverParticipantId` field explicitly.
- Play View Drawer (where the lightbulb action will live): `packages/web/app/components/play-view/play-view-drawer.tsx`.
- Prev/next button components: `packages/web/app/components/queue-control/next-climb-button.tsx`, `previous-climb-button.tsx`.
- BLE send + connection: `packages/web/app/components/board-bluetooth-control/bluetooth-context.tsx`, `auto-connect-handler.tsx`, `use-board-bluetooth.ts`.
- "Send to board" action (renamed from Set Active Climb): `packages/web/app/components/climb-actions/actions/set-active-action.tsx`.
- Backend party / queue state: `packages/backend/src/services/room-manager/queue-state.ts`, `packages/backend/src/services/room-manager/room-manager.ts`, `packages/backend/src/services/room-manager/client-lifecycle.ts`. The shared queue-navigation helper lives one level up at `packages/backend/src/services/queue-navigation.ts` (used by both the `setCurrentClimb` resolver and the widget-navigate handler).
- Live Activity widget navigation: `packages/backend/src/handlers/widget-navigate.ts`.
- Analytics wrapper: `packages/web/app/lib/analytics.ts`. Queue Operation sampling: `packages/web/app/lib/queue-metrics.ts`.

## Open questions (remaining)

Not blockers. The implementing engineer should make the call in code review with whoever owns UX.

1. **Lightbulb hold without an output device (solo + no BLE).** Off until BLE is up (with a "Connect a board" affordance in its place), or auto-engage so pressing it triggers pairing? Recommend the latter — single discoverable affordance regardless of connection state.
2. **Hand-off notification UX.** When someone yanks control from you, what does your phone do? Recommend: a quiet toast ("Alice took the wall"), no haptic, no sound — climbing flow shouldn't have negotiation friction.
3. **Lightbulb position on the bar when someone else holds it.** Driver's avatar inline with the lightbulb; tapping the avatar opens the party roster.
4. **Add to Queue placement under the new model.** The action stays, but its UX placement may want revisiting (still swipe-on-list-row? still a menu item? both?). No change in this PR; flag for the design pass that follows.
5. **Swipe-in-drawer for non-drivers.** Resolved: swipe stays available and walks `suggestedClimbs` only (preview, no broadcast, skips the shared queue). See "The queue and suggestions model" above.

## Non-goals / explicit nos

- Do not rename the literal word "queue" in user-facing copy in this PR. (The `Set Active Climb` → "Send to board" rename _is_ in scope and lands in Phase 2.)
- Do not change the `Add to Queue` swipe gesture or menu entry. They already work and the 57:43 swipe:menu ratio suggests the gesture is the preferred path.
- Do not pre-build a session-summary / bulk-tick surface in this PR.
- Do not change Workout Generator or Onboarding in this PR.
- Do not collapse the existing `Set Active Climb` event into the new `Wall Control Taken` event. Keep them distinct for analytics continuity.
- Do not ship a climber-on-wall safety lock or yank cooldown in this PR. Today's behaviour is "any list-tap yanks instantly"; lightbulb-press is strictly better and the cooldown polish can land in v2.

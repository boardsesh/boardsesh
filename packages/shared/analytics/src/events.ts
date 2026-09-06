// Cross-platform event names fired by BOTH web and mobile. Defining them once
// here is the whole point of the package: it stops the two platforms drifting on
// a name (`"Tick Logged"` vs `"Tick logged"`) which would silently split one
// funnel into two in PostHog.
//
// `track()` deliberately still accepts a plain `string`, so this catalog is
// opt-in — reference `SHARED_EVENTS.TickLogged` at shared call sites to get the
// guarantee, while platform-only events (web's `$web_vitals`, etc.) stay free
// strings with zero churn to existing sites.
export const SHARED_EVENTS = {
  // Auth
  LoginAttempted: 'Login Attempted',
  LoginSucceeded: 'Login Succeeded',
  LoginFailed: 'Login Failed',
  // A user dismissing the provider sheet or the browser is intent, not a failure.
  // Kept distinct from LoginFailed so the failure metric isn't inflated by cancels.
  LoginCancelled: 'Login Cancelled',
  Logout: 'Logout',
  // Fired once, immediately after a NEW account is created via credentials
  // (both platforms). OAuth registration is indistinguishable from OAuth
  // sign-in and stays tagged only via LoginSucceeded's `is_registration: true`
  // — web has no separate OAuth-signup event either. Kept distinct from
  // LoginSucceeded so "created an account" and "successfully authenticated"
  // stay separately measurable — web's signup can require email verification
  // and never reach a LoginSucceeded in that same session.
  SignupCompleted: 'Signup Completed',
  // Queue / session
  AddToQueue: 'Add to Queue',
  ClimbAddedToQueue: 'Climb Added to Queue',
  // A climb from a DIFFERENT board than the queue is on was tapped, so the
  // cross-board prompt was raised. Props: { outcome: 'add' | 'switch' | 'cancel',
  // activeBoardName?, climbBoardName, climbLayoutId }. The outcome split is the
  // signal: mostly `switch` means people keep landing on the wrong board first;
  // mostly `cancel` means the prompt is firing where it isn't wanted.
  CrossBoardQueueAddPrompted: 'Cross Board Queue Add Prompted',
  ClimbRemovedFromQueue: 'Climb Removed from Queue',
  QueueReordered: 'Queue Reordered',
  QueueCleared: 'Queue Cleared',
  // Fired on every queue advance, including the broadcast advances that used to
  // ALSO fire a separate `Wall Advance`. That pair fired back-to-back from the
  // same handler at all four web call sites with overlapping props, so it was
  // folded in here: `sessionMode: 'party' | 'solo'` carries what `Wall Advance`
  // added, and `method` already encoded what its `source` re-encoded. Round-trip
  // success stays a separate question — see `Wall Confirmed` / `Wall Confirm Timeout`.
  QueueNavigation: 'Queue Navigation',
  SetActiveClimb: 'Set Active Climb',
  SessionStarted: 'Session Started',
  SessionEnded: 'Session Ended',
  // A climber dropped out of a session WITHOUT ending it for everyone else —
  // the non-destructive exit added in #3502. Props: { startedOnThisDevice,
  // couldHaveEnded } so the split between "left my own party from a second
  // phone" and "left someone else's party" is measurable. Ending still fires
  // Session Ended; the two are mutually exclusive per exit.
  SessionLeft: 'Session Left',
  SessionCommentAdded: 'Session Comment Added',
  // A session's title was edited (both platforms). Props: { source:
  // 'record_chrome' | 'session_detail', nameLength } — counts only, never the
  // title text.
  SessionRenamed: 'Session Renamed',
  AngleChanged: 'Angle Changed',
  // A party peer broadcast a playback frame count that disagrees with ours, so
  // the two clients read the same climb's frames differently and we stopped
  // following them instead of clamping onto a wrong frame (issue #3989).
  // Props: { peerFrameCount, localFrameCount, boardName } — counts only. Fires
  // once per stretch of disagreement, not per broadcast. Expected to stay
  // silent until the frames reader next changes shape; any volume at all means
  // a mixed-fleet rollout is skewing playback in the field.
  PlaybackPeerFrameMismatch: 'Playback Peer Frame Mismatch',
  // Queue sync-gate telemetry (createQueueSyncGate in @boardsesh/queue-runtime)
  // — observability for the sequence-gap / stale-event / hash-drift guards so
  // a resync loop or a dropped duplicate shows up in the field instead of only
  // in dev logs. Mirrors the signal web's Sentry-based watchdog captures
  // today (use-session-subscriptions.ts); mobile fires these via track()
  // since it has no equivalent Sentry breadcrumb for this path yet.
  QueueSyncStaleEventIgnored: 'Queue Sync Stale Event Ignored',
  QueueSyncGapResync: 'Queue Sync Gap Resync',
  QueueSyncHashDrift: 'Queue Sync Hash Drift',
  // Fired when a SessionRosterSnapshot (seeded first on every sessionUpdates
  // subscribe) actually CHANGES the local crew list — i.e. a roster delta had
  // been dropped and the snapshot reconciled it. The roster deltas carry no
  // sequence, so this is the only signal that presence drift happened in the
  // field (#2860). Its volume gates the deferred periodic-resnapshot healer:
  // if this rarely fires, seed-on-subscribe alone is enough.
  SessionRosterReconciled: 'Session Roster Reconciled',
  // Fired when a brand-new session's empty-room FullSync is skipped because the
  // local-queue seed failed (createSessionWithConfig) — the guard that stops a
  // failed seed from wiping the live queue, plus the re-seed it kicks off. Lets
  // us measure how often the seed lifecycle degrades in the field (#3878).
  QueueSeedFullSyncGuarded: 'Queue Seed FullSync Guarded',
  // Climb actions
  // Fired when the climb reaction/actions menu is opened, with a `source` prop
  // ('long_press' | 'more_button') and a `surface` prop naming the list the row was
  // in ('climbs_list' | 'playlist' | 'profile' | 'board_sheet'). Powers the
  // ⋮-button discoverability experiment: compare open rates + entry point.
  //
  // `surface` matters more than it looks: only the Climbs list passes
  // `showMoreButton`, so every other surface can emit `long_press` and nothing else.
  // Without it a `source` breakdown pools four screens against one and reads as a
  // like-for-like comparison it is not.
  ClimbActionsOpened: 'Climb Actions Opened',
  // Fired when a climb row is tapped to open the climb, with the same `surface`
  // prop. The denominator `Climb Actions Opened` never had: it tells us how many
  // rows people engage with before reaching for the menu at all.
  ClimbRowTapped: 'Climb Row Tapped',
  // Fired once per page fetched by the climbs list's end-reach, with the resulting
  // page index. List scroll depth was previously invisible — `handleEndReached`
  // tracked nothing — so no row-density or scan-speed change could be evaluated.
  ClimbListPaginated: 'Climb List Paginated',
  // Fired when the climber toggles the "Show quick-actions button" setting, with an
  // `enabled` prop — measures opt-in (control) vs opt-out (treatment) against the flag.
  ClimbQuickActionsSettingChanged: 'Climb Quick Actions Setting Changed',
  FavoriteToggle: 'Favorite Toggle',
  MirrorClimb: 'Mirror Climb',
  ClimbShared: 'Climb Shared',
  OpenInAuroraApp: 'Open in Aurora App',
  CreatePlaylist: 'Create Playlist',
  AddToPlaylist: 'Add to Playlist',
  RemoveFromPlaylist: 'Remove from Playlist',
  // Create climb
  ClimbCreated: 'Climb Created',
  ClimbUpdated: 'Climb Updated',
  ClimbCreateFailed: 'Climb Create Failed',
  // Workout / session-queue generator
  WorkoutGeneratorOpened: 'Workout Generator Opened',
  SessionQueueGenerated: 'Session Queue Generated',
  // Web-only by design: mobile's generator is a live auto-regenerating
  // preview with no matching discrete "generate" moment. Use
  // WorkoutGeneratorOpened + SessionQueueGenerated for cross-platform funnels.
  WorkoutGenerated: 'Workout Generated',
  // Deep-link session join
  SessionJoined: 'Session Joined',
  // Canonical board URLs — the two halves of one funnel: www hands a reader
  // off at `Climb Handoff Clicked`, the app receives them at
  // `Board Route Handoff`. Both carry `environment: 'production-web'` for the
  // app.boardsesh.com / www side, so one filter spans the whole hop. Divide the
  // second by the first for the hand-off completion rate; the gap is installs,
  // store bounces and blocked deep links.
  //
  // Fired by the native fleet and app.boardsesh.com. Props: { kind: 'list' |
  // 'climb' | 'slug-list' | 'slug-climb' | 'unparsed', status: 'resolved' |
  // 'not_found' | 'auth_required' | 'anonymous', source: 'deep-link' |
  // 'in-app' }.
  // `not_found` is held back for a parsed URL that failed while the device was
  // offline — that one heals on reconnect and would otherwise double-count as a
  // failure and a success.
  // `anonymous` is a signed-out reader who got the read-only climb view instead
  // of the login wall — web export only, and a climb URL only. It is a status
  // VALUE rather than a second event name precisely so the Clicked ÷ Handoff
  // ratio keeps counting the whole hop; split anonymous from signed-in arrivals
  // with a breakdown, not a new funnel.
  BoardRouteHandoff: 'Board Route Handoff',
  // Fired by www's SSR front doors when a reader taps "Climb this". Props:
  // { environment: 'production-web', surface: 'climb_front_door' |
  // 'list_front_door', tree: 'config-tuple' | 'slug', boardName, layoutId,
  // angle, climbUuid?, locale, campaign: 'front_door' }. `environment` is a
  // per-event property rather than a super property on purpose: PostHog
  // resolves per-event over super, so the tag reaches this funnel without
  // reclassifying $pageview, $web_vitals and every other www event that has
  // never carried it. The CTA href itself stays UTM-free — attribution is
  // these properties, because the app route has to match the bare pathname.
  ClimbHandoffClicked: 'Climb Handoff Clicked',
  // Logbook
  LogbookRowClicked: 'Logbook Row Clicked',
  // Logbook search / filter usage — privacy-safe (counts, field names, and the
  // sort preset only; never the raw query text or grade/date values). Drives the
  // "promote the most-used facets to the top level" call.
  LogbookSearched: 'Logbook Searched',
  LogbookFilterChanged: 'Logbook Filter Changed',
  LogbookSortChanged: 'Logbook Sort Changed',
  // Logbook entry mutations — the redesign's edit/delete UX previously had zero
  // baseline telemetry. Props: { method } for how the mutation was initiated;
  // never the entry's content. Deleted: 'swipe' | 'sheet' | 'a11y' (three
  // distinct commit paths). Edited: always 'sheet' today — swipe and the a11y
  // action only OPEN the edit sheet, and the save is committed there, so the
  // initiation isn't tracked separately.
  LogbookEntryEdited: 'Logbook Entry Edited',
  LogbookEntryDeleted: 'Logbook Entry Deleted',
  // Ticks / logbook
  //
  // The funnel is deliberately TWO events per platform: open, then outcome. It
  // used to be four (Opened + TickButtonClicked + QuickTickSaved + TickLogged on
  // mobile), where TickButtonClicked fired on save-intent immediately before the
  // mutation and QuickTickSaved fired in the same onSuccess callback as
  // TickLogged. Web fired the same TickButtonClicked name for a DIFFERENT moment
  // — the sheet opening — so one name covered two meanings across platforms.
  //
  // Fired at every explicit tick-sheet open, with a `source` prop: mobile
  // 'play_fab' | 'climb_actions' | 'queue_bar', web 'climb_actions' |
  // 'logbook_tick_button'. Gives the invariant Dismissed + Logged <= Opened; a
  // violation means the sheet presented without user intent (the phantom-reopen
  // bug this event was added to watchdog).
  QuickTickOpened: 'Quick Tick Opened',
  QuickTickFailed: 'Quick Tick Failed',
  // Mobile-only for now: fired when the tick sheet is closed (X button,
  // pan-down, backdrop tap) without a save completing. Props include a
  // field-completeness snapshot so abandonment can be measured directly
  // instead of inferred from QuickTickOpened - TickLogged - QuickTickFailed.
  QuickTickDismissed: 'Quick Tick Dismissed',
  // Canonical "a climb was logged" join event and the single commit event on both
  // platforms — it absorbed QuickTickSaved's payload. Required props: { climbUuid,
  // status, platform: 'web' | 'mobile', surface: 'web_full_form' |
  // 'web_quick_modal' | 'mobile_quick_tick' }, plus the tick detail
  // (attemptCount, hasQuality, hasDifficulty, difficulty, grade, hasComment).
  TickLogged: 'Tick Logged',
  // Bluetooth / hardware
  BluetoothConnectionSuccess: 'Bluetooth Connection Success',
  BluetoothConnectionFailed: 'Bluetooth Connection Failed',
  BluetoothDisconnected: 'Bluetooth Disconnected',
  // BLE lifecycle telemetry — added so a session recording (and PostHog) shows
  // what the radio actually did. BluetoothConnectionStolen is the tug-of-war
  // signal: a write failed with a disconnect error while we believed we were
  // connected (another device grabbed the last-connection-wins board).
  BluetoothScanStarted: 'Bluetooth Scan Started',
  BluetoothConnectionStolen: 'Bluetooth Connection Stolen',
  // Mobile-only: the runtime BLE permission request came back denied, so the
  // flow bailed before any radio work. Previously this path only raised an
  // Alert (connect) or flipped the sheet to 'unavailable' (quickstart scan) and
  // emitted nothing at all, leaving a whole class of "Bluetooth doesn't work"
  // invisible in telemetry. Props: { surface: 'connect' | 'quickstart_scan',
  // platform, androidApiLevel, androidLocationPermissionGranted }, plus
  // `boardName` on the 'connect' surface only (the quickstart scan runs before
  // any board is chosen, so it has none to report).
  BluetoothPermissionDenied: 'Bluetooth Permission Denied',
  // Fired once per device-picker session (on close) with tallies of how each
  // listed device's board preview resolved: saved board, recorded serial
  // config, current-board fallback, or no preview at all. Measures how often
  // the serial→board resolution actually pays off in the picker UI.
  // Also carries `androidLocationPermissionGranted` (null off Android): on
  // Android 12+ binaries without the `neverForLocation` manifest flag, a
  // devicesTotal=0 session with location denied is the OS suppressing results,
  // not an absent board. Analyse it by USERS, not events — see
  // posthog-empty-picker-oracle-is-weak.
  BlePickerDevicesResolved: 'BLE Picker Devices Resolved',
  // Consent-driven scan recon: fired once per discovered board when a user
  // submits a bug report with the "Bluetooth trouble" toggle on. Carries the raw
  // advertisement payload (manufacturerData/serviceData hex, service UUIDs, name)
  // so we can find where newer bare-name boxes stash their serial / LED
  // generation. Batched by reconCorrelationId. Not fired on normal connects.
  BleAdvertisementRecon: 'BLE Advertisement Recon',
  ClimbSentToBoardSuccess: 'Climb Sent to Board Success',
  ClimbSentToBoardFailure: 'Climb Sent to Board Failure',
  // A climb reached the BLE send path but NO packet was written to the wall.
  // Distinct from Failure (a write was attempted and errored): here nothing is
  // sent, so the wall is never dark-fired. `skipReason`:
  //  - 'unresolved_climb' — the current climb has no frames yet (a partially-
  //    synced peer broadcast, or a FullSync / snapshot restore that landed before
  //    the climb hydrated). Empty frames is the board's "clear all LEDs" command,
  //    so the auto-sender holds the write until resolution patches the frames in.
  //    Fired once per queue-item uuid. Extra props: hasName, hasBoardType,
  //    hasLayout, inSession.
  //  - 'no_adapter' / 'no_board_config' — sendFramesToBoard was called while the
  //    adapter or active board config was missing (a connected-but-not-ready
  //    window); the send bailed before touching the transport.
  //  - 'adapter_lost' — the queued send reached the transport after the adapter
  //    was torn down (reconnect/disconnect) WITHOUT the abort signal firing.
  //    Routine aborted sends stay silent; this is the surprising "dropped mid-
  //    queue" variant.
  // Props: board config (boardName/layoutId/sizeId when known), climbUuid,
  // sendSource (when known), skipReason.
  ClimbSentToBoardSkipped: 'Climb Sent to Board Skipped',
  // Fired on a successful USER-INITIATED clear-all write (sendSource 'clear';
  // both Aurora and MoonBoard, the latter via its `l##` empty frame — #3420).
  // Internal clears (spill skip, auto-sent empty frames) are untagged and do
  // not fire this. Props: mobile sends its full board analytics set (boardName,
  // layoutId, sizeId, mirrored, boardId?, connectedViaMismatchOverride,
  // sendSource); web sends boardName, layoutId, sizeId.
  BoardLightsCleared: 'Board Lights Cleared',
  // A queued climb set for a DIFFERENT board/layout than the connected board was
  // skipped instead of dark-firing the wall. Props: skippedClimbUuid,
  // skippedCount, advancedToClimbUuid (null when no compatible climb remained),
  // clearedBoard (true when the wall was cleared rather than advanced — a party
  // session, or no compatible climb left), active board config, and the skipped
  // climb's board config.
  BleQueueClimbSkipped: 'BLE Queue Climb Skipped',
  // The "this controller belongs to another board setup" dialog was shown when a
  // scanned serial resolved to a different board config than the active one, and
  // how the user resolved it. Resolved `action`: 'cancel' | 'connect_anyway' |
  // 'switch_setup' | 'switch_failed'.
  BleBoardConfigMismatchShown: 'BLE Board Config Mismatch Shown',
  BleBoardConfigMismatchResolved: 'BLE Board Config Mismatch Resolved',
  // Search
  // Fired once per resolved search/filter result set, keyed on the search text +
  // filter signature (not per keystroke, not per page). Carries hasQuery,
  // queryLengthBucket, activeFilterCount and the result count, so search coverage
  // and zero-result rate stay measurable without a per-tap companion event.
  ClimbSearchPerformed: 'Climb Search Performed',
  SearchHoldFilterChanged: 'Search Hold Filter Changed',
  SearchHoldFilterCleared: 'Search Hold Filter Cleared',
  SearchZoneEnabled: 'Search Zone Enabled',
  SearchZoneUpdated: 'Search Zone Updated',
  SearchZoneCleared: 'Search Zone Cleared',
  SearchZoneModeChanged: 'Search Zone Mode Changed',
  // Beta videos
  BetaVideoLinkClicked: 'Beta Video Link Clicked',
  BetaVideoClimbClicked: 'Beta Video Climb Clicked',
  // "Share your beta" outbound flow: caption copied to clipboard, and Instagram
  // launched to post the reel. Web fires the matching raw-string names today, so
  // both platforms land in one funnel.
  BetaCaptionCopied: 'Beta Caption Copied',
  BetaInstagramOpened: 'Beta Instagram Opened',
  // The inbound half of that flow: a reel shared INTO the app got pinned to an
  // ascent from the share-beta picker. That screen shipped with no analytics at
  // all, so nothing could say whether the caption auto-match actually picks the
  // climb or whether people scroll for it — which is exactly the question that
  // had to be guessed at when #3357 asked how much the picker's board art is
  // worth. Props: { source: 'suggested' | 'other', boardType, viaSearch,
  // hasCaption }. `hasCaption` is a boolean on purpose — the caption is the
  // user's post content and never leaves the device.
  BetaAttached: 'Beta Attached',
  // Onboarding tour (first-run walkthrough). Web fires the same names from its
  // step-based guided tour; the mobile welcome carousel reuses them so both
  // platforms land in one PostHog funnel.
  OnboardingTourStarted: 'Onboarding Tour Started',
  OnboardingTourStepViewed: 'Onboarding Tour Step Viewed',
  OnboardingTourStepAdvanced: 'Onboarding Tour Step Advanced',
  OnboardingTourCompleted: 'Onboarding Tour Completed',
  OnboardingTourSkipped: 'Onboarding Tour Skipped',
  // Mobile-only: the first-run prompt was dismissed without choosing a button
  // (Android hardware-back / programmatic nav-away). Distinct from Skipped (the
  // intentional "look around" tap) so every Started resolves to exactly one
  // outcome — Completed, Skipped, or Dismissed — instead of silently vanishing.
  OnboardingTourDismissed: 'Onboarding Tour Dismissed',
  // Activation: the user bound a board straight from the first-run handoff — the
  // real activation metric (board history turns on here), distinct from tapping
  // through the framing screen. Props: { boardType, source: 'onboarding' }.
  OnboardingBoardActivated: 'Onboarding Board Activated',
  BetaVideoAdded: 'Beta Video Added',
  // Board ENTITY creation — adding a wall to your boards (distinct from the
  // board-presence events below, which are about being on one). Added with
  // #4166: this flow had zero telemetry, so a bug that created no rows at all
  // for weeks was invisible in both PostHog and error tracking.
  // Props: { boardType, layoutId, sizeId, setCount, angle, isOwned, isPublic,
  //          hasLocationName, hasCoords, hasGym, gymUuid, source,
  //          allowedDuplicate }.
  // `gymUuid` is the gym being ATTACHED, and is deliberately NOT the same thing
  // as the `gym_uuid` super property (mobile, packages/mobile/src/lib/analytics-gym.ts)
  // — that one carries the ACTIVE board's gym, and a board being created has not
  // become active yet. Read them together to see a climber adding a second wall
  // at a venue they already use.
  BoardCreated: 'Board Created',
  // Props: { boardType, source, error_reason: 'duplicate_config' | 'rate_limited'
  //          | 'auth' | 'board_limit' | 'exception' }. 'board_limit' is the
  //          per-account board cap: a refusal no retry can clear, so it is worth
  //          keeping out of the 'exception' bucket.
  BoardCreateFailed: 'Board Create Failed',
  // The user already owned this board, so nothing was created and we activated
  // the existing one instead. Props: { boardType, source }.
  BoardCreateReusedExisting: 'Board Create Reused Existing',
  // The duplicate choice prompt was shown. The watchdog for #4166 is that
  // Prompted >= ReusedExisting + Created{allowedDuplicate}: if prompts stop
  // converting, creation is silently dead-ending again.
  // Props: { boardType, source, hasLocation }. `source` names the surface AND the
  // flow: 'popular_seed' / 'scratch' / 'web_drawer' are creates; 'mobile_edit' /
  // 'web_edit_drawer' are edits, where the choice is save-anyway vs keep-editing
  // (there is no existing board to switch to), so they never convert to
  // ReusedExisting — split on `source` before reading that ratio.
  BoardDuplicatePrompted: 'Board Duplicate Prompted',
  // Board presence — "now on the wall" (board-level collaboration, keyed on the
  // shared board_id resolved from the BLE serial). `boardId` is attached as an
  // event PROPERTY at the call sites — never the raw serial. Keep these to user
  // intent and explicit history actions; per-climb send/receive echoes are too
  // noisy for PostHog's event budget.
  BoardSheetOpened: 'Board Sheet Opened',
  BoardHistoryViewed: 'Board History Viewed',
  // Fired from the switch-board control's own `onPress`, before any other work.
  // Deliberately redundant with BoardSwapInvokedFromSheet (which fires one call
  // deeper, in the drawer host): the PAIR is the diagnostic. A session with
  // BoardSheetOpened but neither of these means the control was never reachable
  // — occluded, laid out past the sheet's detent, or swallowed by a wedged
  // presentation. This one alone means the handler chain broke in between.
  // Without the pair, a "switching boards did nothing" report is unfalsifiable.
  // Props: { boardId?, historyCount }.
  BoardSwapTapped: 'Board Swap Tapped',
  BoardSwapInvokedFromSheet: 'Board Swap Invoked From Sheet',
  // Fired after a board-history catch-up completes. Props:
  // { boardId?, reason: 'gap' | 'reconnect' | 'foreground' | 'manual',
  //   recoveredThroughSeqDelta }. `recoveredThroughSeqDelta > 0` means live
  //   events were silently dropped (Redis pub/sub has no replay) and just
  //   recovered — the signal for "history was slow/stale to update".
  BoardHistoryCatchUp: 'Board History Catch Up',
  // Fired each time "load older" resolves a page of durable history (past the
  // live feed's in-memory HISTORY_CAP window). Props:
  // { boardId?, pageSize: number, returnedCount: number }. `returnedCount <
  // pageSize` means that page was the last one.
  BoardHistoryPageLoaded: 'Board History Page Loaded',
  // External platform integrations (Apple Health, Strava). Props:
  // { integration: 'apple_health' | 'strava', trigger?: 'auto' | 'manual',
  //   enabled?: boolean }
  IntegrationConnected: 'Integration Connected',
  IntegrationDisconnected: 'Integration Disconnected',
  IntegrationAutoSyncToggled: 'Integration Auto Sync Toggled',
  SessionExportedToIntegration: 'Session Exported to Integration',
  // Offline sync — the board-download funnel (issue #4316). Started and
  // Completed are each fired ONCE EVER per board scope, guarded by durable
  // `scope-started:` / `scope-complete:` markers in sync_meta, so
  // Started → Completed is a real completion ratio rather than a count of
  // retries. Both markers survive sign-out (matching the board rows, which stay
  // as a shared cache) and are cleared by scope teardown, so removing and
  // re-adding a board starts a fresh funnel.
  //
  // THE INVARIANT: every Started has exactly one terminal event — Completed when
  // the scope finishes, Failed for everything else, teardowns included. It is
  // enforced structurally rather than site by site: the snapshot bootstrap phase
  // arms a guard at the Started emission and closes it from a `finally`
  // (`offline-sync/src/sync/download-funnel-guard.ts`), so an exit nobody
  // registered — a new `break`, a SQLite lock thrown outside the import's own
  // catch — still reports, as `reason: 'unknown-exit'`. A Started followed by
  // silence is therefore a bug in the guard, not a shape to design queries
  // around. The paged crawl is the one carve-out: it spans cycles by design, so
  // its Started stays open until Completed and abandonment there is measured as
  // "no Completed after N days".
  //
  // Fired the first time any cycle starts pulling a scope. Props: { scopeKey,
  // pathIntent: 'snapshot' | 'paged', artifactBytes: number | null, trigger,
  // offlineEngineEnabled }.
  //
  // `pathIntent` is an INTENT read from cheap local facts at that moment, not an
  // outcome — a snapshot-eligible scope can still fall back to the paged crawl
  // after the manifest resolves. Split funnels by Completed's `method` for the
  // resolved path.
  //
  // `trigger` distinguishes DELIBERATE taps from AUTOMATIC re-enables, which is
  // the whole point for discovery work: 'toggle' | 'download-all' (the My Boards
  // / More tap) vs 'auto-download-all' | 'adopt-auto' (a setting acting on its
  // own), plus 'adopt-confirmed' | 'retry' | 'unknown'. 'unknown' is an explicit,
  // expected value — the trigger is persisted per scope, but a scope enabled by
  // a build that predates this event has none.
  OfflineBoardDownloadStarted: 'Offline Board Download Started',
  // Fired once per board scope when its INITIAL download completes (every board
  // table reached the tail), so the snapshot-bootstrap warm-up can be compared
  // against the plain paged crawl in the field. Props: { scopeKey,
  // method: 'snapshot' | 'paged', durationMs, bytes?, rowCount?, downloadMs?,
  // importMs?, bootstrapHealed?, manifestMs, artifactReused, climbsPullMs,
  // statsPullMs, gradesPullMs, gradesRows?, gradesArtifactRows?,
  // importVerifyMs?, importReconcileMs?, importRowsMs?, importLockMaxMs?,
  // importBatches?, gradesDownloadMs?, gradesVerifyMs?, gradesLockMs?,
  // offlineEngineEnabled }.
  // Every optional prop is ABSENT rather than faked when this cycle cannot vouch
  // for it — most often because the completing delta pull landed in a later cycle
  // than the import. That biases those props toward the healthy population;
  // durationMs and the funnel ratio are unaffected. Read a missing value as
  // UNKNOWN, never as 0.
  // Grade rows a completion landed this cycle = (gradesArtifactRows ?? 0) +
  // (gradesRows ?? 0), meaningful only when at least one key is present.
  // `gradesRows` counts the paged crawl and is present only when that crawl
  // started from a cursor no earlier cycle advanced; `gradesArtifactRows` counts
  // the grades artifact's own import and is what makes a truthful `gradesRows: 0`
  // (the artifact left the crawl nothing to fetch) readable next to a board that
  // genuinely has no grades. Events from before issue #4393 shipped carry a
  // fabricated `gradesRows: 0`, so window those series from that merge date.
  // Filter on `bootstrapHealed != true` before comparing snapshot-vs-paged
  // durationMs percentiles: a healed scope (#4313) reports method 'snapshot' but
  // a duration that excludes the paged work earlier cycles did.
  // Deliberately NOT emitted: the breakdown's own `downloadMs`, `importMs` and
  // `artifactBytes` — the per-scope timings above carry the honest,
  // absent-when-unknown versions of the same numbers, so re-adding the phase
  // copies would put a cycle-scoped 0 next to them.
  //
  // THE IMPORT SPLIT (issue #4310), all nine absent-when-unknown for exactly
  // that reason — a cycle that ran no import did not spend the time, and most
  // completions are import-free because the artifact landed in an earlier cycle.
  // TWO DIFFERENT FILTERS, and mixing them up drops the population you want:
  //  - The six `import*` props: filter on `importMs IS NOT NULL`. Unfiltered,
  //    the p90 reads near zero whatever the import is doing.
  //  - The three `grades*` props: filter each on ITS OWN `IS NOT NULL`, never on
  //    `importMs`. The grades retrofit path imports grades for a scope that is
  //    ALREADY bootstrapped, in a cycle with no whole-layout import — which is
  //    precisely the still-crawling population #4719 is about, so an `importMs`
  //    filter would exclude the cycles these three exist to measure.
  //  - `importLockMaxMs` is THE number: the longest SINGLE exclusive-transaction
  //    hold of the import (reconcile, any row batch, or the checkpoint
  //    transaction), i.e. the worst case a concurrent user write has to survive
  //    (#4314). Before the batching change it was the whole import and had never
  //    been measured — `importMs` is ATTACH + quick_check over a 271 MB file +
  //    two full COUNT(*) scans + watermarks + the write work, and all but the
  //    last of those hold nothing. It is stamped from after BEGIN EXCLUSIVE
  //    succeeds, so it is a hold; its tail includes the WAL autocheckpoint some
  //    batch commits pay (the engine leaves the 1000-page default in place).
  //  - `importVerifyMs` / `importReconcileMs` / `importRowsMs` split `importMs`,
  //    with the lock-acquisition wait subtracted out of the last two and
  //    reported on its own as `importLockWaitMs`; `importBatches` counts the
  //    exclusive transactions the rows took.
  //  - `gradesDownloadMs` / `gradesVerifyMs` / `gradesLockMs` cover the SEPARATE
  //    grades artifact, whose transfer and (still unbatched) exclusive
  //    transaction were invisible to every phase field — most of the ~11s p50
  //    gap between `durationMs` and the sum of the phases.
  // Mobile-only today (the engine is shared, so a future web offline consumer
  // would fire this too).
  OfflineBoardDownloadCompleted: 'Offline Board Download Completed',
  // A bootstrap stage failed, or was cut short. Props: { scopeKey, stage:
  // 'manifest' | 'download' | 'import' | 'grades-download' | 'grades-import' |
  // 'board-removed' | 'abandoned', attempt, expected, reason, aborted,
  // errorMessage, offlineEngineEnabled }.
  // `expected: true` is a transport/reachability failure — a phone in a tunnel,
  // not a defect — and is the normal case, not an alarm. These previously went
  // only to Sentry, where they could not be joined to the funnel.
  //
  // READ `aborted` BEFORE COMPUTING A FAILURE RATE (issue #4314). `aborted: true`
  // means the cycle was TORN DOWN — the app backgrounded, or a sign-out/board
  // removal bumped the wipe epoch — not that anything broke; the same scope
  // resumes next cycle and can still emit Completed. Those teardowns are reported
  // so every Started has a terminal event (they used to emit nothing at all,
  // which made an interrupted 100 MB download structurally invisible), and they
  // are deliberately kept out of Sentry. A failure rate is
  // `Failed where aborted = false` over Started.
  //
  // `reason` is a closed, low-cardinality bucket — 'aborted-wipe' |
  // 'aborted-background' | 'abandoned-removed' | 'abandoned-signed-out' |
  // 'abandoned-disabled' | 'database-locked' | 'schema-stale' |
  // 'watermark-regression' | 'permanent-miss' | 'artifact-invalid' |
  // 'artifact-truncated' | 'network' | 'unknown' | 'unknown-exit' — for
  // grouping. The verbatim text stays on `errorMessage`. Dashboards that
  // ENUMERATE reasons need 'artifact-truncated' (issue #4394's exact
  // decoded-size gate), 'abandoned-removed' (#4406) and the two 'abandoned-*'
  // de-list reasons (#4452) added; failure-rate queries (`aborted = false`) pick
  // them up on their own.
  //
  // The three 'abandoned-*' reasons are the ones that COUNT abandonments rather
  // than interruptions: each fires at most once per Started, from the last code
  // that can still see the durable start marker. Every other abort-shaped reason
  // can repeat many times over one download (a pocketed phone, a sibling board's
  // removal), which is why "downloads given up on" was previously only derivable
  // as Started-minus-Completed. They differ only in what ended the download:
  //   'abandoned-removed'    — the board was removed and its rows deleted
  //                            (#4406), always with `stage: 'board-removed'`.
  //   'abandoned-signed-out' — sign-out ended it (#4452). Either the explicit
  //                            wipe deleted the markers, or a forced-401 /
  //                            expiry / identity-change sign-out emptied
  //                            `syncEnabledBoards`, which orphans the Started
  //                            just as thoroughly: the pull client's board loop
  //                            only ever visits enabled scopes.
  //   'abandoned-disabled'   — the climber turned the board off from My Boards,
  //                            or a launch sweep found a start marker for a
  //                            board nobody has enabled any more (#4452).
  //                            Nothing was deleted; a re-enable opens a FRESH
  //                            Started rather than resuming this one.
  // Both #4452 reasons carry `stage: 'abandoned'` — deliberately not
  // 'board-removed', which already ships in dashboards meaning "the rows were
  // deleted".
  //
  // What is still NOT reportable, and per production is the dominant
  // unterminated bucket: a Started followed by literally nothing — process
  // death, an uninstall, a climber who never opened the app again. No code
  // change can emit an event for those, so Started → Completed will not reach
  // 100% and is not meant to.
  //
  // One pairing changed with #4390: `aborted: true` can now arrive alongside an
  // `Offline Snapshot Retry Scheduled` with `failureKind: 'transport'` — the
  // 4th-and-beyond charged background pause. Every prior pairing had
  // `aborted: false`.
  //
  // 'unknown-exit' should sit at ZERO: it means the bootstrap phase ended an
  // attempt in a way it cannot explain — no teardown, no error anyone caught —
  // and the guard's `finally` closed the funnel on its behalf. Alone among the
  // abort-shaped outcomes it goes to Sentry, because it says the code has a hole
  // rather than the phone went in a pocket. `attempt: 0` on any guard-emitted
  // report: it never spends the scope's retry budget.
  OfflineBoardDownloadFailed: 'Offline Board Download Failed',
  // Extra progress detail when the climber turns a board OFF mid-download.
  // Props: { scopeKey, source: 'manage', stage, fraction, bytesDone,
  // offlineEngineEnabled }.
  //
  // NOT the funnel's terminal, despite what this comment used to claim. It needs
  // a live SNAPSHOT progress frame naming the exact scope, which a paged crawl
  // never publishes — and it has fired ZERO times in 180 days of production as a
  // result. The terminal that always fires is
  // `Offline Board Download Failed { reason: 'abandoned-disabled' }` (#4452);
  // this one only adds `fraction` / `bytesDone` on the runs where we happen to
  // have them. Kept for that detail, not as a count of anything.
  OfflineBoardDownloadCancelled: 'Offline Board Download Cancelled',
  // One artifact transfer that actually moved bytes — the per-download
  // throughput measurement the funnel could not give us (issue #4394). Completed
  // fires at SCOPE completion, omits `downloadMs` whenever the delta pull lands
  // in a later cycle, and carries no transport dimension, so a slow transfer was
  // invisible unless the whole scope finished in one cycle. A REUSED artifact
  // fires nothing, so the denominator is always real network work.
  //
  // Named for the transfer, not for the strategy experiment: event names are
  // permanent and the experiment is not. The props carry the dimensions.
  //
  // Props, all absent-when-unknown and never 0-when-unknown:
  //   strategy: 'download-file-async' | 'task-foreground' | 'task-background' —
  //     latched at transfer start, so a flag resolving mid-transfer cannot
  //     mislabel it.
  //   artifact: 'layout' | 'grades'.
  //   boardType, layoutId — layout artifacts only (bounded cardinality); absent
  //     for grades, whose manifest block carries neither.
  //   outcome: 'completed' | 'failed' | 'aborted' ('aborted' = we cancelled it).
  //   wireBytes — the stored object size, the same scale the confirm dialog and
  //     the progress bar quote.
  //   expectedDecodedBytes — `entry.uncompressedBytes`; absent on grades
  //     artifacts and pre-#4311 manifest entries.
  //   bytesOnDisk — the finished file's size; absent when there is no file.
  //   wallMs — start of transfer to settle. INCLUDES suspension time when
  //     `backgroundedDuringTransfer` is true.
  //   firstByteMs — start to the first progress callback carrying bytes; absent
  //     when none fired. Separates slow-to-start (DNS/TLS/CDN) from
  //     slow-throughput.
  //   wireKbps — wireBytes * 8 / wallMs, completed transfers only. WIRE scale
  //     deliberately: it is the number directly comparable to the 15 Mbit/s
  //     Safari and 1.3 Mbit/s in-app figures in #4394. Only meaningful when
  //     `backgroundedDuringTransfer` is false — a suspended transfer's wallMs
  //     includes wall-clock time nobody was downloading.
  //   backgroundedDuringTransfer: boolean.
  //   resumed: boolean — always false today; reserved so the resume follow-up
  //     needs no new prop.
  //   sizeMismatch: boolean — only present when expectedDecodedBytes was known
  //     and could be compared.
  //   metered: boolean — the adapter's cached NetInfo verdict; absent before
  //     NetInfo has reported.
  //   offlineEngineEnabled: boolean.
  OfflineArtifactTransfer: 'Offline Artifact Transfer',
  // A board's offline switch was flipped, either way. Props: { scopeKey,
  // enabled: boolean, source: 'manage' | 'storage' | 'more' | 'adopt',
  // offlineEngineEnabled }. The enable half is the entry point #4318's discovery
  // nudges are measured against.
  OfflineBoardToggled: 'Offline Board Toggled',
  // The "Download all my boards" switch was TAPPED (once per tap, not once per
  // board). Props: { boardCount, offlineEngineEnabled }. Deliberately not fired
  // by the mount effect that re-enables boards from the persisted setting — that
  // is an automatic re-enable and shows up as `trigger: 'auto-download-all'` on
  // Started instead.
  OfflineDownloadAllTapped: 'Offline Download All Tapped',
  // Offline sync — the device went longer than the tombstone retention window
  // without completing a deletions pull, so its local USER data was rebuilt
  // from scratch (issue #3474). Expected behaviour rather than an error: the
  // rate across the fleet is the signal. Props: { markerAgeDays, rowsCleared,
  // pendingMutations }. Downloaded board catalogs are deliberately untouched,
  // so this never implies a surprise re-download.
  OfflineSyncCoverageResetForced: 'Offline Sync Coverage Reset Forced',
  // Offline sync — a queued write was given up on permanently. A dead letter is
  // never a connectivity problem (a network error leaves the row pending
  // without burning retry_count), so each one is a user action that will never
  // reach the server. Props: { tableName, operation, reason:
  // 'retries_exhausted' | 'non_retryable', retryCount, status, queuedForMs,
  // error }. The idempotency key is deliberately NOT a prop — it is a raw uuid
  // or a per-climb key, i.e. unbounded cardinality; it rides the Sentry event.
  OfflineMutationDeadLettered: 'Offline Mutation Dead Lettered',
  // Offline sync — how much unsynced work was already sitting in the outbox at
  // launch. Per-mutation events only count from ship day, so without this every
  // backlog that accumulated earlier is invisible. Fires at most once per app
  // launch, and only when something is queued. Props: { pendingCount,
  // deadLetterCount, oldestPendingAgeDays, oldestDeadLetterAgeDays }.
  OfflineOutboxBacklogDetected: 'Offline Outbox Backlog Detected',
  // Offline sync — sign-out deletes the whole outbox, dead letters included, so
  // this is the size of what the user just lost. Emitted before the analytics
  // reset so it lands on the signed-in identity. Props: { pendingCount,
  // deadLetterCount, oldestPendingAgeDays, oldestDeadLetterAgeDays }.
  OfflineOutboxDiscardedOnSignOut: 'Offline Outbox Discarded On Sign Out',
  // Offline sync — an enqueue was swallowed by INSERT OR IGNORE because a
  // dead-lettered row already owns that deterministic idempotency key
  // (favorites, follows). The user's repeat action is dropped at enqueue time,
  // so neither a drain nor a dead-letter event can ever report it. Props:
  // { tableName, operation, existingStatus }.
  OfflineMutationEnqueueSuppressed: 'Offline Mutation Enqueue Suppressed',
  // Offline sync — the FIRST attempt of a local SQLite write (tick, favorite,
  // follow) threw, so the retry ladder ran. Silent on a clean write, so its raw
  // count is the contention rate. `outcome: 'recovered'` means a later attempt
  // landed and the user lost nothing; 'exhausted' means the ladder gave up and
  // the caller saw the throw. `attempts: 1` + 'exhausted' means the error was not
  // lock contention (disk full, corruption) and was therefore never retried.
  // `elapsedMs` is the contention-duration measurement — its distribution is what
  // should size the ladder, which today rests on an estimate. This is the ONLY
  // signal for a lost favorite/follow; those paths have no Sentry report at all.
  // Props: { tableName, operation, attempts, outcome: 'recovered' | 'exhausted',
  // isLockError, wasOffline, elapsedMs }.
  OfflineLocalWriteAttemptFailed: 'Offline Local Write Attempt Failed',
  // Offline sync — the local SQLite write behind an offline tick threw. `outcome`
  // says what happened next: 'queued' means the outbox-only fallback still saved
  // the tick and it will sync; 'fell_through' means it did not, and the direct
  // network save is the last chance (fine online, a lost tick offline).
  // `wasOffline` is the dimension that splits those two, and `isLockError` says
  // whether it was write-lock contention (#4314) rather than a broken database.
  // Exactly one per failed local write, on every exit path. A failed write also
  // emits one `Offline Local Write Attempt Failed` — two layers of one story (the
  // write ladder and the degrade), not a double count. A RECOVERED write emits
  // only that one, never this. Props: { isLockError, wasOffline, error,
  // outcome: 'queued' | 'fell_through' }.
  OfflineTickLocalWriteFailed: 'Offline Tick Local Write Failed',
  // Offline sync — the deletions-coverage verdict for one sync cycle, reported
  // whatever it is. The reset event above only fires on the rare wipe, and a
  // device that has never completed a deletions pull stays `unknown` forever
  // and emits nothing — so the reset-only view samples exactly the devices that
  // are not at risk. Props: { verdict: 'unknown' | 'future' | 'fresh' |
  // 'stale', markerAgeDays (null for unknown/future), outcome: 'evaluated' |
  // 'reset' | 'probe_failed' }. Deduped once-per-launch-per-verdict in the
  // mobile binding, because the engine evaluates on every foreground.
  OfflineSyncCoverageEvaluated: 'Offline Sync Coverage Evaluated',
  // Offline sync — a whole drain+pull cycle threw before reaching its idle
  // frame. The scheduler retries these after a bounded delay, but without this
  // event a device could show several downloaded artifacts followed by silence
  // and production telemetry could not distinguish a transport timeout from a
  // SQLite/import defect. Props: { phase, currentTable, documentsProcessed,
  // expected, status, errorKind, offlineEngineEnabled }. `currentTable` is null
  // during global deletion work; `expected` is true for transport-shaped
  // failures. Raw exception text stays in Sentry rather than analytics; an
  // unchanged signature is emitted at most once per five minutes.
  OfflineSyncCycleFailed: 'Offline Sync Cycle Failed',
  // Offline sync — the local SQLite setup lost the write lock at launch and a
  // later retry won, so offline storage came up after all. Fired at most once
  // per process, only when attempt 1 failed (a clean launch stays silent).
  // Props: { attempts, phase: 'wal' | 'queue-table' | 'migrations', elapsedMs,
  // sqliteCode }. Until this existed the lane was write-only: Sentry heard about
  // a launch that ran out of retries and nothing at all about one that recovered,
  // so "we fixed it" and "it still contends, it just retries its way out" looked
  // identical. `elapsedMs` is the contention-duration measurement — its
  // distribution is what sizes the retry window, which today is a guess.
  OfflineSqliteInitRecovered: 'Offline SQLite Init Recovered',
  // Offline sync — someone read climb data from the on-device database. THE
  // north-star signal for offline mode (issue #4317): weekly unique users firing
  // this with `lane in ('offline_local', 'network_error_local')`.
  //
  // ROLLED UP, NOT PER-READ. Search fires on every keystroke, so a per-read
  // event would be thousands per session and would evict other events from
  // PostHog's 1000-slot offline queue. The gate (createOfflineUsageSignal in
  // @boardsesh/offline-sync) counts reads per (UTC day, lane, board) and emits
  // only when the count crosses 1, 10 or 100. So `readCount` is the RUNG that
  // was crossed — 1 / 10 / 100 — never a raw per-read counter, and the absence
  // of a follow-up event means "fewer than the next rung", not "no more reads".
  //
  // Props: { lane: 'offline_local' | 'network_error_local' | 'online_local',
  //   surface: 'search' | 'climb_detail' | 'grade', boardName, readCount }.
  // `lane` is the source: served while offline, served after the network threw
  // (a lying connection — real offline value), or the online flag-on latency
  // short-circuit (NOT offline usage; excluded from the north-star). `surface`
  // is the read that crossed the rung, not an exhaustive list of what was used.
  //
  // A read that found NOTHING locally is not served, in any lane: climb detail
  // and the single-grade read can come back null from a downloaded board (the
  // row hasn't synced), and offline there's no network to retry against, so the
  // caller gets the same nothing the empty fallback gives. Counting it would put
  // "offline staring at an empty screen" into the north-star.
  OfflineReadServed: 'Offline Read Served',
  // Offline sync — the counterpart: the device was offline and there was nothing
  // local to serve, so the surface got an empty result. The conversion pool that
  // #4318 (discovery nudges) and #4002 (unsupported filters) exist to shrink.
  // Same rollup contract and same readCount semantics as Offline Read Served.
  // Props: { reason: 'board_not_downloaded' | 'filter_unsupported' |
  //   'local_db_unavailable', surface: 'search' | 'climb_detail' | 'grade',
  //   boardName, readCount }. `local_db_unavailable` means there was no database
  // handle to ask at all (init still retrying, or wedged — #4313 / #4314). The
  // board may well BE downloaded in that case, so it is deliberately NOT part of
  // #4318's nudge audience. `filter_unsupported` means the board IS downloaded
  // and only the filter blocked the read — when both are missing the reason is
  // `board_not_downloaded`, since fixing filters would still serve that read
  // nothing.
  OfflineReadUnavailable: 'Offline Read Unavailable',
  // Offline sync — an explicit, confirmed sign-out (or an account deletion) wiped
  // the device's local data, downloaded board catalogs included (issue #3621).
  // Fired only on the paths the user chose: a forced 401, a token expiry or a
  // confirmed identity change keep their catalogs and never emit this. Props:
  // { pendingDiscarded, deadLettersDiscarded, hadDownloads, vacuumed, bytesBefore?,
  // bytesAfter? }. Both counts are read inside the wipe's own transaction, so their
  // SUM is the exact post-drain outbox depth — the honest "offline writes lost at
  // sign-out" counter. They stay split because the two losses differ: the pending
  // ones were still trying and the sign-out drain got a shot at them, while the dead
  // letters had already spent their retries and were sitting under a Retry button on
  // the More tab. Not a duplicate of OfflineOutboxDiscardedOnSignOut: that one is the
  // pre-drain gauge every signed-out path emits, this one is what the full wipe
  // actually deleted, so the two differ by whatever the drain flushed in between.
  OfflineDataWipedOnSignOut: 'Offline Data Wiped On Sign Out',
  // Offline sync — a snapshot-bootstrap failure scheduled the scope's next
  // attempt (issue #4313). Operational, not an error: the failure itself still
  // goes to Sentry at its own severity. Props: { scopeKey, boardType, stage,
  // failureKind, retryAfterMs, transportFailures, lockFailures,
  // structuralFailures, terminal }. `terminal` means the budget the last failure
  // spent is exhausted, so the board is on the slow crawl until the climber
  // retries it or removes it.
  // `failureKind: 'database-locked'` with `lockFailures > 0` is the import losing
  // the SQLite write lock (issue #4310) — its own budget precisely because the
  // other two mis-handle it: transport is cleared by a retained artifact's
  // zero-byte "download", and structural strands the board after two strikes for
  // a fault the artifact did not cause. Query this series before changing
  // SNAPSHOT_IMPORT_BATCH_ROWS: non-zero volume means the batched import is a
  // real contender for the lock in the field, not just in theory.
  OfflineSnapshotRetryScheduled: 'Offline Snapshot Retry Scheduled',
  // Offline sync — a board that had previously failed the fast download got
  // back onto it. Props: { scopeKey, boardType, trigger, hadBoardCheckpoint }.
  // `trigger` says what revived it (a cooldown elapsing, a newly built
  // artifact, the post-#4313 marker migration, or the climber tapping retry);
  // `hadBoardCheckpoint` distinguishes a heal over a partly-crawled catalog
  // from a fresh board's first attempt.
  OfflineSnapshotPathRecovered: 'Offline Snapshot Path Recovered',
  // Offline sync — a JS sweep of the rendered board-art cache freed disk space
  // (issue #3647). Fired only when it actually freed something, so the rate is
  // the signal for "does the 200 MB cap ever bite in the field", and
  // `beforeBytes` is what the write-odometer trigger constant gets tuned from.
  // Props: { trigger: 'launch' | 'background' | 'write-threshold' |
  // 'board-removed' | 'manual' | 'disk-pressure', beforeBytes, freedBytes,
  // filesDeleted }. Mobile-only: web's overlay store is the Cache API, already
  // bounded by entry count.
  CachedImagesSwept: 'Cached Images Swept',
  // Offline discovery nudges (issue #4318) — the app suggesting a board download
  // rather than waiting to be found. One event trio across every nudge surface,
  // separated by `surface`, so the funnel reads shown → accepted → (#4316's
  // download started / OfflineBoardDownloadCompleted above). Props on all three:
  // { surface: 'post_session' | 'no_catalog' | 'whats_new' | 'board_card',
  //   boardType, layoutId, scopeKey, downloadedBoardCount }.
  OfflineNudgeShown: 'Offline Nudge Shown',
  // Plus { armedOnly }: true when the accept could only ARM the scope, so the pull
  // waits for the scheduler's reconnect trigger. Reported by the surface from what
  // it actually did, never from a connectivity probe — `useIsOffline()` reads
  // ONLINE on captive-portal wifi, where the arm-only CTA still downloads nothing.
  // Without it the funnel reads as accepts that never download.
  OfflineNudgeAccepted: 'Offline Nudge Accepted',
  // Plus { dismissKind: 'once' | 'forever' }.
  OfflineNudgeDismissed: 'Offline Nudge Dismissed',
  // Board render mode (issue #2202) — the classic-vs-Boardsesh drawing A/B and
  // the Boardsesh glow-falloff A/B (soft vs plateau). Full contract, property
  // tables and the stratification rule (never pool across boardName or
  // glowFalloffSource): docs/board-render-analytics.md. Builders live in
  // board-render-events.ts, re-exported from @boardsesh/analytics.
  //
  // Fired once per change of the climb drawn on the board — mobile fires it
  // from a queue-provider effect on the current climb, plus the play drawer's
  // preview latch. `reopened_in_session` distinguishes a genuinely fresh view
  // from a climber navigating back to a climb already open once this app run.
  //
  // Doubles as the glow-falloff experiment's CUSTOM EXPOSURE event: on a
  // `boardsesh` render whose falloff came from the flag it also carries
  // `$feature_flag` / `$feature_flag_response`. Mobile reads flags with
  // `sendEvent: false`, so `$feature_flag_called` is deliberately never sent —
  // see board-render-events.ts and docs/board-render-analytics.md.
  ClimbViewOpened: 'Climb View Opened',
  // Fired once per 2-finger pinch gesture END on the board (never per frame),
  // gated on a minimum absolute `scale_delta` so incidental finger jitter
  // doesn't count as a deliberate zoom. `scale_delta` is SIGNED (end minus
  // start), so a zoom-out counts as much as a zoom-in; `scale_max` /
  // `scale_min` are the gesture's true extremes.
  BoardPinch: 'Board Pinch',
  // Fired at most once per `Climb View Opened`, on whichever of "added to
  // queue" or "sent to board" happens first. `ms_since_open` is the gap
  // between the view opening and this action — the funnel this exists to
  // answer is whether the Boardsesh drawing changes how fast a climber commits
  // to a climb.
  ClimbFirstAction: 'Climb First Action',
  // The climber changed a Boardsesh render setting from the settings screen
  // (issue #2202, settings-screen PR). `field` names the setting; `value` is
  // its new value stringified.
  BoardRenderSettingsChanged: 'Board Render Settings Changed',
  // A board overlay failed to draw (issue: the Aura 12x12 blank-overlay
  // investigation). Fired for BOTH halves of the render path — the native
  // renderer rejecting, and expo-image failing to load the PNG it produced —
  // with `stage` separating them. Capped at 25 per JS lifetime in the mobile
  // hook, so a device stuck in a failure loop reports the shape of the problem
  // without minting thousands of events; `failures_this_session` still counts
  // past the cap, so a truncated stream is legible as truncated.
  BoardRenderFailed: 'Board Render Failed',
  // A saved render preset or CVD palette preset was applied (issue #2202,
  // settings-screen PR). No extra props beyond the common ones — the event IS
  // "the common props now carry a preset_id/palette_id".
  BoardRenderPresetApplied: 'Board Render Preset Applied',
  // The one-time "pick your board look" step (2.4, the Boardsesh-default flip).
  // Shown fires once per presentation; Resolved fires exactly once per Shown —
  // saved, customized, or skipped, including an unmount with neither. Paired so
  // the funnel can never read a climber who backed out as one who never arrived.
  BoardLookStepShown: 'Board Look Step Shown',
  BoardLookStepResolved: 'Board Look Step Resolved',
} as const;

export type SharedEventKey = keyof typeof SHARED_EVENTS;
export type SharedEventName = (typeof SHARED_EVENTS)[SharedEventKey];

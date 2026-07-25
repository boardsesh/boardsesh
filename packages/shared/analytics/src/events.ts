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
  ClimbRemovedFromQueue: 'Climb Removed from Queue',
  QueueReordered: 'Queue Reordered',
  QueueCleared: 'Queue Cleared',
  QueueNavigation: 'Queue Navigation',
  WallAdvance: 'Wall Advance',
  SetActiveClimb: 'Set Active Climb',
  PlayDrawerOpened: 'Play Drawer Opened',
  SessionStarted: 'Session Started',
  SessionEnded: 'Session Ended',
  SessionCommentAdded: 'Session Comment Added',
  // A session's title was edited (both platforms). Props: { source:
  // 'record_chrome' | 'session_detail', nameLength } — counts only, never the
  // title text.
  SessionRenamed: 'Session Renamed',
  AngleChanged: 'Angle Changed',
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
  // Climb actions
  // Fired when the climb reaction/actions menu is opened, with a `source` prop
  // ('long_press' | 'more_button'). Powers the ⋮-button discoverability experiment:
  // compare open rates + entry point between the flag's control/treatment cohorts.
  ClimbActionsOpened: 'Climb Actions Opened',
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
  // Mobile-only: fired at every explicit tick-sheet open (play-drawer FAB,
  // climb-actions menu, queue bar), with a `source` prop. Gives the invariant
  // Dismissed + Saved <= Opened; a violation means the sheet presented without
  // user intent (the phantom-reopen bug this event was added to watchdog).
  QuickTickOpened: 'Quick Tick Opened',
  TickButtonClicked: 'Tick Button Clicked',
  QuickTickSaved: 'Quick Tick Saved',
  QuickTickFailed: 'Quick Tick Failed',
  // Mobile-only for now: fired when the tick sheet is closed (X button,
  // pan-down, backdrop tap) without a save completing. Props include a
  // field-completeness snapshot so abandonment can be measured directly
  // instead of inferred from TickButtonClicked - QuickTickSaved - QuickTickFailed.
  QuickTickDismissed: 'Quick Tick Dismissed',
  // Canonical "a climb was logged" join event, fired on every successful tick
  // save on both platforms alongside each flow's own event above. Required
  // props: { climbUuid, status, platform: 'web' | 'mobile', surface:
  // 'web_full_form' | 'web_quick_modal' | 'mobile_quick_tick' }.
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
  // Fired once per device-picker session (on close) with tallies of how each
  // listed device's board preview resolved: saved board, recorded serial
  // config, current-board fallback, or no preview at all. Measures how often
  // the serial→board resolution actually pays off in the picker UI.
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
  ClimbSearchPerformed: 'Climb Search Performed',
  // Fired when a user opens a climb from the search result list. Carries the
  // tapped result's rank/position so the App Success dashboard can measure
  // search relevance, not just coverage.
  SearchResultSelected: 'Search Result Selected',
  // Grade-range control changed (web's GradeRangePicker / mobile's GradeRangeRail).
  // Shared so the native event lands in the same PostHog funnel as web's — the
  // gap #3290 closed: web fired this 10,933× on the legacy webview, native 0×.
  GradeFilterChanged: 'Grade Filter Changed',
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
  // Board presence — "now on the wall" (board-level collaboration, keyed on the
  // shared board_id resolved from the BLE serial). `boardId` is attached as an
  // event PROPERTY at the call sites — never the raw serial. Keep these to user
  // intent and explicit history actions; per-climb send/receive echoes are too
  // noisy for PostHog's event budget.
  BoardSheetOpened: 'Board Sheet Opened',
  BoardHistoryViewed: 'Board History Viewed',
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
  // Offline sync — fired once per board scope when its INITIAL download
  // completes (offline-sync's onScopeDownloadComplete, both tables reached the
  // tail), so the snapshot-bootstrap warm-up (Phase 3/4) can be compared
  // against the plain paged crawl in the field. Props: { scopeKey,
  // method: 'snapshot' | 'paged', durationMs }. Mobile-only today (the engine
  // is shared, so a future web offline consumer would fire this too).
  OfflineBoardDownloadCompleted: 'Offline Board Download Completed',
} as const;

export type SharedEventKey = keyof typeof SHARED_EVENTS;
export type SharedEventName = (typeof SHARED_EVENTS)[SharedEventKey];

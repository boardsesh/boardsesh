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
  //          hasLocationName, hasCoords, hasGym, source, allowedDuplicate }.
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
  // Offline sync — fired once per board scope when its INITIAL download
  // completes (offline-sync's onScopeDownloadComplete, both tables reached the
  // tail), so the snapshot-bootstrap warm-up (Phase 3/4) can be compared
  // against the plain paged crawl in the field. Props: { scopeKey,
  // method: 'snapshot' | 'paged', durationMs }. Mobile-only today (the engine
  // is shared, so a future web offline consumer would fire this too).
  OfflineBoardDownloadCompleted: 'Offline Board Download Completed',
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
  // Offline sync — the local SQLite write behind an offline tick threw, so the
  // tick fell through to a direct network save. Online that still lands;
  // offline it is a lost tick. `wasOffline` is the dimension that splits those
  // two, and `isLockError` says whether it was write-lock contention (#4314)
  // rather than a broken database. Props: { isLockError, wasOffline, error }.
  OfflineTickLocalWriteFailed: 'Offline Tick Local Write Failed',
} as const;

export type SharedEventKey = keyof typeof SHARED_EVENTS;
export type SharedEventName = (typeof SHARED_EVENTS)[SharedEventKey];

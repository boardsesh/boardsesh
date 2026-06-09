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
  Logout: 'Logout',
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
  AngleChanged: 'Angle Changed',
  // Climb actions
  ClimbInfoViewed: 'Climb Info Viewed',
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
  // Deep-link session join
  SessionJoined: 'Session Joined',
  // Logbook
  LogbookRowClicked: 'Logbook Row Clicked',
  // Ticks / logbook
  TickButtonClicked: 'Tick Button Clicked',
  QuickTickSaved: 'Quick Tick Saved',
  QuickTickFailed: 'Quick Tick Failed',
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
  ClimbSentToBoardSuccess: 'Climb Sent to Board Success',
  ClimbSentToBoardFailure: 'Climb Sent to Board Failure',
  // Search
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
  // Onboarding tour (first-run walkthrough). Web fires the same names from its
  // step-based guided tour; the mobile welcome carousel reuses them so both
  // platforms land in one PostHog funnel.
  OnboardingTourStarted: 'Onboarding Tour Started',
  OnboardingTourStepViewed: 'Onboarding Tour Step Viewed',
  OnboardingTourStepAdvanced: 'Onboarding Tour Step Advanced',
  OnboardingTourCompleted: 'Onboarding Tour Completed',
  OnboardingTourSkipped: 'Onboarding Tour Skipped',
  BetaVideoAdded: 'Beta Video Added',
} as const;

export type SharedEventKey = keyof typeof SHARED_EVENTS;
export type SharedEventName = (typeof SHARED_EVENTS)[SharedEventKey];

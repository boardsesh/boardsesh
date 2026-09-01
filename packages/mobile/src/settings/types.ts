import type { UserBoard } from '@boardsesh/shared-schema';

export type AppSettings = {
  defaultBoardUuid: string | null;
  syncEnabledBoards: string[];
  /**
   * Snapshots of the boards the user made available offline, so the picker can
   * still name and switch between them with no signal (`myBoards` is network-only
   * and a scope key can't identify a board — see `settings/offline-boards.ts`).
   * Versioned key: bump the `V1` suffix if `UserBoard` gains a required field, so
   * stale cards are ignored rather than misread.
   */
  offlineBoardsV1: UserBoard[];
  /**
   * Why each in-flight download was started, keyed by scope key (issue #4316).
   * Persisted rather than held in memory because the case that matters most is
   * exactly the one an in-memory map loses: a board enabled while offline, whose
   * download runs on a later launch. Consumed and pruned when the Started event
   * fires, and dropped with the scope on teardown, so it stays a handful of
   * short-lived entries.
   */
  offlineDownloadTriggers: Record<string, string>;
  /**
   * A "download all my boards" tap waiting for My Boards to resolve (issue
   * #4316). Same reason as the map above: the enable it causes runs from a mount
   * effect, so a ref would lose the attribution whenever the screen unmounts or
   * the app restarts before the list lands, and the batch would be filed as
   * automatic. Cleared the moment it is consumed.
   */
  offlineDownloadAllTapPending: boolean;
  /** Keep every board the user follows/uses available offline by default. */
  autoOfflineBoards: boolean;
  autoConnectBle: boolean;
  autoDisconnectBle: boolean;
  autoDisconnectTimeoutSeconds: number;
  /**
   * MoonBoard "V2" BLE feature: also light each active hold's firmware-defined
   * neighbour LED (typically the hold above), dimmer, alongside its role
   * colour. See `MOONBOARD_V2_ADDITIONAL_LED_PREFIX` in
   * `@boardsesh/ble-protocol/moonboard`. No-op on Aurora boards.
   */
  moonboardLightAdjacentHolds: boolean;
  /** Light the connected board when swiping to the next/previous climb in the play view. */
  lightOnSwipe: boolean;
  /** Light the connected board when tapping a climb to select it from a climbs list. */
  lightOnClimbTap: boolean;
  keepScreenAwake: boolean;
  theme: 'system' | 'light' | 'dark';
  hapticFeedbackEnabled: boolean;
  notifySessionInvites: boolean;
  notifyClimbComments: boolean;
  /** One-shot: the "kiosk setup lives on the big screen" hint has been seen on My gyms. */
  kioskHintSeen: boolean;
  /** Show the live bottom-chrome geometry overlay (dev / preview / pr-channel only). */
  bottomChromeDiagnostics: boolean;
  /**
   * Crowdsourced QA: the `<branch>:<updateId>` whose test plan has already been
   * shown on launch. Keyed on the bundle, not the branch, so the author's next
   * push to the same PR shows the brief again — that is a different thing to
   * test. Null until a tester surfs onto a preview.
   */
  qaBriefSeenKey: string | null;
  /**
   * Crowdsourced QA: the `<branch>:<updateId>` a verdict has been filed for.
   * Load-bearing, not just tidy: leaving a preview usually answers
   * `nothing-to-load` (production is not newer than a fresh `pr-N` bundle), so
   * the tester keeps running the preview until production publishes again. Without
   * this the gate would re-prompt and the drawer would keep offering to finish
   * testing something already signed off.
   */
  qaVerdictSubmittedKey: string | null;
};

export type SettingsKey = keyof AppSettings;

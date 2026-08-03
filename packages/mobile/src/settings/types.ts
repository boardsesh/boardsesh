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
  /** Keep every board the user follows/uses available offline by default. */
  autoOfflineBoards: boolean;
  autoConnectBle: boolean;
  keepScreenAwake: boolean;
  theme: 'system' | 'light' | 'dark';
  hapticFeedbackEnabled: boolean;
  notifySessionInvites: boolean;
  notifyClimbComments: boolean;
  /** One-shot: the "kiosk setup lives on the big screen" hint has been seen on My gyms. */
  kioskHintSeen: boolean;
  /** Show the live bottom-chrome geometry overlay (dev / preview / pr-channel only). */
  bottomChromeDiagnostics: boolean;
};

export type SettingsKey = keyof AppSettings;

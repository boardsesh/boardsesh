import type { MoonboardBackdropPreset } from '../theme/colors';

export type AppSettings = {
  defaultBoardUuid: string | null;
  syncEnabledBoards: string[];
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
  /**
   * MoonBoard wall backdrop preset (More → Accessibility → MoonBoard wall).
   * Stored as the preset key, not a hex, so `resolveMoonboardBackdrop` in
   * theme/colors.ts can be retuned later with no migration.
   */
  moonboardBackdrop: MoonboardBackdropPreset;
};

export type SettingsKey = keyof AppSettings;

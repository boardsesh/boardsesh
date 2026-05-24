export type AppSettings = {
  defaultBoardUuid: string | null;
  syncEnabledBoards: string[];
  autoConnectBle: boolean;
  keepScreenAwake: boolean;
  theme: 'system' | 'light' | 'dark';
  hapticFeedbackEnabled: boolean;
  notifySessionInvites: boolean;
  notifyClimbComments: boolean;
};

export type SettingsKey = keyof AppSettings;

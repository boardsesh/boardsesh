import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBoardUuid: null,
  syncEnabledBoards: [],
  autoConnectBle: true,
  keepScreenAwake: true,
  theme: 'system',
  hapticFeedbackEnabled: true,
  notifySessionInvites: true,
  notifyClimbComments: true,
};

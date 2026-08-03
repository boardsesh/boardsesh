import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBoardUuid: null,
  syncEnabledBoards: [],
  offlineBoardsV1: [],
  autoOfflineBoards: false,
  autoConnectBle: true,
  keepScreenAwake: true,
  theme: 'system',
  hapticFeedbackEnabled: true,
  notifySessionInvites: true,
  notifyClimbComments: true,
  kioskHintSeen: false,
  bottomChromeDiagnostics: false,
};

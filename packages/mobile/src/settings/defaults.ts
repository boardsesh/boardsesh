import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBoardUuid: null,
  syncEnabledBoards: [],
  offlineBoardsV1: [],
  offlineDownloadTriggers: {},
  autoOfflineBoards: false,
  autoConnectBle: true,
  autoDisconnectBle: false,
  autoDisconnectTimeoutSeconds: 30,
  keepScreenAwake: true,
  theme: 'system',
  hapticFeedbackEnabled: true,
  notifySessionInvites: true,
  notifyClimbComments: true,
  kioskHintSeen: false,
  bottomChromeDiagnostics: false,
};

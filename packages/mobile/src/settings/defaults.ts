import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultBoardUuid: null,
  syncEnabledBoards: [],
  offlineBoardsV1: [],
  offlineDownloadTriggers: {},
  offlineDownloadAllTapPending: false,
  autoOfflineBoards: false,
  autoConnectBle: true,
  autoDisconnectBle: false,
  autoDisconnectTimeoutSeconds: 30,
  lightOnSwipe: true,
  lightOnClimbTap: true,
  keepScreenAwake: true,
  theme: 'system',
  hapticFeedbackEnabled: true,
  notifySessionInvites: true,
  notifyClimbComments: true,
  kioskHintSeen: false,
  bottomChromeDiagnostics: false,
  sheetDetentDiagnostics: false,
};

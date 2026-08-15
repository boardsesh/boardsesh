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
  moonboardLightAdjacentHolds: false,
  keepScreenAwake: true,
  theme: 'system',
  hapticFeedbackEnabled: true,
  notifySessionInvites: true,
  notifyClimbComments: true,
  kioskHintSeen: false,
  bottomChromeDiagnostics: false,
};

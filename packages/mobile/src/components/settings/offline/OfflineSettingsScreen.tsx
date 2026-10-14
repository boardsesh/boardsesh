import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { buildOfflineModeRow } from '../../offline-mode-row';
import { useOfflineDatabase } from '../../../db/use-offline-database';
import { useOfflineSchemaReady } from '../../../db/use-offline-schema-ready';
import { track } from '../../../lib/analytics';
import { useConnectivity } from '../../../lib/connectivity/use-connectivity';
import { isOfflineModeSupported } from '../../../lib/connectivity/connectivity-store';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { isOfflineEngineEnabled } from '../../../lib/offline-engine';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useOutboxSummary } from '../../../offline/outbox-store';
import { useMissingOfflineBoards } from '../../../offline/use-keep-boards-offline';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';
import { useToast } from '../../../providers/toast-provider';
import { forgetDownloadAllTap, rememberDownloadAllTap, setSetting, useSetting } from '../../../settings';
import { makeAutoOfflineBoardsToggle } from './auto-offline-boards-toggle';
import { buildOfflineModel } from './offline-model';
import { useShowStorage } from './use-show-storage';

export function OfflineSettingsScreen() {
  const { t } = useTranslation('common');
  const { showToast } = useToast();
  // The whole offline surface is flag-gated. Storage is not (see useShowStorage).
  const offlineEnabled = useOfflineDownloadsEnabled();
  const showStorage = useShowStorage();
  // "Keep boards offline". Turning it on downloads every board already in My
  // Boards now (climbers chose this over a future-only default), and the
  // adopt-on-select flow downloads new boards from then on. The downloading
  // itself is `useKeepBoardsOffline`, mounted once by the settings layout; the
  // tap is `makeAutoOfflineBoardsToggle`.
  const [autoOfflineBoards] = useSetting('autoOfflineBoards');
  const missingOfflineBoards = useMissingOfflineBoards();
  const { effectiveOffline, offlineMode } = useConnectivity();
  // What is still sitting in the outbox. Gated on `schemaReady`: on a contended
  // launch the SQLite handle is handed out before the tables exist. Null until
  // then, which the summary reports as "nothing to say" rather than "nothing
  // pending".
  const db = useOfflineDatabase();
  const schemaReady = useOfflineSchemaReady();
  const outboxSummary = useOutboxSummary(schemaReady ? db : null);
  const pendingCount = outboxSummary?.pendingCount ?? 0;

  const onAutoOfflineBoardsToggle = useMemo(
    () =>
      makeAutoOfflineBoardsToggle({
        downloadingMessage: (boardCount) => t('mobile.settings.offline.downloadingAll', { count: boardCount }),
        setAutoOfflineBoards: (enabled) => setSetting('autoOfflineBoards', enabled),
        missingBoardCount: () => missingOfflineBoards().length,
        rememberDownloadAllTap,
        forgetDownloadAllTap,
        trackDownloadAllTapped: (properties) => track(SHARED_EVENTS.OfflineDownloadAllTapped, properties),
        isOfflineEngineEnabled,
        showToast: (message) => showToast(message, 'info'),
      }),
    [t, missingOfflineBoards, showToast],
  );

  const model = useMemo(
    () =>
      withSettingTracking(
        buildOfflineModel({
          t,
          offlineEnabled,
          // Native only: on Expo web there is no storage behind the switch and
          // `setOfflineMode` is inert, and a row that did nothing would be worse
          // than no row.
          offlineModeRow: isOfflineModeSupported() ? buildOfflineModeRow(t, offlineMode) : null,
          autoOfflineBoards,
          onAutoOfflineBoardsChange: (next) => {
            hapticSelection();
            onAutoOfflineBoardsToggle(next);
          },
          pendingCount,
          effectiveOffline,
          showStorage,
          onOpenStorage: () => {
            hapticLight();
            router.push('/settings/storage');
          },
        }),
        'offline',
      ),
    [
      t,
      offlineEnabled,
      offlineMode,
      autoOfflineBoards,
      onAutoOfflineBoardsToggle,
      pendingCount,
      effectiveOffline,
      showStorage,
    ],
  );

  return <MoreForm model={model} />;
}

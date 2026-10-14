import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { scopedRouter as router } from '../../../lib/routing/scoped-navigation';
import { MoreForm } from '../../MoreForm';
import { buildOfflineModeRow } from '../../offline-mode-row';
import { useOfflineDatabase } from '../../../db/use-offline-database';
import { useOfflineSchemaReady } from '../../../db/use-offline-schema-ready';
import { useTheme } from '../../../providers/theme-provider';
import { useLocalePreference } from '../../../providers/i18n-provider';
import { useToast } from '../../../providers/toast-provider';
import { useOfflineDownloadsEnabled } from '../../../providers/feature-flags-provider';
import { track } from '../../../lib/analytics';
import { useConnectivity } from '../../../lib/connectivity/use-connectivity';
import { isOfflineModeSupported } from '../../../lib/connectivity/connectivity-store';
import { resolveLanguage } from '../../../lib/i18n/locale-preference';
import { openExternalUrl } from '../../../lib/open-url';
import { hapticLight, hapticSelection } from '../../../lib/haptics';
import { reportError } from '../../../lib/error-reporting';
import { isOfflineEngineEnabled } from '../../../lib/offline-engine';
import { replayOnboarding } from '../../../lib/onboarding/onboarding-storage';
import { replayBoardLookStep } from '../../../lib/board-render/replay-board-look-step';
import { withSettingTracking } from '../../../lib/settings-analytics';
import { useOutboxSummary } from '../../../offline/outbox-store';
import { useMissingOfflineBoards } from '../../../offline/use-keep-boards-offline';
import { forgetDownloadAllTap, rememberDownloadAllTap, setSetting, useSetting } from '../../../settings';
import { makeAutoOfflineBoardsToggle } from '../offline/auto-offline-boards-toggle';
import { useShowStorage } from '../offline/use-show-storage';
import { buildGeneralModel } from './general-model';

// Translations live in the shared catalog at packages/shared/i18n/locales/<locale>/.
// We deep-link to the active language's folder so a community member lands on
// the exact files to edit.
const GITHUB_LOCALES_TREE_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';

export function GeneralSettingsScreen() {
  const { t } = useTranslation('common');
  const { themeOverride, setThemeOverride } = useTheme();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { showToast } = useToast();
  // 'system' resolves to the device locale, so the link opens the files for
  // whatever language the app is showing right now.
  const activeLocale = resolveLanguage(localePreference);
  // The Offline section. The switches are flag-gated; Storage is not (see
  // useShowStorage).
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

  const handleReplayWalkthrough = useCallback(() => {
    hapticLight();
    // Clear the "seen" flag BEFORE opening the tour (the await is inside
    // replayOnboarding). Ordering matters: if the replayed tour is finished or
    // skipped before the clear settles, markOnboardingSeen() could land first
    // and a late clear would wipe the flag, leaving the tour "unseen" and
    // re-showing on the next cold start.
    //
    // If the SecureStore clear rejects (keychain locked or unavailable),
    // replayOnboarding never navigates, so surface an error toast instead of the
    // row silently doing nothing. Log and report so a recurring failure shows.
    replayOnboarding(() => router.push('/onboarding')).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to replay walkthrough', error);
      reportError(error);
      showToast(t('mobile.onboarding.replayError'), 'error');
    });
  }, [showToast, t]);

  const handleReplayBoardLook = useCallback(() => {
    hapticLight();
    // Clears the "seen" flag AND puts the render mode back to `default`: the
    // gate skips anyone who has already chosen a mode, so clearing the flag
    // alone would leave the step just as invisible. Deliberately does not touch
    // the hold-colour store, unlike "Reset board look", so re-testing the step
    // costs a climber none of their accessibility setup.
    replayBoardLookStep(() => router.push({ pathname: '/onboarding', params: { step: 'board-look' } })).catch(
      (error: unknown) => {
        // eslint-disable-next-line no-console
        console.warn('[board-look] Failed to replay the board look step', error);
        reportError(error);
        showToast(t('mobile.onboarding.replayError'), 'error');
      },
    );
  }, [showToast, t]);

  const model = useMemo(
    () =>
      withSettingTracking(
        buildGeneralModel({
          t,
          appearance: themeOverride,
          onAppearanceChange: (appearance) => {
            hapticSelection();
            void setThemeOverride(appearance);
          },
          language: localePreference,
          onLanguageChange: (language) => {
            hapticSelection();
            setLocalePreference(language);
          },
          activeLocale,
          onHelpTranslate: () => {
            hapticLight();
            void openExternalUrl(`${GITHUB_LOCALES_TREE_URL}/${activeLocale}`, 'more-help-translate');
          },
          offline: {
            offlineEnabled,
            // Native only: on Expo web there is no storage behind the switch
            // and `setOfflineMode` is inert, and a row that did nothing would be
            // worse than no row.
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
          },
          onReplayWalkthrough: handleReplayWalkthrough,
          onReplayBoardLook: handleReplayBoardLook,
        }),
        'general',
      ),
    [
      t,
      themeOverride,
      setThemeOverride,
      localePreference,
      setLocalePreference,
      activeLocale,
      offlineEnabled,
      offlineMode,
      autoOfflineBoards,
      onAutoOfflineBoardsToggle,
      pendingCount,
      effectiveOffline,
      showStorage,
      handleReplayWalkthrough,
      handleReplayBoardLook,
    ],
  );

  return <MoreForm model={model} />;
}

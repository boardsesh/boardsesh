import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSQLiteContext } from 'expo-sqlite';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GradeDisplayFormat } from '@boardsesh/play-view';
import type { ThemeOverride } from '@boardsesh/key-value-storage';
import { SUPPORTED_LOCALES, LOCALE_LABELS } from '@boardsesh/i18n';
import { useTheme } from '../../../src/providers/theme-provider';
import { useLocalePreference } from '../../../src/providers/i18n-provider';
import { resolveLanguage, type LocaleOverride } from '../../../src/lib/i18n/locale-preference';
import { openExternalUrl } from '../../../src/lib/open-url';
import { useConfirmSignOut } from '../../../src/hooks/use-confirm-sign-out';
import { useProfile, useMyBoards, useIsAdmin } from '../../../src/lib/graphql/hooks';
import { useQaMenu } from '../../../src/lib/qa/use-qa-menu';
import { useBoardDownloads } from '../../../src/offline/use-board-downloads';
import { isOfflineEngineEnabled } from '../../../src/lib/offline-engine';
import { useOfflineSchemaReady } from '../../../src/db/use-offline-schema-ready';
import {
  useSetting,
  setSetting,
  getSetting,
  offlineBoardKeyForBoard,
  rememberDownloadAllTap,
  takeDownloadAllTap,
  forgetDownloadAllTap,
} from '../../../src/settings';
import { useIsOffline } from '../../../src/hooks/use-is-offline';
import { RECLAIMABLE_VISIBLE_BYTES } from '../../../src/db/storage-usage';
import {
  getDeadLetterCount,
  getDeadLetters,
  getOutboxSummary,
  retryDeadLetter,
  measureReclaimableBytes,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../../../src/offline/offline-sync-adapter';
import { useDownloadedScopeKeys } from '../../../src/offline/use-downloaded-scope-keys';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { hapticLight, hapticSelection } from '../../../src/lib/haptics';
import { getDevMetadataSection } from '../../../src/components/dev-metadata-section';
import { useBottomChromeDiagnosticsEligible } from '../../../src/components/BottomChromeDebugOverlay';
import { MoreForm } from '../../../src/components/MoreForm';
import type { MoreButtonRow, MoreFormModel, MoreRow, MoreSection } from '../../../src/components/MoreForm.types';
import { isPreviewBuild } from '../../../src/lib/preview-build';
import { isDevLauncherAvailable } from '../../../src/lib/dev-launcher';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useSessionRecordingPreference } from '../../../src/lib/session-recording-preference';
import { setSessionRecordingEnabled, track } from '../../../src/lib/analytics';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { useShowPlaylistTagsPreference } from '../../../src/lib/show-playlist-tags-preference';
import { useBoardseshGradesPreference } from '../../../src/lib/boardsesh-grades-preference';
import { useClimbQuickActionsButton } from '../../../src/lib/climb-quick-actions-button-preference';
import { useToast } from '../../../src/providers/toast-provider';
import {
  useFeatureFlag,
  useOfflineDownloadsEnabled,
  useBoardseshGradeEnabled,
} from '../../../src/providers/feature-flags-provider';
import { replayOnboarding } from '../../../src/lib/onboarding/onboarding-storage';
import { replayBoardLookStep } from '../../../src/lib/board-render/replay-board-look-step';
import { reportError, reportHandledError } from '../../../src/lib/error-reporting';
import { AUTO_DISCONNECT_TIMEOUT_OPTIONS } from '../../../src/lib/ble/auto-disconnect-controller';
import { useAutoDisconnectTimeoutLabels } from '../../../src/components/ble/use-auto-disconnect-timeout-labels';
import { useAuth } from '../../../src/providers/auth-provider';
import { useConfirm } from '../../../src/providers/dialog-provider';
import { setAccountWorkOffline } from '../../../src/lib/network-policy';
import { createLocalProfileBackupFile, restoreLocalProfileBackupFile } from '../../../src/lib/local-profile-backup';
import { transitionWorkOffline } from '../../../src/lib/work-offline-transition';

// Translations live in the shared catalog at packages/shared/i18n/locales/<locale>/.
// We deep-link to the active language's folder so a community member lands on the
// exact files to edit.
const GITHUB_LOCALES_TREE_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';

// The shared route screen for the "More" tab. It owns every hook, route guard, and
// conditional (auth / tester / dev / preview-build), resolves all copy through the
// i18n catalogs and all haptics, then builds a plain view-model and hands rendering
// to the platform-split <MoreForm /> — a native SwiftUI Form on iOS, a Compose
// LazyColumn on Android. The native tree renders strings + invokes handlers only.
export default function MoreScreen() {
  const { accessCapabilities } = useAuth();
  return accessCapabilities.useAccountFeatures ? <AccountMoreScreen /> : <LocalMoreScreen />;
}

function LocalMoreScreen() {
  const { isAuthenticated, prepareAccountAuthentication } = useAuth();
  const db = useSQLiteContext();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [backupInProgress, setBackupInProgress] = useState(false);
  const [restoreInProgress, setRestoreInProgress] = useState(false);
  const { themeOverride, setThemeOverride } = useTheme();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  const { t } = useTranslation('common');
  const { t: tProfile } = useTranslation('profile');
  const { t: tPlaylists } = useTranslation('playlists');

  const appearanceOptions: { key: ThemeOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.appearance.system') },
    { key: 'light', label: t('mobile.more.appearance.light') },
    { key: 'dark', label: t('mobile.more.appearance.dark') },
  ];
  const gradeFormatOptions: { key: GradeDisplayFormat; label: string }[] = [
    { key: 'v-grade', label: t('mobile.more.gradeFormat.vGrade') },
    { key: 'font', label: t('mobile.more.gradeFormat.font') },
    { key: 'both', label: t('mobile.more.gradeFormat.both') },
  ];
  const languageOptions: { key: LocaleOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ key: locale, label: LOCALE_LABELS[locale] })),
  ];

  const handleUseAccount = async (): Promise<void> => {
    try {
      await prepareAccountAuthentication();
      router.replace(isAuthenticated ? '/(tabs)/home' : '/auth/login');
    } catch (error) {
      reportHandledError(error, { tags: { source: 'access-mode', mode: 'account' } });
      showToast(tProfile('mobile.local.accountSwitchFailed'), 'error');
    }
  };

  const handleLocalBackup = async (): Promise<void> => {
    if (backupInProgress) return;
    setBackupInProgress(true);
    try {
      const backup = await createLocalProfileBackupFile(db);
      if (backup === null) return;
      showToast(
        t('mobile.more.offline.backupComplete', { fileName: backup.fileName, tickCount: backup.ticks }),
        'success',
      );
    } catch (error) {
      reportHandledError(error, { tags: { source: 'local-profile-backup', kind: 'provider-write' } });
      showToast(t('mobile.more.offline.backupFailed'), 'error');
    } finally {
      setBackupInProgress(false);
    }
  };

  const handleLocalRestore = async (): Promise<void> => {
    if (restoreInProgress) return;
    const approved = await confirm({
      title: t('mobile.more.offline.restoreConfirmTitle'),
      message: t('mobile.more.offline.restoreConfirmMessage'),
      confirmLabel: t('mobile.more.offline.restoreConfirm'),
      cancelLabel: t('mobile.more.offline.restoreCancel'),
    });
    if (!approved) return;

    setRestoreInProgress(true);
    try {
      const restored = await restoreLocalProfileBackupFile(db);
      if (restored === null) return;
      // Board React remembers which climb UUIDs it already loaded outside the
      // query payload; removal resets that coverage index after imported ticks.
      queryClient.removeQueries({ queryKey: ['logbook'] });
      await queryClient.invalidateQueries();
      showToast(t('mobile.more.offline.restoreComplete', { tickCount: restored.ticks }), 'success');
    } catch (error) {
      reportHandledError(error, { tags: { source: 'local-profile-backup', kind: 'provider-restore' } });
      showToast(t('mobile.more.offline.restoreFailed'), 'error');
    } finally {
      setRestoreInProgress(false);
    }
  };

  const model: MoreFormModel = {
    sections: [
      {
        key: 'localProfile',
        title: tProfile('mobile.local.moreTitle'),
        footer: tProfile('mobile.local.moreDescription'),
        rows: [
          {
            kind: 'button',
            key: 'useAccount',
            label: tProfile('mobile.local.useAccount'),
            onPress: () => void handleUseAccount(),
          },
        ],
      },
      {
        key: 'localBackup',
        title: t('mobile.more.offline.backupTitle'),
        footer: t('mobile.more.offline.backupDescription'),
        rows: [
          {
            kind: 'button',
            key: 'backupLocalProfile',
            label: backupInProgress ? t('mobile.more.offline.backingUp') : t('mobile.more.offline.backupNow'),
            onPress: () => void handleLocalBackup(),
          },
          {
            kind: 'button',
            key: 'restoreLocalProfile',
            label: restoreInProgress ? t('mobile.more.offline.restoring') : t('mobile.more.offline.restoreBackup'),
            onPress: () => void handleLocalRestore(),
          },
        ],
      },
      {
        key: 'localLibrary',
        title: t('mobile.more.library'),
        rows: [
          {
            kind: 'nav',
            key: 'allPlaylists',
            label: tPlaylists('library.allPlaylists.title'),
            icon: 'playlists',
            onPress: () => router.push('/(tabs)/discover/all'),
          },
        ],
      },
      {
        key: 'appearance',
        title: t('mobile.more.appearance.title'),
        rows: [
          {
            kind: 'segmented',
            key: 'appearance',
            label: t('mobile.more.appearance.title'),
            options: appearanceOptions,
            selectedKey: themeOverride,
            onSelect: (key) => {
              const next = appearanceOptions.find((option) => option.key === key);
              if (next) void setThemeOverride(next.key);
            },
          },
        ],
      },
      {
        key: 'gradeFormat',
        title: t('mobile.more.gradeFormat.title'),
        footer: t('mobile.more.gradeFormat.description'),
        rows: [
          {
            kind: 'segmented',
            key: 'gradeFormat',
            label: t('mobile.more.gradeFormat.title'),
            options: gradeFormatOptions,
            selectedKey: gradeFormat,
            onSelect: (key) => {
              const next = gradeFormatOptions.find((option) => option.key === key);
              if (next) setGradeFormat(next.key);
            },
          },
        ],
      },
      {
        key: 'language',
        title: t('mobile.more.language.title'),
        footer: t('mobile.more.language.description'),
        rows: [
          {
            kind: 'select',
            key: 'language',
            label: t('mobile.more.language.title'),
            options: languageOptions,
            selectedKey: localePreference,
            onSelect: (key) => {
              const next = languageOptions.find((option) => option.key === key);
              if (next) setLocalePreference(next.key);
            },
          },
        ],
      },
    ],
  };

  return <MoreForm model={model} />;
}

function AccountMoreScreen() {
  const { accessCapabilities } = useAuth();
  const confirm = useConfirm();
  const { themeOverride, setThemeOverride } = useTheme();
  const { t } = useTranslation('common');
  const { t: tProfile } = useTranslation('profile');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSettings } = useTranslation('settings');
  const { t: tBoards } = useTranslation('boards');
  const { t: tNotifications } = useTranslation('notifications');
  const confirmSignOut = useConfirmSignOut();
  const { data: profile } = useProfile({ enabled: accessCapabilities.useAccountFeatures });
  // Its own query, deliberately not a field on the profile document — see
  // useIsAdmin. Fails closed, so an older backend just hides the admin rows.
  const { isAdmin } = useIsAdmin();
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();
  const bottomChromeDiagnosticsEligible = useBottomChromeDiagnosticsEligible();
  const [bottomChromeDiagnostics, setBottomChromeDiagnostics] = useSetting('bottomChromeDiagnostics');
  const { enabled: showPlaylistTags, setEnabled: setShowPlaylistTags } = useShowPlaylistTagsPreference();
  const { enabled: showBoardseshGrades, setEnabled: setShowBoardseshGrades } = useBoardseshGradesPreference();
  const { enabled: showQuickActionsButton, setEnabled: setShowQuickActionsButton } = useClimbQuickActionsButton();
  const boardseshGradeFlagEnabled = useBoardseshGradeEnabled();
  const { showToast } = useToast();
  const stravaEnabled = useFeatureFlag('strava-integration') === true;
  // Off until the Connect IQ watch app ships — nothing to pair to before then.
  const garminWatchEnabled = useFeatureFlag('garmin-watch') === true;
  const offlineEnabled = useOfflineDownloadsEnabled();

  // "Keep boards offline by default" toggle. Turning it on downloads every board
  // already in My Boards now (user chose this over a future-only default), and the
  // adopt-on-select flow auto-downloads new boards from then on.
  const [autoOfflineBoards] = useSetting('autoOfflineBoards');
  const [workOffline, setWorkOffline] = useSetting('workOffline');
  const [autoDisconnectBle, setAutoDisconnectBle] = useSetting('autoDisconnectBle');
  const [autoDisconnectTimeoutSeconds, setAutoDisconnectTimeoutSeconds] = useSetting('autoDisconnectTimeoutSeconds');
  const [lightOnSwipe, setLightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap, setLightOnClimbTap] = useSetting('lightOnClimbTap');
  const autoDisconnectTimeoutLabels = useAutoDisconnectTimeoutLabels();
  const { enableBoardsOffline, syncNow } = useBoardDownloads();
  const { data: myBoardsConnection } = useMyBoards(undefined, { enabled: offlineEnabled && !!profile });
  // Memoized so the empty-while-loading fallback keeps a stable identity — the
  // offline effect below depends on this array and shouldn't re-run every render.
  const myBoards = useMemo(() => myBoardsConnection?.boards ?? [], [myBoardsConnection]);

  // Boards in My Boards not yet opted into offline (single source of truth for both
  // the effect that enables them and the toast that reports the count).
  const missingOfflineBoards = useCallback(() => {
    const enabled = new Set(getSetting('syncEnabledBoards'));
    return myBoards.filter((board) => !enabled.has(offlineBoardKeyForBoard(board)));
  }, [myBoards]);

  // With the default on, keep every board offline. Runs on mount and once My Boards
  // resolves, so flipping the toggle before the list loaded still downloads
  // everything. Only enables boards not already opted in, so once they're all in
  // it's a no-op — no repeated sync kicks.
  // A deliberate tap on the switch below hands this effect its attribution
  // (issue #4316). Without the handoff every enable here would look automatic —
  // the effect is also what runs on a plain app launch with the setting already
  // on, and #4318's discovery work is measured against the deliberate half.
  //
  // The handoff is PERSISTED, not a ref. The tap can land before `useMyBoards`
  // resolves, and this effect bails while the list is empty, so a ref would drop
  // the attribution whenever the climber leaves the screen (or the app) in that
  // window — and the enable that eventually ran would be filed as automatic,
  // which is the one thing the split must not get wrong.
  useEffect(() => {
    if (!offlineEnabled || !autoOfflineBoards || myBoards.length === 0) return;
    const missing = missingOfflineBoards();
    if (missing.length === 0) {
      // A tap with nothing left to enable is fully handled here. Leaving the
      // flag armed would let the next automatic re-enable on this screen (a
      // board followed minutes later, say) inherit a `download-all` attribution
      // for a tap that had already been spent.
      forgetDownloadAllTap();
      return;
    }
    const fromTap = takeDownloadAllTap();
    enableBoardsOffline(missing, {
      trigger: fromTap ? 'download-all' : 'auto-download-all',
      source: 'more',
    });
  }, [offlineEnabled, autoOfflineBoards, myBoards, missingOfflineBoards, enableBoardsOffline]);

  // Offline sync-issues surface. Poll the dead-letter count only while online (the
  // section is hidden offline — a pending write offline is expected, not a "stuck"
  // problem). A dead-lettered write is one the server rejected or that failed past
  // its retry budget while reachable: worth surfacing with a retry (never a discard).
  const db = useSQLiteContext();
  // Handed out as soon as the launch gate opens — after the first init attempt,
  // whatever it did — so on a contended launch it has no tables yet. Both reads
  // below fold readiness into their KEY rather than gating on it: a failed read
  // renders the existing empty state (the right answer), and a late flip refetches,
  // whereas gating would spin forever whenever init genuinely fails.
  const schemaReady = useOfflineSchemaReady();
  const queryClient = useQueryClient();
  const isOffline = useIsOffline();
  const { data: deadLetterCount = 0, refetch: refetchDeadLetters } = useQuery({
    queryKey: ['deadLetters', 'count', schemaReady],
    queryFn: () => getDeadLetterCount(db),
    enabled: !isOffline,
    // Dead letters are sticky (they don't resolve without a user Retry), so a slow
    // poll is plenty — no need to wake every 5s. With the offline flag off there
    // is still ONE initial fetch (never a recurring poll): legacy dead letters
    // queued while the flag was on must stay reachable via Retry.
    refetchInterval: offlineEnabled ? 30000 : false,
  });

  // Whether to offer the Storage screen: the offline engine is on, OR this device is
  // still holding downloaded boards from before (a kill-switch rollback, or a
  // sign-out — which clears syncEnabledBoards but deliberately keeps the rows as the
  // shared cache). One cheap indexed read, same cost shape as the dead-letter count.
  // Shares the ['downloadedScopeKeys'] cache entry with My Boards, so this warms it.
  const { data: downloadedScopeKeys } = useDownloadedScopeKeys();
  // ...AND when a removal deleted its rows but the compaction never landed, so the
  // freelist is still holding real space. That state clears the scope-complete
  // markers (so downloadedScopeKeys is empty) and can coincide with the flag being
  // off — which would hide the one screen that can reclaim it. Two O(1) pragmas.
  const { data: reclaimableBytes = 0 } = useQuery({
    queryKey: ['offlineReclaimableBytes'],
    queryFn: () => measureReclaimableBytes(db),
  });
  const showStorage =
    offlineEnabled || (downloadedScopeKeys?.length ?? 0) > 0 || reclaimableBytes >= RECLAIMABLE_VISIBLE_BYTES;

  // Guard against a rapid double-tap spawning overlapping retries (the drain is
  // single-flight internally, but this avoids the wasted re-entrant work).
  const retryingRef = useRef(false);
  const handleRetrySync = async () => {
    if (retryingRef.current) return;
    retryingRef.current = true;
    try {
      const deadLetters = await getDeadLetters(db);
      // Reset each dead letter independently — a single bad entry must not stop the
      // rest from being retried (a shared try would abort the loop on first throw).
      for (const deadLetter of deadLetters) {
        try {
          await retryDeadLetter(db, deadLetter.id);
        } catch (error) {
          reportError(error);
        }
      }
      const graphqlFetch: GraphQLFetch = (query, variables) => getHttpClient().request(query, variables);
      await drainMutationQueue(db, queryClient, graphqlFetch);
    } catch (error) {
      reportError(error);
    } finally {
      retryingRef.current = false;
      void refetchDeadLetters();
    }
  };

  const handleWorkOfflineChange = async (next: boolean): Promise<void> => {
    hapticSelection();
    try {
      await transitionWorkOffline(next, {
        readOutboxSummary: () => getOutboxSummary(db),
        confirmGoingOnline: ({ pendingCount, deadLetterCount }) =>
          confirm({
            title: t('mobile.more.offline.goOnlineTitle'),
            message: t('mobile.more.offline.goOnlineMessage', { pendingCount, deadLetterCount }),
            confirmLabel: t('mobile.more.offline.goOnlineConfirm'),
            cancelLabel: t('mobile.more.offline.goOnlineCancel'),
          }),
        persist: setWorkOffline,
        applyNetworkPolicy: setAccountWorkOffline,
        syncNow,
        onSummaryError: (error) =>
          reportHandledError(error, { tags: { source: 'work-offline', kind: 'outbox-summary' } }),
      });
    } catch (error) {
      reportHandledError(error, { tags: { source: 'work-offline', kind: 'transition' } });
      showToast(t('mobile.more.offline.toggleFailed'), 'error');
    }
  };

  // Live Metro dev-server switching needs expo-dev-client's native launcher, which
  // is only linked into dev-client / Debug builds — never the App Store / TestFlight
  // binary (where it would throw "Dev launcher unavailable"). Show the row only where
  // it can actually work.
  const showDevServerSwitcher = isDevLauncherAvailable();

  // Feature-flag overrides work in every build (dev forces them in place of the
  // disabled PostHog read; release builds layer them on top), so show the entry
  // wherever the dev section is allowed — for testers and in dev.
  const showFeatureFlags = __DEV__ || Boolean(profile?.isTester);

  // The offline-write harness (hold a real SQLite write lock, inject fault
  // shapes, inspect the outbox). Same audience as the flag overrides.
  const showOfflineWrites = __DEV__ || Boolean(profile?.isTester);

  // The hold-outline editor rewrites the silhouettes every climber's board
  // renders, so it's admin-only rather than tester-only. `isAdmin` rides its own
  // small query (useIsAdmin) which fails closed, so a backend that predates the
  // field simply doesn't show the row.
  const showOutlineEditor = __DEV__ || isAdmin;

  // PR previews (docs/crowdsourced-qa-mobile.md). Its own section rather than a
  // Development row: the picker is open to every user, while Development is
  // tester/admin-only. `show` is the binary's ability to surf, so a build that
  // cannot load a preview still hides it.
  const { show: showQaPreviews, prNumber: qaPrNumber } = useQaMenu();

  // Don't render an empty "Development" section header when no tool applies.
  // Store-build previews now use xprem's everyone-facing blue edge marker, so
  // the retired OTA channel switcher is no longer listed here.
  const showDevSection =
    (__DEV__ || Boolean(profile?.isTester) || isAdmin) &&
    (showDevServerSwitcher || showFeatureFlags || showOfflineWrites || showOutlineEditor);

  // 'System' follows the device language; the rest are the supported locales,
  // labelled in their own script (English / Español / Français) from
  // LOCALE_LABELS — language names are intentionally not translated.
  const languageOptions: { key: LocaleOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.language.system') },
    ...SUPPORTED_LOCALES.map((locale) => ({ key: locale, label: LOCALE_LABELS[locale] })),
  ];

  // The community keeps the es/fr translations current; deep-link the CTA to the
  // folder for whatever language the app is currently showing ('system' resolves
  // to the device locale).
  const activeLocale = resolveLanguage(localePreference);
  const handleHelpTranslate = () => {
    void openExternalUrl(`${GITHUB_LOCALES_TREE_URL}/${activeLocale}`, 'more-help-translate');
  };

  const appearanceOptions: { key: ThemeOverride; label: string }[] = [
    { key: 'system', label: t('mobile.more.appearance.system') },
    { key: 'light', label: t('mobile.more.appearance.light') },
    { key: 'dark', label: t('mobile.more.appearance.dark') },
  ];

  const gradeFormatOptions: { key: GradeDisplayFormat; label: string }[] = [
    { key: 'v-grade', label: t('mobile.more.gradeFormat.vGrade') },
    { key: 'font', label: t('mobile.more.gradeFormat.font') },
    { key: 'both', label: t('mobile.more.gradeFormat.both') },
  ];

  const handleReplayWalkthrough = () => {
    // Clear the "seen" flag BEFORE opening the tour (the await is inside
    // replayOnboarding). Ordering matters: if the replayed tour is
    // finished/skipped before the clear settles, markOnboardingSeen() could land
    // first and a late clear would wipe the flag — leaving the tour "unseen" and
    // re-showing on the next cold start.
    //
    // If the SecureStore clear rejects (keychain locked / unavailable),
    // replayOnboarding never navigates, so surface an error toast instead of the
    // row silently doing nothing. Log + report so we notice a recurring failure.
    replayOnboarding(() => router.push('/onboarding')).catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.warn('[onboarding] Failed to replay walkthrough', error);
      reportError(error);
      showToast(t('mobile.onboarding.replayError'), 'error');
    });
  };

  const handleReplayBoardLook = () => {
    // Clears the "seen" flag AND puts the render mode back to `default` — the
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
  };

  // Wrap a navigation action with the light haptic the old ListRow fired on press.
  const navAction = (action: () => void) => () => {
    hapticLight();
    action();
  };

  // Account action buttons — destructive, no haptic. Sign Out is the primary
  // action (full-strength red); Delete Account is the quieter, secondary
  // affordance (`emphasis: 'subtle'`) so the two don't read as equal heavy red
  // blocks. Shared between the signed-in and signed-out section layouts.
  const accountActionRows: MoreButtonRow[] = [
    {
      kind: 'button',
      key: 'signOut',
      label: tProfile('mobile.signOut'),
      role: 'destructive',
      emphasis: 'primary',
      onPress: () => {
        // The warning + the wipe both live in the hook, shared with the user
        // drawer's Log out row so the two can't drift apart (issue #3621).
        void confirmSignOut();
      },
    },
    {
      kind: 'button',
      key: 'deleteAccount',
      label: tSettings('deleteAccount.button'),
      role: 'destructive',
      emphasis: 'subtle',
      onPress: () => router.push('/(tabs)/profile/delete-account'),
    },
  ];

  const sections: MoreSection[] = [];
  const devMetadataSection = useMemo(() => getDevMetadataSection(), []);
  if (devMetadataSection) {
    sections.push(devMetadataSection);
  }

  // Sync issues — surfaced high and only when online with writes stuck failing, so
  // it's noticeable when it matters and invisible otherwise. Retry only; there is no
  // discard — an unsynced write is never thrown away, it waits and re-sends.
  if (!isOffline && deadLetterCount > 0) {
    sections.push({
      key: 'syncIssues',
      title: t('mobile.more.syncIssues.title'),
      footer: t('mobile.more.syncIssues.description', { count: deadLetterCount }),
      rows: [
        {
          kind: 'button',
          key: 'retrySync',
          label: t('mobile.more.syncIssues.retry'),
          emphasis: 'primary',
          onPress: () => {
            hapticLight();
            void handleRetrySync();
          },
        },
      ],
    });
  }

  // Library — only when signed in (all-playlists is a profile feature). "My gyms"
  // rides here too: it's the owner's home for the gyms they run, and only makes
  // sense signed in (the `myGyms` query scopes to the caller).
  if (profile?.id) {
    sections.push({
      key: 'library',
      title: t('mobile.more.library'),
      rows: [
        {
          // The You tab's way in to notifications, and the only entry point for
          // `(tabs)/profile/notifications` — the Home chrome's bell pushes Home's
          // own copy of the screen so Back lands on the feed. Without this row the
          // profile route ships registered but unreachable.
          kind: 'nav',
          key: 'notifications',
          label: tNotifications('title'),
          icon: 'notifications',
          onPress: navAction(() => router.push('/(tabs)/profile/notifications')),
        },
        {
          kind: 'nav',
          key: 'allPlaylists',
          label: tPlaylists('library.allPlaylists.title'),
          icon: 'playlists',
          onPress: navAction(() => router.push('/(tabs)/discover/all')),
        },
        {
          kind: 'nav',
          key: 'myGyms',
          label: tBoards('mobile.myGyms.moreRowTitle'),
          subtitle: tBoards('mobile.myGyms.moreRowSubtitle'),
          icon: 'gyms',
          onPress: navAction(() => router.push('/gyms/mine')),
        },
      ],
    });
  }

  // Integrations.
  sections.push({
    key: 'integrations',
    title: t('mobile.more.integrations.title'),
    rows: [
      {
        kind: 'nav',
        key: 'integrations',
        label: t('mobile.more.integrations.title'),
        subtitle: t(
          stravaEnabled ? 'mobile.more.integrations.subtitleWithStrava' : 'mobile.more.integrations.subtitle',
        ),
        icon: 'integrations',
        onPress: navAction(() => router.push('/(tabs)/profile/integrations')),
      },
      ...(garminWatchEnabled
        ? [
            {
              kind: 'nav' as const,
              key: 'pairWatch',
              label: tSettings('watchPairing.title'),
              subtitle: tSettings('watchPairing.subtitle'),
              icon: 'watch' as const,
              onPress: navAction(() => router.push('/(tabs)/profile/watch-pair')),
            },
          ]
        : []),
    ],
  });

  // Appearance (segmented).
  sections.push({
    key: 'appearance',
    title: t('mobile.more.appearance.title'),
    rows: [
      {
        kind: 'segmented',
        key: 'appearance',
        label: t('mobile.more.appearance.title'),
        options: appearanceOptions,
        selectedKey: themeOverride,
        onSelect: (key) => {
          const next = appearanceOptions.find((option) => option.key === key);
          if (next) {
            hapticSelection();
            void setThemeOverride(next.key);
          }
        },
      },
    ],
  });

  // Grade Format (segmented) — description as the section footer.
  sections.push({
    key: 'gradeFormat',
    title: t('mobile.more.gradeFormat.title'),
    footer: t('mobile.more.gradeFormat.description'),
    rows: [
      {
        kind: 'segmented',
        key: 'gradeFormat',
        label: t('mobile.more.gradeFormat.title'),
        options: gradeFormatOptions,
        selectedKey: gradeFormat,
        onSelect: (key) => {
          const next = gradeFormatOptions.find((option) => option.key === key);
          if (next) {
            hapticSelection();
            setGradeFormat(next.key);
          }
        },
      },
    ],
  });

  // Display options — show playlist tags toggle, plus the Boardsesh grades
  // toggle when the `boardsesh-grade` flag is on (the row itself is the
  // opt-in; the flag gates whether it's offered at all).
  sections.push({
    key: 'displayOptions',
    title: t('mobile.more.displayOptions.title'),
    rows: [
      {
        kind: 'toggle',
        key: 'playlistTags',
        label: t('mobile.more.displayOptions.playlistTags'),
        subtitle: t('mobile.more.displayOptions.playlistTagsDescription'),
        value: showPlaylistTags,
        onValueChange: (next) => {
          hapticSelection();
          setShowPlaylistTags(next);
        },
      },
      {
        kind: 'toggle',
        key: 'quickActionsButton',
        label: t('mobile.more.displayOptions.quickActionsButton'),
        subtitle: t('mobile.more.displayOptions.quickActionsButtonDescription'),
        value: showQuickActionsButton,
        onValueChange: (next) => {
          hapticSelection();
          track(SHARED_EVENTS.ClimbQuickActionsSettingChanged, { enabled: next });
          setShowQuickActionsButton(next);
        },
      },
      ...(boardseshGradeFlagEnabled
        ? [
            {
              kind: 'toggle' as const,
              key: 'boardseshGrades',
              label: t('mobile.more.displayOptions.boardseshGrades'),
              subtitle: t('mobile.more.displayOptions.boardseshGradesDescription'),
              value: showBoardseshGrades,
              onValueChange: (next: boolean) => {
                hapticSelection();
                setShowBoardseshGrades(next);
              },
            },
          ]
        : []),
    ],
  });

  const autoDisconnectTimeoutOptions = AUTO_DISCONNECT_TIMEOUT_OPTIONS.map((seconds) => ({
    key: String(seconds),
    label: autoDisconnectTimeoutLabels[seconds],
  }));

  sections.push({
    key: 'bluetooth',
    title: tSettings('ble.autoDisconnect.title'),
    footer: tSettings('ble.autoDisconnect.description'),
    rows: [
      {
        kind: 'toggle',
        key: 'autoDisconnectBle',
        label: tSettings('ble.autoDisconnect.enabledLabel'),
        subtitle: tSettings('ble.autoDisconnect.enabledDescription'),
        value: autoDisconnectBle,
        onValueChange: (next) => {
          hapticSelection();
          setAutoDisconnectBle(next);
        },
      },
      {
        kind: 'select',
        key: 'autoDisconnectTimeoutSeconds',
        label: tSettings('ble.autoDisconnect.timeoutLabel'),
        options: autoDisconnectTimeoutOptions,
        selectedKey: String(autoDisconnectTimeoutSeconds),
        onSelect: (key) => {
          const seconds = Number(key);
          if (AUTO_DISCONNECT_TIMEOUT_OPTIONS.includes(seconds as (typeof AUTO_DISCONNECT_TIMEOUT_OPTIONS)[number])) {
            hapticSelection();
            setAutoDisconnectTimeoutSeconds(seconds);
          }
        },
      },
    ],
  });

  sections.push({
    key: 'ble-lighting',
    title: tSettings('ble.lighting.title'),
    footer: tSettings('ble.lighting.description'),
    rows: [
      {
        kind: 'toggle',
        key: 'lightOnSwipe',
        label: tSettings('ble.lighting.onSwipeLabel'),
        subtitle: tSettings('ble.lighting.onSwipeDescription'),
        value: lightOnSwipe,
        onValueChange: (next) => {
          hapticSelection();
          setLightOnSwipe(next);
        },
      },
      {
        kind: 'toggle',
        key: 'lightOnClimbTap',
        label: tSettings('ble.lighting.onTapLabel'),
        subtitle: tSettings('ble.lighting.onTapDescription'),
        value: lightOnClimbTap,
        onValueChange: (next) => {
          hapticSelection();
          setLightOnClimbTap(next);
        },
      },
    ],
  });

  // Offline — keep boards available with no signal. Gated by the offline feature
  // flag (the whole offline surface is flag-gated). Turning it on downloads every
  // current board now; future boards auto-download via the adopt-on-select flow.
  sections.push({
    key: 'offline',
    title: t('mobile.more.offline.title'),
    rows: [
      {
        kind: 'toggle',
        key: 'workOffline',
        label: t('mobile.more.offline.workOffline'),
        subtitle: t('mobile.more.offline.workOfflineDescription'),
        value: workOffline,
        onValueChange: (next) => {
          void handleWorkOfflineChange(next);
        },
      },
      ...(offlineEnabled
        ? [
            {
              kind: 'toggle' as const,
              key: 'autoOfflineBoards',
              label: t('mobile.more.offline.autoDownload'),
              subtitle: t('mobile.more.offline.autoDownloadDescription'),
              value: autoOfflineBoards,
              onValueChange: (next: boolean) => {
                hapticSelection();
                // The effect above does the enabling + download (robust to a not-yet-
                // loaded list); here we just persist and surface how many will pull down.
                setSetting('autoOfflineBoards', next);
                if (next) {
                  const missing = missingOfflineBoards();
                  // Fired HERE, on the real tap, and once per tap rather than once
                  // per board. The effect above is a mount-time reaction to the
                  // persisted setting, so firing a "…Tapped" event from it would
                  // assert a tap that never happened.
                  rememberDownloadAllTap();
                  track(SHARED_EVENTS.OfflineDownloadAllTapped, {
                    boardCount: missing.length,
                    offlineEngineEnabled: isOfflineEngineEnabled(),
                  });
                  if (missing.length > 0) {
                    showToast(t('mobile.more.offline.downloadingAll', { count: missing.length }), 'info');
                  }
                } else {
                  // Switched back off before the list ever resolved: the tap is spent,
                  // and leaving it armed would attribute a later automatic enable to it.
                  forgetDownloadAllTap();
                }
              },
            },
          ]
        : []),
    ],
  });

  // Board look (nav) — render mode + every Boardsesh knob, plus the
  // accessibility controls (hold colours, marker shapes, colour-vision check)
  // the old Accessibility row used to open on their own (issue #2202).
  sections.push({
    key: 'boardLook',
    title: t('mobile.more.boardLook.title'),
    rows: [
      {
        kind: 'nav',
        key: 'boardLook',
        label: t('mobile.more.boardLook.title'),
        subtitle: t('mobile.more.boardLook.rowSubtitleShort'),
        icon: 'boardLook',
        onPress: navAction(() => router.push('/(tabs)/profile/board-look')),
      },
    ],
  });

  // Language — a menu-style select; description as the section footer. The
  // picker's own label carries the word "Language", so no section title.
  sections.push({
    key: 'language',
    footer: t('mobile.more.language.description'),
    rows: [
      {
        kind: 'select',
        key: 'language',
        label: t('mobile.more.language.title'),
        options: languageOptions,
        selectedKey: localePreference,
        onSelect: (key) => {
          const next = languageOptions.find((option) => option.key === key);
          if (next) {
            hapticSelection();
            setLocalePreference(next.key);
          }
        },
      },
    ],
  });

  // Help translate — its own card under the language footnote.
  sections.push({
    key: 'languageContribute',
    rows: [
      {
        kind: 'nav',
        key: 'helpTranslate',
        label: t('mobile.more.language.contributeTitle'),
        subtitle: t('mobile.more.language.contributeSubtitle', { language: LOCALE_LABELS[activeLocale] }),
        icon: 'translate',
        onPress: navAction(handleHelpTranslate),
      },
    ],
  });

  // Storage (nav) — what the offline downloads occupy, and how to get it back.
  //
  // Deliberately NOT gated on the offline flag alone. That flag is a kill switch: a
  // user who downloaded gigabytes while it was on and then got rolled back would
  // otherwise have no way to reclaim them, which is the very gap this screen exists
  // to close. Same reasoning as the sign-out pending-count read above.
  if (showStorage) {
    sections.push({
      key: 'storage',
      title: t('mobile.more.storage.title'),
      rows: [
        {
          kind: 'nav',
          key: 'storage',
          label: t('mobile.more.storage.rowLabel'),
          subtitle: t('mobile.more.storage.rowSubtitle'),
          icon: 'storage',
          onPress: navAction(() => router.push('/(tabs)/profile/storage')),
        },
      ],
    });
  }

  // Diagnostics — Session Recording toggle. Persist + apply live.
  if (accessCapabilities.useAccountFeatures)
    sections.push({
      key: 'diagnostics',
      title: t('mobile.more.diagnostics.title'),
      rows: [
        {
          kind: 'toggle',
          key: 'sessionRecording',
          label: t('mobile.more.diagnostics.recording'),
          subtitle: t('mobile.more.diagnostics.recordingDescription'),
          value: sessionRecordingEnabled,
          onValueChange: (next) => {
            hapticSelection();
            setSessionRecordingPreference(next);
            setSessionRecordingEnabled(next);
          },
        },
        // Bottom-chrome geometry overlay — dev / preview builds / pr-channel OTA
        // testers only, so regular production users never see the row.
        ...(bottomChromeDiagnosticsEligible
          ? [
              {
                kind: 'toggle' as const,
                key: 'bottomChromeDiagnostics',
                // i18n-ignore-next-line — tester-only diagnostics
                label: 'Bottom chrome diagnostics',
                // i18n-ignore-next-line
                subtitle: 'Overlay live tab-bar geometry values',
                value: bottomChromeDiagnostics,
                onValueChange: (next: boolean) => {
                  hapticSelection();
                  setBottomChromeDiagnostics(next);
                },
              },
            ]
          : []),
      ],
    });

  // Replay walkthrough (nav).
  sections.push({
    key: 'replay',
    title: t('mobile.onboarding.replaySection'),
    rows: [
      {
        kind: 'nav',
        key: 'replay',
        label: t('mobile.onboarding.replayTitle'),
        subtitle: t('mobile.onboarding.replaySubtitle'),
        icon: 'replay',
        onPress: navAction(handleReplayWalkthrough),
      },
      {
        kind: 'nav',
        key: 'replay-board-look',
        label: t('mobile.more.boardLook.intro.replayTitle'),
        subtitle: t('mobile.more.boardLook.intro.replaySubtitle'),
        icon: 'replay',
        onPress: navAction(handleReplayBoardLook),
      },
    ],
  });

  // PR previews — the everyone-facing entry into the crowdsourced-QA flow. The
  // screen is also where "Previews are switched off" / "Nothing to test right
  // now" gets SAID, so the row stays put when the list is empty: a hidden button
  // and an empty list look identical from the outside, and that is exactly the
  // confusion this row exists to end.
  if (showQaPreviews) {
    sections.push({
      key: 'previews',
      title: t('mobile.more.previews.title'),
      rows: [
        qaPrNumber !== null
          ? {
              kind: 'nav',
              key: 'qaBrief',
              label: t('mobile.more.previews.testPlanTitle', { prNumber: qaPrNumber }),
              subtitle: t('mobile.more.previews.testPlanSubtitle'),
              icon: 'branchSwitcher',
              onPress: navAction(() => router.push('/qa/brief')),
            }
          : {
              kind: 'nav',
              key: 'qaPick',
              label: t('mobile.more.previews.pickTitle'),
              subtitle: t('mobile.more.previews.pickSubtitle'),
              icon: 'branchSwitcher',
              onPress: navAction(() => router.push('/qa/pick')),
            },
      ],
    });
  }

  // Development — tester/dev-only tooling. Each row is independently gated.
  if (showDevSection) {
    const devRows: MoreRow[] = [];
    if (showDevServerSwitcher) {
      devRows.push({
        kind: 'nav',
        key: 'metroServers',
        label: t('mobile.more.metroServersTitle'),
        subtitle: t('mobile.more.metroServersSubtitle'),
        icon: 'devServers',
        onPress: navAction(() => router.push('/(tabs)/profile/dev-servers')),
      });
    }
    if (showFeatureFlags) {
      devRows.push({
        kind: 'nav',
        key: 'featureFlags',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Feature Flags',
        // i18n-ignore-next-line
        subtitle: 'Force feature flags on or off',
        icon: 'featureFlags',
        onPress: navAction(() => router.push('/(tabs)/profile/feature-flags')),
      });
    }
    if (showOfflineWrites) {
      devRows.push({
        kind: 'nav',
        key: 'offlineWrites',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Offline Writes',
        // i18n-ignore-next-line
        subtitle: 'Hold the SQLite write lock, inject faults, inspect the outbox',
        icon: 'featureFlags',
        onPress: navAction(() => router.push('/(tabs)/profile/dev-offline-writes')),
      });
    }
    if (__DEV__) {
      devRows.push({
        kind: 'nav',
        key: 'qaPick',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'QA: pick a PR (dev)',
        // i18n-ignore-next-line
        subtitle: 'Open the tester PR picker; surfing itself only works in a store build',
        icon: 'otaChannel',
        onPress: navAction(() => router.push('/qa/pick?prNumbers=1')),
      });
    }
    if (showOutlineEditor) {
      devRows.push({
        kind: 'nav',
        key: 'outlineEditor',
        // i18n-ignore-next-line — admin-only dev tooling
        label: 'Hold Outlines',
        // i18n-ignore-next-line
        subtitle: 'Redraw a traced hold silhouette, or annotate its LED ring',
        // Board-look, not featureFlags: this row edits how the board is DRAWN,
        // and the two dev rows above it already carry the flag icon.
        icon: 'boardLook',
        onPress: navAction(() => router.push('/(tabs)/profile/outline-editor')),
      });
    }
    if (profile?.isTester) {
      devRows.push({
        kind: 'nav',
        key: 'sentryDiagnostics',
        // i18n-ignore-next-line — tester-only dev tooling
        label: 'Sentry Diagnostics',
        // i18n-ignore-next-line
        subtitle: 'Verify handled, uncaught, and native crash reporting',
        icon: 'otaChannel',
        onPress: navAction(() => router.push('/(tabs)/profile/sentry-diagnostics')),
      });
    }
    sections.push({ key: 'development', title: t('mobile.more.development'), rows: devRows });
  }

  // Preview Build — branch switcher, only in EAS preview dev-client builds.
  if (isPreviewBuild()) {
    sections.push({
      key: 'previewBuild',
      // i18n-ignore-next-line — preview-only section
      title: 'Preview Build',
      rows: [
        {
          kind: 'nav',
          key: 'branchSwitcher',
          // i18n-ignore-next-line
          label: 'Branch Switcher',
          // i18n-ignore-next-line
          subtitle: 'Switch EAS Update branch',
          icon: 'branchSwitcher',
          onPress: navAction(() => router.push('/(tabs)/profile/branch-switcher')),
        },
      ],
    });
  }

  // Account — Edit Profile (with the email as the section footer) plus the
  // destructive Sign Out / Delete Account actions. When signed out, the actions
  // carry the "Account" header themselves so it's never an empty section.
  if (accessCapabilities.useAccountFeatures && profile?.id) {
    sections.push({
      key: 'account',
      title: tProfile('mobile.account'),
      footer: profile.email ?? undefined,
      rows: [
        {
          kind: 'nav',
          key: 'editProfile',
          label: tSettings('profile.editAction'),
          icon: 'editProfile',
          onPress: navAction(() => router.push('/(tabs)/profile/edit')),
        },
      ],
    });
    sections.push({ key: 'accountActions', rows: accountActionRows });
  } else {
    sections.push({ key: 'accountActions', title: tProfile('mobile.account'), rows: accountActionRows });
  }

  const model: MoreFormModel = { sections };

  return <MoreForm model={model} />;
}

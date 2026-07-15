import { useEffect, useMemo, useRef } from 'react';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';
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
import { useAuth } from '../../../src/providers/auth-provider';
import { useProfile, useMyBoards } from '../../../src/lib/graphql/hooks';
import { useBoardDownloads } from '../../../src/offline/use-board-downloads';
import { useSetting, setSetting, getSetting, offlineBoardKeyForBoard } from '../../../src/settings';
import { useConfirm } from '../../../src/providers/dialog-provider';
import { useIsOffline } from '../../../src/hooks/use-is-offline';
import {
  getDeadLetterCount,
  getDeadLetters,
  retryDeadLetter,
  getPendingCount,
  type GraphQLFetch,
} from '@boardsesh/offline-sync';
import { drainMutationQueue } from '../../../src/offline/offline-sync-adapter';
import { getHttpClient } from '../../../src/lib/graphql/client';
import { hapticLight, hapticSelection } from '../../../src/lib/haptics';
import { DevMetadataPanel } from '../../../src/components/DevMetadataPanel';
import { MoreForm } from '../../../src/components/MoreForm';
import type { MoreButtonRow, MoreFormModel, MoreRow, MoreSection } from '../../../src/components/MoreForm.types';
import { isPreviewBuild } from '../../../src/lib/preview-build';
import { isDevLauncherAvailable } from '../../../src/lib/dev-launcher';
import { useGradeFormat } from '../../../src/hooks/use-grade-format';
import { useSessionRecordingPreference } from '../../../src/lib/session-recording-preference';
import { setSessionRecordingEnabled } from '../../../src/lib/analytics';
import { useShowPlaylistTagsPreference } from '../../../src/lib/show-playlist-tags-preference';
import { useBoardseshGradesPreference } from '../../../src/lib/boardsesh-grades-preference';
import { useToast } from '../../../src/providers/toast-provider';
import {
  useFeatureFlag,
  useOfflineDownloadsEnabled,
  useBoardseshGradeEnabled,
} from '../../../src/providers/feature-flags-provider';
import { replayOnboarding } from '../../../src/lib/onboarding/onboarding-storage';
import { reportError } from '../../../src/lib/error-reporting';

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
  const { themeOverride, setThemeOverride } = useTheme();
  const { t } = useTranslation('common');
  const { t: tProfile } = useTranslation('profile');
  const { t: tPlaylists } = useTranslation('playlists');
  const { t: tSettings } = useTranslation('settings');
  const { signOut } = useAuth();
  const { data: profile } = useProfile();
  const { gradeFormat, setGradeFormat } = useGradeFormat();
  const { localePreference, setLocalePreference } = useLocalePreference();
  const { enabled: sessionRecordingEnabled, setEnabled: setSessionRecordingPreference } =
    useSessionRecordingPreference();
  const { enabled: showPlaylistTags, setEnabled: setShowPlaylistTags } = useShowPlaylistTagsPreference();
  const { enabled: showBoardseshGrades, setEnabled: setShowBoardseshGrades } = useBoardseshGradesPreference();
  const boardseshGradeFlagEnabled = useBoardseshGradeEnabled();
  const { showToast } = useToast();
  const stravaEnabled = useFeatureFlag('strava-integration') === true;
  // Off until the Connect IQ watch app ships — nothing to pair to before then.
  const garminWatchEnabled = useFeatureFlag('garmin-watch') === true;
  const offlineEnabled = useOfflineDownloadsEnabled();
  const confirm = useConfirm();

  // "Keep boards offline by default" toggle. Turning it on downloads every board
  // already in My Boards now (user chose this over a future-only default), and the
  // adopt-on-select flow auto-downloads new boards from then on.
  const [autoOfflineBoards] = useSetting('autoOfflineBoards');
  const { enableBoardsOffline } = useBoardDownloads();
  const { data: myBoardsConnection } = useMyBoards(undefined, { enabled: offlineEnabled && !!profile });
  // Memoized so the empty-while-loading fallback keeps a stable identity — the
  // offline effect below depends on this array and shouldn't re-run every render.
  const myBoards = useMemo(() => myBoardsConnection?.boards ?? [], [myBoardsConnection]);

  // With the default on, keep every board offline. Runs on mount and once My Boards
  // resolves, so flipping the toggle before the list loaded still downloads
  // everything. Only enables boards not already opted in, so once they're all in
  // it's a no-op — no repeated sync kicks.
  useEffect(() => {
    if (!offlineEnabled || !autoOfflineBoards || myBoards.length === 0) return;
    const enabled = new Set(getSetting('syncEnabledBoards'));
    const missing = myBoards.filter((board) => !enabled.has(offlineBoardKeyForBoard(board)));
    if (missing.length > 0) enableBoardsOffline(missing);
  }, [offlineEnabled, autoOfflineBoards, myBoards, enableBoardsOffline]);

  // Offline sync-issues surface. Poll the dead-letter count only while online (the
  // section is hidden offline — a pending write offline is expected, not a "stuck"
  // problem). A dead-lettered write is one the server rejected or that failed past
  // its retry budget while reachable: worth surfacing with a retry (never a discard).
  const db = useSQLiteContext();
  const queryClient = useQueryClient();
  const isOffline = useIsOffline();
  const { data: deadLetterCount = 0, refetch: refetchDeadLetters } = useQuery({
    queryKey: ['deadLetters', 'count'],
    queryFn: () => getDeadLetterCount(db),
    enabled: !isOffline,
    // Dead letters are sticky (they don't resolve without a user Retry), so a slow
    // poll is plenty — no need to wake every 5s. With the offline flag off there
    // is still ONE initial fetch (never a recurring poll): legacy dead letters
    // queued while the flag was on must stay reachable via Retry.
    refetchInterval: offlineEnabled ? 30000 : false,
  });

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

  // Sign-out wipes the local queue, so warn before dropping any not-yet-synced
  // writes. No pending writes → sign out straight away (pre-offline behaviour
  // for everyone whose queue is empty, i.e. every normal flag-off user).
  // Deliberately NOT gated on the offline flag: after a kill-switch rollback a
  // flag-off user can still hold queued writes, and those deserve the same
  // warning — the count is one local SQLite read.
  const handleSignOut = async () => {
    let pending = 0;
    try {
      pending = await getPendingCount(db);
    } catch {
      pending = 0;
    }
    if (pending > 0) {
      const confirmed = await confirm({
        title: t('mobile.more.signOut.pendingTitle'),
        message: t('mobile.more.signOut.pendingMessage', { count: pending }),
        confirmLabel: t('mobile.more.signOut.confirm'),
        cancelLabel: t('mobile.more.signOut.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
    }
    void signOut();
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

  // Don't render an empty "Development" section header when no tool applies.
  // (The OTA channel switcher moved to an everyone-facing "Try a preview" entry
  // on the changelog screen, so it's no longer listed here.)
  const showDevSection = (__DEV__ || Boolean(profile?.isTester)) && (showDevServerSwitcher || showFeatureFlags);

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
        void handleSignOut();
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

  // Library — only when signed in (all-playlists is a profile feature).
  if (profile?.id) {
    sections.push({
      key: 'library',
      title: t('mobile.more.library'),
      rows: [
        {
          kind: 'nav',
          key: 'allPlaylists',
          label: tPlaylists('library.allPlaylists.title'),
          icon: 'playlists',
          onPress: navAction(() => router.push('/(tabs)/discover/all')),
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

  // Offline — keep boards available with no signal. Gated by the offline feature
  // flag (the whole offline surface is flag-gated). Turning it on downloads every
  // current board now; future boards auto-download via the adopt-on-select flow.
  if (offlineEnabled) {
    sections.push({
      key: 'offline',
      title: t('mobile.more.offline.title'),
      rows: [
        {
          kind: 'toggle',
          key: 'autoOfflineBoards',
          label: t('mobile.more.offline.autoDownload'),
          subtitle: t('mobile.more.offline.autoDownloadDescription'),
          value: autoOfflineBoards,
          onValueChange: (next) => {
            hapticSelection();
            // The effect above does the enabling + download (robust to a not-yet-
            // loaded list); here we just persist and surface how many will pull down.
            setSetting('autoOfflineBoards', next);
            if (next) {
              const enabled = new Set(getSetting('syncEnabledBoards'));
              const missing = myBoards.filter((board) => !enabled.has(offlineBoardKeyForBoard(board)));
              if (missing.length > 0) {
                showToast(t('mobile.more.offline.downloadingAll', { count: missing.length }), 'info');
              }
            }
          },
        },
      ],
    });
  }

  // Accessibility (nav).
  sections.push({
    key: 'accessibility',
    title: t('mobile.more.accessibility.title'),
    rows: [
      {
        kind: 'nav',
        key: 'accessibility',
        label: t('mobile.more.accessibility.title'),
        subtitle: t('mobile.more.accessibility.rowSubtitleShort'),
        icon: 'accessibility',
        onPress: navAction(() => router.push('/(tabs)/profile/accessibility')),
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

  // Diagnostics — Session Recording toggle. Persist + apply live.
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
    ],
  });

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
  if (profile?.id) {
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

  return (
    <View style={styles.root}>
      {/* Dev-only QA panel (null in production); the Form fills the rest. */}
      <DevMetadataPanel />
      <MoreForm model={model} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});

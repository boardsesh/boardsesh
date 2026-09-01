// Import first so Sentry.init() runs (and installs its global handler) before
// any other module side-effect — notably posthog-client's analytics init and the
// worklet-serialization global-error-capture install, which must wrap Sentry's
// handler, not the other way round.
import { wrapWithSentry } from '../src/lib/sentry';
// Import second, still ahead of anything that reaches posthog-client.ts (e.g.
// AnalyticsProvider below): resolves the party-profile UUID synchronously and
// stores it for posthog-client.ts to bootstrap the PostHog SDK's anonymous
// distinct_id with, before the SDK's own module-eval side effect constructs
// the client and fires its app-lifecycle autocapture. See analytics-bootstrap.ts.
import '../src/lib/analytics-bootstrap';
import { useCallback, useEffect, useRef, useMemo, useState, type ReactNode } from 'react';
import { LogBox, Pressable, StyleSheet, View } from 'react-native';
// Navigation theme comes from expo-router's vendored React Navigation. Expo
// SDK 57's expo-router is not compatible with a separately-installed
// @react-navigation/* package, so import these from `expo-router` directly.
import {
  Stack,
  SplashScreen,
  router,
  ThemeProvider as NavigationThemeProvider,
  DarkTheme,
  DefaultTheme,
} from 'expo-router';
import * as Updates from 'expo-updates';
import { SystemBars } from 'react-native-edge-to-edge';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@expo/ui/community/bottom-sheet';
import { ControlCenter } from '@xprem/control-center';
import Constants from 'expo-constants';
import { QueryProvider } from '../src/providers/query-provider';
import { ThemeProvider, useTheme } from '../src/providers/theme-provider';
import { MaterialThemeProvider } from '../src/providers/material-theme-provider';
import { DialogProvider } from '../src/providers/dialog-provider';
import { AuthProvider } from '../src/providers/auth-provider';
import { I18nProvider } from '../src/providers/i18n-provider';
import { BluetoothProviderWrapper } from '../src/providers/bluetooth-provider-wrapper';
import { RogueTimerProvider } from '../src/providers/rogue-timer-provider';
import { ToastProvider } from '../src/providers/toast-provider';
import { QueueProvider } from '../src/providers/queue-provider';
import { QueueSnackbarProvider } from '../src/providers/queue-snackbar-provider';
import { DrawerHostProvider } from '../src/providers/drawer-host-provider';
import { BleControlSheetProvider } from '../src/providers/ble-control-sheet-provider';
import { DeepLinkProvider } from '../src/providers/deep-link-provider';
import { ShareTargetProvider } from '../src/providers/share-target-provider';
import { TabBarHeightProvider } from '../src/providers/tab-bar-height-provider';
import { BottomChromeMetricsProvider } from '../src/hooks/use-bottom-chrome-metrics';
import { FeatureFlagsProvider, type FeatureFlags } from '../src/providers/feature-flags-provider';
import { MobileBoardPresenceProvider } from '../src/providers/board-presence-provider';
import { SheetPresentationProvider } from '../src/providers/sheet-presentation-provider';
import { PartyProfileProvider } from '../src/providers/party-profile-provider';
import { DatabaseProvider } from '../src/providers/database-provider';
import { ConnectionSettingsProvider } from '../src/providers/connection-settings-provider';
import { FavoritesProvider } from '../src/providers/favorites-provider';
import { PlaylistsProvider } from '../src/providers/playlists-provider';
import { BoardAdapterWrapper } from '../src/providers/board-adapter';
import { PlaylistsAdapterWrapper } from '../src/providers/playlists-adapter';
import { BoardProvider } from '@boardsesh/board-react';
import { toBoardName } from '@boardsesh/board-config';
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { UserDrawerProvider } from '../src/components/user-drawer/UserDrawerProvider';
import { OfflineSyncBridge, OfflineEngineFlagSync } from '../src/components/offline-sync-bridge';
import { useMobileClimbActionsData } from '../src/lib/graphql/hooks';
import { useActiveBoard } from '../src/lib/graphql/use-active-board';
import { useActiveBoardSelfHeal } from '../src/lib/boards/use-active-board-self-heal';
import { ScreenshotBoardAutoActivator } from '../src/components/screenshot-board-auto-activator';
import { Text } from '../src/components/Text';
import { Icon } from '../src/components/Icon';
import { brandColors } from '../src/theme/colors';
import { iosDarkColors } from '../src/theme/ios-colors';
import { spacing } from '../src/theme/tokens';
import { glassStackScreenOptions } from '../src/theme/navigation';
import { reportError, reportHandledError } from '../src/lib/error-reporting';
import { track, getAnalyticsClient } from '../src/lib/analytics';
import { performOtaRecovery, type OtaRecoveryPhase } from '../src/lib/ota-recovery';
import { loadRequiredFonts } from '../src/lib/required-fonts';
import { loadSectionExpandState } from '../src/lib/section-expand-store';
import { useImageCacheMemoryManagement } from '../src/hooks/use-image-cache-memory-management';
import { useDiskCacheSweep } from '../src/hooks/use-disk-cache-sweep';
import { AnalyticsProvider } from '../src/components/analytics/AnalyticsProvider';
import { AnalyticsScreenTracker } from '../src/components/analytics/AnalyticsScreenTracker';
import { ImageCacheTabSweeper } from '../src/components/ImageCacheTabSweeper';
import { AnalyticsPersonProperties } from '../src/components/analytics/AnalyticsPersonProperties';
import { OtaUpdateTracker } from '../src/components/analytics/OtaUpdateTracker';
import { InstallReferrerTracker } from '../src/components/analytics/InstallReferrerTracker';
import { OnboardingGate } from '../src/components/onboarding/OnboardingGate';
import { AccessoryOnboardingTip } from '../src/components/onboarding/AccessoryOnboardingTip';
import { QaTesterGate } from '../src/components/qa/QaTesterGate';
import { FreezeDebugOverlay } from '../src/components/FreezeDebugOverlay';
import { BottomChromeDebugOverlay } from '../src/components/BottomChromeDebugOverlay';
import { WindowInsetPublisher } from '../src/hooks/use-window-bottom-inset';
import { LiveActivityIntentDiagnostics } from '../src/components/LiveActivityIntentDiagnostics';
import { isBranchSurfingBuild, prepareOtaBranchSurfing } from '../src/lib/legacy-ota-channel-migration';
import { setOtaBranchSurfingState } from '../src/lib/ota-branch-surfing-state';
import { getPreference, removePreference, setPreference } from '../src/lib/preference-store';
// Side-effect import: instantiates the Android-only MemoryTrim native module
// (expo-modules-core creates modules lazily on first JS access), whose Kotlin
// OnCreate registers the Glide trim-on-UI_HIDDEN callback. No-op on iOS.
import '../modules/memory-trim/src/index';

void SplashScreen.preventAutoHideAsync();

// The screenshots build is a Debug dev-client (__DEV__ true) so it can load its
// JS from Metro; a stray warning would pop a LogBox toast into a captured
// screenshot. Suppress all LogBox UI in screenshot mode. EXPO_PUBLIC_SCREENSHOT_MODE
// is inlined at build time, so this dead-strips from every normal build.
if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1') {
  LogBox.ignoreAllLogs(true);
}

const layoutStyles = StyleSheet.create({
  root: { flex: 1 },
});

function buildStaticFeatureFlags(): FeatureFlags | undefined {
  const flags: FeatureFlags = {};

  if (process.env.EXPO_PUBLIC_STRAVA_INTEGRATION === 'true') {
    flags['strava-integration'] = true;
  }

  if (process.env.EXPO_PUBLIC_LOGBOOK_FILTERS === 'true') {
    flags['logbook-filters'] = true;
  }

  return Object.keys(flags).length > 0 ? flags : undefined;
}

const STATIC_FEATURE_FLAGS = buildStaticFeatureFlags();

function OtaBranchControlCenter() {
  // Fingerprint-bound required headers distinguish Branch Surfing-capable
  // binaries from EAS previews. Updates.channel cannot do that: a legacy
  // persisted override changes the value exposed for this launch.
  const branchSurfingBuild = useMemo(
    () =>
      isBranchSurfingBuild({
        development: __DEV__,
        updatesEnabled: Updates.isEnabled,
        updatesConfig: Constants.expoConfig?.updates,
      }),
    [],
  );
  const [migrationComplete, setMigrationComplete] = useState(!branchSurfingBuild);

  useEffect(() => {
    if (!branchSurfingBuild) return;

    let cancelled = false;
    void prepareOtaBranchSurfing({
      branchSurfingBuild,
      readMigrationComplete: getPreference,
      clearRequestHeadersOverride: () => Updates.setUpdateRequestHeadersOverride(null),
      removeLegacyMirror: removePreference,
      markMigrationComplete: setPreference,
      reload: Updates.reloadAsync,
    })
      .then((preparation) => {
        // A cleared native override requires a new JS runtime before xprem reads
        // Updates.channel. reloadAsync normally never returns to this tree; if it
        // does, keep the picker disabled rather than mounting against stale data.
        if (!cancelled && preparation === 'ready') setMigrationComplete(true);
      })
      .catch((error: unknown) => {
        reportHandledError(error, { tags: { source: 'ota', op: 'clear-legacy-channel-override' } });
      });

    return () => {
      cancelled = true;
    };
  }, [branchSurfingBuild]);

  // Publish what we resolved so surfaces outside this subtree (the QA launch
  // gate, the user drawer) can read it without redoing the work or racing the
  // migration's reload. Written in an effect, not during render, so a subscriber
  // is never notified mid-render.
  useEffect(() => {
    setOtaBranchSurfingState({ surfingBuild: branchSurfingBuild, ready: migrationComplete });
  }, [branchSurfingBuild, migrationComplete]);

  return branchSurfingBuild && migrationComplete ? <ControlCenter /> : null;
}

const errorStyles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing[6],
  },
  iconContainer: {
    marginBottom: spacing[5],
  },
  title: {
    textAlign: 'center',
    marginBottom: spacing[2],
  },
  message: {
    textAlign: 'center',
    marginBottom: spacing[8],
    opacity: 0.7,
  },
  buttonRow: {
    gap: spacing[3],
    width: '100%',
    maxWidth: 280,
  },
  primaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: brandColors.primaryFill,
    paddingHorizontal: spacing[5],
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    borderColor: brandColors.primary,
    paddingHorizontal: spacing[5],
  },
  pressedButton: {
    opacity: 0.72,
  },
  disabledButton: {
    opacity: 0.5,
  },
  buttonLabel: {
    fontWeight: '700',
  },
  statusText: {
    textAlign: 'center',
    marginTop: spacing[4],
    maxWidth: 280,
    opacity: 0.7,
  },
});

type ErrorBoundaryProps = {
  error: Error;
  retry: () => void;
};

// Recovery-button UI state. `busy` carries the live phase so the button label
// doubles as a status line; the two terminal non-reload results each surface a
// short message under the buttons (the reload results restart the app, so they
// never render a follow-up state here).
type RecoveryState =
  | { kind: 'idle' }
  | { kind: 'busy'; phase: OtaRecoveryPhase }
  | { kind: 'no-fix-available' }
  | { kind: 'failed' };

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  // No useTranslation here: Expo Router renders this before any of our
  // providers mount, so i18next isn't initialized. Calling the hook would
  // return raw key strings exactly when the user most needs readable copy.
  // Hardcode English as the last-resort safe fallback.
  const reportedRef = useRef<Error | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState>({ kind: 'idle' });

  // useUpdates() subscribes to expo-updates' native emitter directly (no provider
  // of ours), so it's safe in this pre-provider boundary. Called unconditionally —
  // the recovery button is gated below, never the hook.
  const { isUpdatePending } = Updates.useUpdates();
  // Mirror into a ref so a long-running recovery attempt (up to 30s) reads the
  // latest pending state, not the snapshot captured when the attempt started.
  const isUpdatePendingRef = useRef(isUpdatePending);
  isUpdatePendingRef.current = isUpdatePending;

  // The check/fetch/reload calls throw ERR_UPDATES_DISABLED in dev, so only offer
  // recovery on a real store/TestFlight binary that ships with updates enabled.
  const showRecoveryButton = Updates.isEnabled && !__DEV__;
  const isBusy = recovery.kind === 'busy';

  useEffect(() => {
    if (reportedRef.current !== error) {
      reportedRef.current = error;
      reportError(error);
      // Module-level track() works without AnalyticsProvider (it drives the same
      // lazily-built PostHog client), so the crash screen is observable. Tag the
      // OTA cohort so a broken-bundle spike is sliceable by update id / channel.
      track('Error Screen Shown', {
        ota_update_id: Updates.updateId,
        ota_is_embedded: Updates.isEmbeddedLaunch,
        ota_channel: Updates.channel,
      });
    }
  }, [error]);

  const handleGoHome = () => {
    router.replace('/(tabs)/home');
  };

  const handleCheckForFix = useCallback(async () => {
    setRecovery({ kind: 'busy', phase: 'checking' });
    const { result, error: recoveryError } = await performOtaRecovery(
      {
        checkForUpdate: () => Updates.checkForUpdateAsync(),
        fetchUpdate: () => Updates.fetchUpdateAsync(),
        reload: () => Updates.reloadAsync(),
        isUpdatePending: () => isUpdatePendingRef.current,
      },
      {
        onPhase: (phase) => setRecovery({ kind: 'busy', phase }),
        // Track the reloaded-* outcomes BEFORE the reload — a post-return track()
        // would race the app restart and typically be lost. track() only enqueues,
        // so flush best-effort (fire-and-forget; the reload follows immediately, we
        // don't delay it — delivery is best-effort) to give it a window.
        onBeforeReload: (result) => {
          track('OTA Recovery Attempted', { result });
          void getAnalyticsClient()?.flush();
        },
      },
    );
    // The reloaded-* outcomes are tracked in onBeforeReload above (before the
    // restart). Only these non-reload terminal results reliably reach here, so
    // guard the post-return track to avoid double-counting a reloaded-* result if
    // JS happens to survive the reload.
    if (result === 'failed' || result === 'no-fix-available') {
      track('OTA Recovery Attempted', { result });
    }
    if (result === 'failed') {
      reportHandledError(recoveryError, { tags: { source: 'ota-error-screen' } });
      setRecovery({ kind: 'failed' });
    } else if (result === 'no-fix-available') {
      setRecovery({ kind: 'no-fix-available' });
    }
    // A reloaded-* result means the app is restarting — leave the busy state be.
  }, []);

  const recoveryLabel =
    recovery.kind === 'busy' ? (recovery.phase === 'downloading' ? 'Downloading…' : 'Checking…') : 'Check for a fix';

  return (
    <View style={errorStyles.container}>
      <View style={errorStyles.iconContainer}>
        {/* Static brand colour on purpose: this boundary can render outside the
            ThemeProvider (the crash screen), where useTheme() would throw — so
            it can't read the scheme-aware brand. */}
        <Icon name="warning" size={48} color={brandColors.warning} />
      </View>
      <Text variant="title2" style={errorStyles.title}>
        Something went wrong
      </Text>
      <Text variant="body" style={errorStyles.message}>
        The app hit an unexpected error. You can try again or head back home.
      </Text>
      <View style={errorStyles.buttonRow}>
        {/* On a real binary, offer the one-tap OTA recovery first: check for a
            newer bundle (or a published rollback directive), download it, and
            reload onto it. It takes the primary slot; "Try again" demotes to the
            secondary style. In dev / when the button is hidden, "Try again" keeps
            the primary style. */}
        {showRecoveryButton && (
          <Pressable
            onPress={() => void handleCheckForFix()}
            disabled={isBusy}
            accessibilityRole="button"
            accessibilityLabel="Check for a fix"
            accessibilityState={{ disabled: isBusy, busy: isBusy }}
            style={({ pressed }) => [
              errorStyles.primaryButton,
              pressed && errorStyles.pressedButton,
              isBusy && errorStyles.disabledButton,
            ]}
          >
            <Text variant="body" color={brandColors.onPrimary} style={errorStyles.buttonLabel}>
              {recoveryLabel}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={({ pressed }) => [
            showRecoveryButton ? errorStyles.secondaryButton : errorStyles.primaryButton,
            pressed && errorStyles.pressedButton,
          ]}
        >
          <Text
            variant="body"
            color={showRecoveryButton ? brandColors.primary : brandColors.onPrimary}
            style={errorStyles.buttonLabel}
          >
            Try again
          </Text>
        </Pressable>
        <Pressable
          onPress={handleGoHome}
          accessibilityRole="button"
          accessibilityLabel="Go home"
          style={({ pressed }) => [errorStyles.secondaryButton, pressed && errorStyles.pressedButton]}
        >
          <Text variant="body" color={brandColors.primary} style={errorStyles.buttonLabel}>
            Go home
          </Text>
        </Pressable>
      </View>
      {recovery.kind === 'no-fix-available' && (
        <Text variant="footnote" style={errorStyles.statusText}>
          No fix available yet — try again in a few minutes.
        </Text>
      )}
      {recovery.kind === 'failed' && (
        <Text variant="footnote" style={errorStyles.statusText}>
          Couldn&apos;t reach the update server. Check your connection and try again.
        </Text>
      )}
    </View>
  );
}

// Wires real React Query data into FavoritesProvider and PlaylistsProvider.
// Has to live below AuthProvider (uses auth state) and QueryProvider (uses
// useQuery), and above the two providers it feeds.
function ClimbActionsDataWrapper({ children }: { children: ReactNode }) {
  const { favoritesProviderProps, playlistsProviderProps } = useMobileClimbActionsData();
  return (
    <FavoritesProvider {...favoritesProviderProps}>
      <PlaylistsProvider {...playlistsProviderProps}>{children}</PlaylistsProvider>
    </FavoritesProvider>
  );
}

// Supplies the active board name to the shared BoardProvider. The API types
// `boardType` as a loose string, so it's validated to a `BoardName | null`.
// A null board keeps logbook fetches idle and makes mutations throw rather
// than send an empty `boardType`.
function BoardProviderWrapper({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  // Reconcile a stored active board that a server-side merge collapsed away
  // after hydration and whenever the app returns to the foreground.
  useActiveBoardSelfHeal();
  return (
    <BoardProvider
      boardName={toBoardName(activeBoard?.boardType)}
      boardUuid={activeBoard?.uuid}
      layoutId={activeBoard?.layoutId}
    >
      {/* Screenshot builds only (inlined check → dead-strips in normal builds):
          auto-activate the user's first board so board-backed shots aren't stuck
          on the "No board selected" picker. */}
      {process.env.EXPO_PUBLIC_SCREENSHOT_MODE === '1' && <ScreenshotBoardAutoActivator />}
      {children}
    </BoardProvider>
  );
}

// Dark-aware navigation theme so screen/scene backgrounds adapt — without it,
// React Navigation's light-grey DefaultTheme background shows through every
// screen in dark mode. Reads the *resolved* scheme from useTheme() (which
// honours the appearance override) rather than a separate useColorScheme(), so
// the nav chrome and the app theme can't disagree for a frame.
function ThemedNavigation({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  const navTheme = useMemo(
    () =>
      colorScheme === 'dark'
        ? {
            ...DarkTheme,
            colors: {
              ...DarkTheme.colors,
              background: iosDarkColors.background,
              card: iosDarkColors.secondaryBackground,
            },
          }
        : DefaultTheme,
    [colorScheme],
  );
  return (
    <NavigationThemeProvider value={navTheme}>
      {/* Drive BOTH the status-bar and the Android 3-button navigation-bar icon
          contrast from the *resolved* scheme (honours the in-app appearance
          override), not "auto" — under Android's mandatory edge-to-edge the bars
          are transparent over app content, so a forced dark theme on a light OS
          must still get light icons. SystemBars (react-native-edge-to-edge)
          replaces expo-status-bar and also owns the nav-bar tint; a single string
          style applies to both bars. */}
      <SystemBars style={colorScheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </NavigationThemeProvider>
  );
}

function RootLayout() {
  const [authReady, setAuthReady] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);

  // Flush decoded board-art bitmaps on background / memory warning (#3479).
  useImageCacheMemoryManagement();
  // Keep the on-disk board-art cache under its cap DURING a session, not only on
  // the cold launch the native pruner runs on (#3647).
  useDiskCacheSweep();

  useEffect(() => {
    let cancelled = false;
    void loadRequiredFonts()
      .catch((error: unknown) => {
        reportError(error);
      })
      .finally(() => {
        if (!cancelled) setFontsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Warm the collapsed-section map early so the sections a climber navigates to
  // later (play drawer, profile, session detail) mount against a loaded store
  // instead of each triggering the lazy read (#4229). Deliberately NOT a splash
  // gate: startup must not wait on a preference read. The one surface that
  // paints before this can resolve — the home beta shelf — waits on the store's
  // own `loaded` flag instead, so it renders nothing rather than guessing
  // expanded and visibly correcting itself.
  useEffect(() => {
    void loadSectionExpandState().catch((error: unknown) => {
      reportError(error);
    });
  }, []);

  const onAuthReady = useCallback(() => {
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn(`[root-ready] authReady=${String(authReady)} fontsReady=${String(fontsReady)}`);
    }
    if (!authReady || !fontsReady) return;
    void SplashScreen.hideAsync();
  }, [authReady, fontsReady]);

  return (
    <GestureHandlerRootView style={layoutStyles.root}>
      {/* Effect runs only after this React root commits. It marks whether an
          iOS LiveActivityIntent background launch mounted React, then consumes
          eligible interrupted markers when the app is foregrounded. */}
      <LiveActivityIntentDiagnostics />
      {/* PostHogProvider sits at the top so touch autocapture covers the whole
          app. It owns the single PostHog client; manual events go through the
          imperative wrapper in src/lib/analytics. No-ops (renders children
          untouched) in dev / when no key is configured. */}
      <AnalyticsProvider>
        <I18nProvider>
          <QueryProvider>
            <DatabaseProvider>
              <ThemeProvider>
                <MaterialThemeProvider>
                  {/* Inside MaterialThemeProvider (Paper Portal host) and above every
                    provider that may call useConfirm (incl. Bluetooth). */}
                  <DialogProvider>
                    <FeatureFlagsProvider flags={STATIC_FEATURE_FLAGS}>
                      {/* First child on purpose: publishes the offline-engine flag to the
                          non-React store before any later sibling's query effects run. */}
                      <OfflineEngineFlagSync />
                      <AuthProvider onReady={onAuthReady}>
                        <PartyProfileProvider>
                          {/* Needs auth + query, both in scope here. Null render. */}
                          <AnalyticsPersonProperties />
                          <ConnectionSettingsProvider>
                            <ToastProvider>
                              <ClimbActionsDataWrapper>
                                <QueueSnackbarProvider>
                                  <QueueProvider>
                                    <BoardAdapterWrapper>
                                      <PlaylistsAdapterWrapper>
                                        <BoardProviderWrapper>
                                          {/* BottomSheetModalProvider sits inside the board
                                    providers (gorhom's BottomSheetModal portals
                                    PlayDrawer → QuickTickBar here, so the host
                                    must be able to see BoardAdapter/BoardProvider
                                    through context) but *outside*
                                    BluetoothProviderWrapper, because
                                    BluetoothProvider renders DevicePickerSheet
                                    as a BottomSheetModal — the modal host has to
                                    exist before the picker mounts or gorhom
                                    throws "BottomSheetModalInternalContext
                                    cannot be null". */}
                                          {/* Board presence ("now on the wall") owns the
                                    connected boardId + the wall feed. Wraps
                                    BottomSheetModalProvider so gorhom-portaled
                                    sheets (PlayDrawer, BoardSheet) — which render
                                    at the modal host, not their declaration site —
                                    can still read the wall state through context.
                                    Also OUTSIDE BluetoothProviderWrapper /
                                    DrawerHostProvider so the BLE flow + Board sheet
                                    can use it. */}
                                          <MobileBoardPresenceProvider>
                                            {/* Serializes every native bottom-sheet present/dismiss so two
                                              never overlap on the same presenter — the iOS UIKit deadlock
                                              that froze the whole UI. Ancestor of every sheet (BLE, drawer
                                              host, user drawer). See sheet-presentation-provider.tsx. */}
                                            <SheetPresentationProvider>
                                              <BottomSheetModalProvider>
                                                <BluetoothProviderWrapper>
                                                  {/* Drives the Rogue workout timer paired to the active
                                                  board. Inside BluetoothProviderWrapper so it can gate
                                                  on the board LED connection (only the wall driver owns
                                                  the timer). */}
                                                  <RogueTimerProvider>
                                                    {/* One BLE controls sheet (Re-light / Turn off /
                                                  Disconnect) shared by the play-drawer lightbulb and
                                                  the persistent bar's board control. Wraps
                                                  DrawerHostProvider (which renders PlayDrawer as a
                                                  sibling of its children) so both the drawer and the
                                                  bar descend from it. */}
                                                    <BleControlSheetProvider>
                                                      {/* Reads the bottom-chrome geometry inputs (insets, route,
                                                          variant, presence, native-bar capability) ONCE and shares the
                                                          memoized result with every consumer below. Mounted ABOVE
                                                          DrawerHostProvider because that provider renders the queue /
                                                          undo-wall snackbars — themselves bottom-chrome consumers — as
                                                          siblings of its children; a lower mount left those snackbars
                                                          outside the context so useBottomChromeMetrics() threw and
                                                          white-screened every install that took the OTA. #2565. */}
                                                      <BottomChromeMetricsProvider>
                                                        <DrawerHostProvider>
                                                          <DeepLinkProvider>
                                                            <ShareTargetProvider>
                                                              <TabBarHeightProvider>
                                                                <UserDrawerProvider>
                                                                  <ThemedNavigation>
                                                                    <Stack
                                                                      // Root scenes keep the opaque, theme-aware nav background so a dark
                                                                      // backstop sits behind the tab screens (the tab stacks paint their own
                                                                      // transparent content over it). glassStackScreenOptions' transparent
                                                                      // contentStyle would expose the light window background at the top of the
                                                                      // screen in dark mode, where the floating chrome leaves it uncovered.
                                                                      // The header props still apply to root-level pushed screens (session, about).
                                                                      screenOptions={{
                                                                        ...glassStackScreenOptions,
                                                                        headerShown: false,
                                                                        contentStyle: undefined,
                                                                      }}
                                                                      initialRouteName="index"
                                                                    >
                                                                      <Stack.Screen name="index" />
                                                                      <Stack.Screen name="(tabs)" />
                                                                      <Stack.Screen
                                                                        name="auth"
                                                                        options={{
                                                                          headerShown: false,
                                                                          gestureEnabled: false,
                                                                        }}
                                                                      />
                                                                      {/* Public climber profiles + climber search, pushed from any
                                                          tab (tappable avatars, the Home search action). */}
                                                                      <Stack.Screen name="users/[userId]/index" />
                                                                      {/* A climber's full beta-video grid — the "See all" target of
                                                          the profile beta shelf. Sets its own solid header. */}
                                                                      <Stack.Screen name="users/[userId]/beta" />
                                                                      {/* Headerless push — hides the tab bar like the other pushed
                                                          screens, with its own in-body search bar. NOT a modal: a native
                                                          modal presentation traps the root play drawer beneath it when a
                                                          climb is opened from a profile pushed off search. */}
                                                                      <Stack.Screen
                                                                        name="users/search"
                                                                        options={{ headerShown: false }}
                                                                      />
                                                                      <Stack.Screen name="users/connections" />
                                                                      <Stack.Screen
                                                                        name="join/[sessionId]"
                                                                        options={{
                                                                          presentation: 'modal',
                                                                          headerShown: false,
                                                                        }}
                                                                      />
                                                                      <Stack.Screen
                                                                        name="share-beta"
                                                                        options={{
                                                                          presentation: 'modal',
                                                                          headerShown: false,
                                                                        }}
                                                                      />
                                                                      {/* Board selection is a modal off the Climbs capsule /
                                                      no-board CTA — board switching is rare, so it doesn't
                                                      earn a tab. Its own _layout owns the headers. */}
                                                                      <Stack.Screen
                                                                        name="boards"
                                                                        options={{
                                                                          presentation: 'modal',
                                                                          headerShown: false,
                                                                        }}
                                                                      />
                                                                      {/* First-run welcome walkthrough. Full-screen cover
                                                      over the Climbs tab; gesture disabled so the user
                                                      leaves only via Skip / finish / the final CTA, never
                                                      an accidental swipe-dismiss. */}
                                                                      <Stack.Screen
                                                                        name="onboarding"
                                                                        options={{
                                                                          presentation: 'fullScreenModal',
                                                                          headerShown: false,
                                                                          gestureEnabled: false,
                                                                          animation: 'fade',
                                                                        }}
                                                                      />
                                                                      {/* Full-screen "now playing" player. A modal VC so the
                                                      sub-drawers / queue / share sheet opened from inside it stack
                                                      ABOVE it (the FullWindowOverlay it replaced sat in a higher
                                                      window, so native sheets rendered behind). transparentModal —
                                                      NOT fullScreenModal — so the iOS 26 native tab bar + its bottom
                                                      accessory stay LIVE behind it: a fullScreenModal snapshots the
                                                      presenting VC, and that snapshot of the glass accessory platter
                                                      lingered stacked under the live one (doubled climb name) and
                                                      churned the docked search field. The player paints its own
                                                      opaque backing (see app/play.tsx) so the live tabs screen
                                                      doesn't show through the glass. Custom pull-down dismiss; covers
                                                      the tab bar. */}
                                                                      {/* User drawer as a route, not an RN-core <Modal>. A
                                                      single native presentation system, so it no longer
                                                      collides with the @expo/ui FeedbackSheet (the
                                                      dual-presentation freeze, issue #3211). transparentModal
                                                      — NOT fullScreenModal (hard rule 2) — so the screen
                                                      behind stays live; animation 'none' because the panel
                                                      runs its OWN reanimated slide (app/user-drawer.tsx).
                                                      gestureEnabled off so the only dismiss is the panel's
                                                      own animated close (backdrop tap / a row). */}
                                                                      {/* Crowdsourced QA (tester-only). Plain modals: each
                                                      screen paints its own header so it reads as a
                                                      self-contained prompt rather than a pushed settings
                                                      page, and a swipe-dismiss on the picker is a Skip. */}
                                                                      <Stack.Screen
                                                                        name="qa/pick"
                                                                        options={{
                                                                          presentation: 'modal',
                                                                          headerShown: false,
                                                                        }}
                                                                      />
                                                                      <Stack.Screen
                                                                        name="qa/brief"
                                                                        options={{
                                                                          presentation: 'modal',
                                                                          headerShown: false,
                                                                        }}
                                                                      />
                                                                      <Stack.Screen
                                                                        name="user-drawer"
                                                                        options={{
                                                                          presentation: 'transparentModal',
                                                                          headerShown: false,
                                                                          gestureEnabled: false,
                                                                          animation: 'none',
                                                                        }}
                                                                      />
                                                                      <Stack.Screen
                                                                        name="play"
                                                                        options={{
                                                                          presentation: 'transparentModal',
                                                                          headerShown: false,
                                                                          // Native interactive dismiss OFF — it lives outside
                                                                          // RNGH so it couldn't negotiate with the board
                                                                          // swipe/pinch (only fired on the grabber). A custom
                                                                          // RNGH pull-down (use-drawer-dismiss-gesture) drives
                                                                          // dismissal from the whole surface instead.
                                                                          gestureEnabled: false,
                                                                          animation: 'slide_from_bottom',
                                                                        }}
                                                                      />
                                                                    </Stack>
                                                                  </ThemedNavigation>
                                                                  <PersistentQueueBar />
                                                                  <OfflineSyncBridge />
                                                                  {/* One-time tip floating above the tab bar / accessory bar,
                                                            mounted next to PersistentQueueBar so it watches climb
                                                            presence globally and overlays both the native (iOS 26) and
                                                            JS bottom-bar variants. */}
                                                                  <AccessoryOnboardingTip />
                                                                  <OnboardingGate ready={authReady && fontsReady} />
                                                                  {/* Asks a tester to try a PR preview (or shows what to
                                                            test on the one already running). No-op for everyone
                                                            else. Mounted after OnboardingGate so the first-run
                                                            walkthrough always wins a cold start. */}
                                                                  <QaTesterGate ready={authReady && fontsReady} />
                                                                  {/* Tester-only diagnostic for the Android-16 edge-to-edge
                                                            touch-dead bug; a root sibling (stays tappable while the
                                                            <Stack> hit-region is frozen). No-op unless built with
                                                            EXPO_PUBLIC_FREEZE_DEBUG=1. */}
                                                                  <FreezeDebugOverlay />
                                                                  {/* Live bottom-chrome geometry readout (dev / preview /
                                                            pr-channel + settings toggle). Inside the metrics provider
                                                            so it reads the same derived values consumers position with. */}
                                                                  <BottomChromeDebugOverlay />
                                                                  {/* Root-sampled window inset for bottom-docked sheets —
                                                            here (outside the tabs) useSafeAreaInsets IS the window's. */}
                                                                  <WindowInsetPublisher />
                                                                </UserDrawerProvider>
                                                              </TabBarHeightProvider>
                                                              <AnalyticsScreenTracker />
                                                              <ImageCacheTabSweeper />
                                                              <OtaUpdateTracker />
                                                              <InstallReferrerTracker />
                                                            </ShareTargetProvider>
                                                          </DeepLinkProvider>
                                                        </DrawerHostProvider>
                                                      </BottomChromeMetricsProvider>
                                                    </BleControlSheetProvider>
                                                  </RogueTimerProvider>
                                                </BluetoothProviderWrapper>
                                              </BottomSheetModalProvider>
                                            </SheetPresentationProvider>
                                          </MobileBoardPresenceProvider>
                                        </BoardProviderWrapper>
                                      </PlaylistsAdapterWrapper>
                                    </BoardAdapterWrapper>
                                  </QueueProvider>
                                </QueueSnackbarProvider>
                              </ClimbActionsDataWrapper>
                            </ToastProvider>
                          </ConnectionSettingsProvider>
                        </PartyProfileProvider>
                      </AuthProvider>
                    </FeatureFlagsProvider>
                  </DialogProvider>
                </MaterialThemeProvider>
              </ThemeProvider>
            </DatabaseProvider>
          </QueryProvider>
        </I18nProvider>
      </AnalyticsProvider>
      {/* Final sibling by design, matching xprem's documented composition. RN
          paints later siblings above earlier ones; placing the ControlCenter
          here keeps its absolute edge marker above the full-screen app tree.
          A one-time migration clears retired Boardsesh channel overrides and
          reloads before this component becomes eligible to mount. */}
      <OtaBranchControlCenter />
    </GestureHandlerRootView>
  );
}

// Wrap with Sentry so the root and its children report render errors and feed
// the navigation/performance instrumentation. No-op when Sentry is disabled
// (dev / no DSN), so it's safe in every build.
export default wrapWithSentry(RootLayout);

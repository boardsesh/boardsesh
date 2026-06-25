// Import first so Sentry.init() runs (and installs its global handler) before
// any other module side-effect — notably posthog-client's analytics init and the
// worklet-serialization global-error-capture install, which must wrap Sentry's
// handler, not the other way round.
import { wrapWithSentry } from '../src/lib/sentry';
import { useCallback, useEffect, useRef, useMemo, useState, type ReactNode } from 'react';
import { LogBox, Pressable, StyleSheet, View } from 'react-native';
// Navigation theme comes from expo-router's vendored React Navigation. Expo
// SDK 56's expo-router is not compatible with a separately-installed
// @react-navigation/* package, so import these from `expo-router` directly.
import {
  Stack,
  SplashScreen,
  router,
  ThemeProvider as NavigationThemeProvider,
  DarkTheme,
  DefaultTheme,
} from 'expo-router';
import { SystemBars } from 'react-native-edge-to-edge';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@expo/ui/community/bottom-sheet';
import { QueryProvider } from '../src/providers/query-provider';
import { ThemeProvider, useTheme } from '../src/providers/theme-provider';
import { MaterialThemeProvider } from '../src/providers/material-theme-provider';
import { DialogProvider } from '../src/providers/dialog-provider';
import { AuthProvider } from '../src/providers/auth-provider';
import { I18nProvider } from '../src/providers/i18n-provider';
import { BluetoothProviderWrapper } from '../src/providers/bluetooth-provider-wrapper';
import { ToastProvider } from '../src/providers/toast-provider';
import { QueueProvider } from '../src/providers/queue-provider';
import { QueueSnackbarProvider } from '../src/providers/queue-snackbar-provider';
import { DrawerHostProvider } from '../src/providers/drawer-host-provider';
import { BleControlSheetProvider } from '../src/providers/ble-control-sheet-provider';
import { DeepLinkProvider } from '../src/providers/deep-link-provider';
import { ShareTargetProvider } from '../src/providers/share-target-provider';
import { TabBarHeightProvider } from '../src/providers/tab-bar-height-provider';
import { FeatureFlagsProvider, type FeatureFlags } from '../src/providers/feature-flags-provider';
import { MobileBoardPresenceProvider } from '../src/providers/board-presence-provider';
import { PartyProfileProvider } from '../src/providers/party-profile-provider';
import { ConnectionSettingsProvider } from '../src/providers/connection-settings-provider';
import { FavoritesProvider } from '../src/providers/favorites-provider';
import { PlaylistsProvider } from '../src/providers/playlists-provider';
import { BoardAdapterWrapper } from '../src/providers/board-adapter';
import { PlaylistsAdapterWrapper } from '../src/providers/playlists-adapter';
import { BoardProvider } from '@boardsesh/board-react';
import { toBoardName } from '@boardsesh/board-config';
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { UserDrawerProvider } from '../src/components/user-drawer/UserDrawerProvider';
import { useMobileClimbActionsData } from '../src/lib/graphql/hooks';
import { useActiveBoard } from '../src/lib/graphql/use-active-board';
import { ScreenshotBoardAutoActivator } from '../src/components/screenshot-board-auto-activator';
import { Text } from '../src/components/Text';
import { Icon } from '../src/components/Icon';
import { brandColors } from '../src/theme/colors';
import { iosDarkColors } from '../src/theme/ios-colors';
import { spacing } from '../src/theme/tokens';
import { glassStackScreenOptions } from '../src/theme/navigation';
import { reportError } from '../src/lib/error-reporting';
import { loadRequiredFonts } from '../src/lib/required-fonts';
import { AnalyticsProvider } from '../src/components/analytics/AnalyticsProvider';
import { AnalyticsScreenTracker } from '../src/components/analytics/AnalyticsScreenTracker';
import { OtaUpdateTracker } from '../src/components/analytics/OtaUpdateTracker';
import { OnboardingGate } from '../src/components/onboarding/OnboardingGate';
import { AccessoryOnboardingTip } from '../src/components/onboarding/AccessoryOnboardingTip';
import { FreezeDebugOverlay } from '../src/components/FreezeDebugOverlay';

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
  buttonLabel: {
    fontWeight: '700',
  },
});

type ErrorBoundaryProps = {
  error: Error;
  retry: () => void;
};

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  // No useTranslation here: Expo Router renders this before any of our
  // providers mount, so i18next isn't initialized. Calling the hook would
  // return raw key strings exactly when the user most needs readable copy.
  // Hardcode English as the last-resort safe fallback.
  const reportedRef = useRef<Error | null>(null);

  useEffect(() => {
    if (reportedRef.current !== error) {
      reportedRef.current = error;
      reportError(error);
    }
  }, [error]);

  const handleGoHome = () => {
    router.replace('/(tabs)/home');
  };

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
        <Pressable
          onPress={retry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={({ pressed }) => [errorStyles.primaryButton, pressed && errorStyles.pressedButton]}
        >
          <Text variant="body" color={brandColors.onPrimary} style={errorStyles.buttonLabel}>
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
  return (
    <BoardProvider boardName={toBoardName(activeBoard?.boardType)} boardUuid={activeBoard?.uuid}>
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

  const onAuthReady = useCallback(() => {
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!authReady || !fontsReady) return;
    void SplashScreen.hideAsync();
  }, [authReady, fontsReady]);

  return (
    <GestureHandlerRootView style={layoutStyles.root}>
      {/* PostHogProvider sits at the top so touch autocapture covers the whole
          app. It owns the single PostHog client; manual events go through the
          imperative wrapper in src/lib/analytics. No-ops (renders children
          untouched) in dev / when no key is configured. */}
      <AnalyticsProvider>
        <I18nProvider>
          <QueryProvider>
            <ThemeProvider>
              <MaterialThemeProvider>
                {/* Inside MaterialThemeProvider (Paper Portal host) and above every
                    provider that may call useConfirm (incl. Bluetooth). */}
                <DialogProvider>
                  <FeatureFlagsProvider flags={STATIC_FEATURE_FLAGS}>
                    <AuthProvider onReady={onAuthReady}>
                      <PartyProfileProvider>
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
                                          <BottomSheetModalProvider>
                                            <BluetoothProviderWrapper>
                                              {/* One BLE controls sheet (Re-light / Turn off /
                                                  Disconnect) shared by the play-drawer lightbulb and
                                                  the persistent bar's board control. Wraps
                                                  DrawerHostProvider (which renders PlayDrawer as a
                                                  sibling of its children) so both the drawer and the
                                                  bar descend from it. */}
                                              <BleControlSheetProvider>
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
                                                                options={{ headerShown: false, gestureEnabled: false }}
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
                                                                options={{ presentation: 'modal', headerShown: false }}
                                                              />
                                                              <Stack.Screen
                                                                name="share-beta"
                                                                options={{ presentation: 'modal', headerShown: false }}
                                                              />
                                                              {/* Board selection is a modal off the Climbs capsule /
                                                      no-board CTA — board switching is rare, so it doesn't
                                                      earn a tab. Its own _layout owns the headers. */}
                                                              <Stack.Screen
                                                                name="boards"
                                                                options={{ presentation: 'modal', headerShown: false }}
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
                                                          {/* One-time tip floating above the tab bar / accessory bar,
                                                            mounted next to PersistentQueueBar so it watches climb
                                                            presence globally and overlays both the native (iOS 26) and
                                                            JS bottom-bar variants. */}
                                                          <AccessoryOnboardingTip />
                                                          <OnboardingGate ready={authReady && fontsReady} />
                                                          {/* Tester-only diagnostic for the Android-16 edge-to-edge
                                                            touch-dead bug; a root sibling (stays tappable while the
                                                            <Stack> hit-region is frozen). No-op unless built with
                                                            EXPO_PUBLIC_FREEZE_DEBUG=1. */}
                                                          <FreezeDebugOverlay />
                                                        </UserDrawerProvider>
                                                      </TabBarHeightProvider>
                                                      <AnalyticsScreenTracker />
                                                      <OtaUpdateTracker />
                                                    </ShareTargetProvider>
                                                  </DeepLinkProvider>
                                                </DrawerHostProvider>
                                              </BleControlSheetProvider>
                                            </BluetoothProviderWrapper>
                                          </BottomSheetModalProvider>
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
          </QueryProvider>
        </I18nProvider>
      </AnalyticsProvider>
    </GestureHandlerRootView>
  );
}

// Wrap with Sentry so the root and its children report render errors and feed
// the navigation/performance instrumentation. No-op when Sentry is disabled
// (dev / no DSN), so it's safe in every build.
export default wrapWithSentry(RootLayout);

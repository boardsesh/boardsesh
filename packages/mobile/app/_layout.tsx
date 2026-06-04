import { useCallback, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
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
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { QueryProvider } from '../src/providers/query-provider';
import { ThemeProvider, useTheme } from '../src/providers/theme-provider';
import { AuthProvider } from '../src/providers/auth-provider';
import { I18nProvider } from '../src/providers/i18n-provider';
import { BluetoothProvider } from '../src/providers/bluetooth-provider';
import { ToastProvider } from '../src/providers/toast-provider';
import { QueueProvider } from '../src/providers/queue-provider';
import { DrawerHostProvider } from '../src/providers/drawer-host-provider';
import { SessionScreenProvider } from '../src/providers/session-screen-provider';
import { DeepLinkProvider } from '../src/providers/deep-link-provider';
import { SessionScreenHost } from '../src/components/session-screen/SessionScreenHost';
import { FeatureFlagsProvider } from '../src/providers/feature-flags-provider';
import { PartyProfileProvider } from '../src/providers/party-profile-provider';
import { ConnectionSettingsProvider } from '../src/providers/connection-settings-provider';
import { FavoritesProvider } from '../src/providers/favorites-provider';
import { PlaylistsProvider } from '../src/providers/playlists-provider';
import { BoardAdapterWrapper } from '../src/providers/board-adapter';
import { PlaylistsAdapterWrapper } from '../src/providers/playlists-adapter';
import { BoardProvider } from '@boardsesh/board-react';
import { toBoardName } from '@boardsesh/board-config';
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { useMobileClimbActionsData } from '../src/lib/graphql/hooks';
import { useActiveBoard } from '../src/lib/graphql/use-active-board';
import { LiveActivityBridge } from '../src/lib/live-activity/live-activity-bridge';
import { Text } from '../src/components/Text';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { brandColors } from '../src/theme/colors';
import { iosDarkColors } from '../src/theme/ios-colors';
import { spacing } from '../src/theme/tokens';
import { wrapWithSentry, reportError } from '../src/lib/sentry';

SplashScreen.preventAutoHideAsync();

const layoutStyles = StyleSheet.create({
  root: { flex: 1 },
});

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
    router.replace('/(tabs)/boards');
  };

  return (
    <View style={errorStyles.container}>
      <View style={errorStyles.iconContainer}>
        <Icon name="warning" size={48} color={brandColors.warning} />
      </View>
      <Text variant="title2" style={errorStyles.title}>
        Something went wrong
      </Text>
      <Text variant="body" style={errorStyles.message}>
        The app hit an unexpected error. You can try again or head back to your boards.
      </Text>
      <View style={errorStyles.buttonRow}>
        <Button title="Try again" onPress={retry} variant="filled" size="large" />
        <Button title="Go to boards" onPress={handleGoHome} variant="outlined" size="large" />
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

function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();

  if (!activeBoard) {
    return <>{children}</>;
  }

  return (
    <BluetoothProvider boardName={activeBoard.boardType} layoutId={activeBoard.layoutId} sizeId={activeBoard.sizeId}>
      <LiveActivityBridge
        boardName={activeBoard.boardType}
        layoutId={activeBoard.layoutId}
        sizeId={activeBoard.sizeId}
        setIds={activeBoard.setIds}
      />
      {children}
    </BluetoothProvider>
  );
}

// Supplies the active board name to the shared BoardProvider. The API types
// `boardType` as a loose string, so it's validated to a `BoardName | null`.
// A null board keeps logbook fetches idle and makes mutations throw rather
// than send an empty `boardType`.
function BoardProviderWrapper({ children }: { children: ReactNode }) {
  const { data: activeBoard } = useActiveBoard();
  return <BoardProvider boardName={toBoardName(activeBoard?.boardType)}>{children}</BoardProvider>;
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
      {/* Drive the system status-bar icon contrast from the *resolved* scheme
          (honours the in-app appearance override), not "auto" — under Android's
          mandatory edge-to-edge the bar is transparent over app content, so a
          forced dark theme on a light OS must still get light icons. Matches the
          pattern already used in SessionScreenHost.
          Note: the Android 3-button navigation-bar icon contrast is NOT driven
          here — under edge-to-edge that needs react-native-edge-to-edge's
          <SystemBars> (a new native dep), deferred to a device-tested follow-up. */}
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} animated />
      {children}
    </NavigationThemeProvider>
  );
}

function RootLayout() {
  const onAuthReady = useCallback(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={layoutStyles.root}>
      <I18nProvider>
        <QueryProvider>
          <ThemeProvider>
            <FeatureFlagsProvider>
              <AuthProvider onReady={onAuthReady}>
                <PartyProfileProvider>
                  <ConnectionSettingsProvider>
                    <ToastProvider>
                      <ClimbActionsDataWrapper>
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
                                <BottomSheetModalProvider>
                                  <BluetoothProviderWrapper>
                                    <SessionScreenProvider>
                                      <DrawerHostProvider>
                                        <DeepLinkProvider>
                                          <ThemedNavigation>
                                            <Stack screenOptions={{ headerShown: false }} initialRouteName="(tabs)">
                                              <Stack.Screen name="(tabs)" />
                                              <Stack.Screen
                                                name="auth"
                                                options={{ headerShown: false, gestureEnabled: false }}
                                              />
                                              <Stack.Screen name="session/[sessionId]" />
                                              <Stack.Screen
                                                name="join/[sessionId]"
                                                options={{ presentation: 'modal', headerShown: false }}
                                              />
                                            </Stack>
                                          </ThemedNavigation>
                                          <PersistentQueueBar />
                                          <SessionScreenHost />
                                        </DeepLinkProvider>
                                      </DrawerHostProvider>
                                    </SessionScreenProvider>
                                  </BluetoothProviderWrapper>
                                </BottomSheetModalProvider>
                              </BoardProviderWrapper>
                            </PlaylistsAdapterWrapper>
                          </BoardAdapterWrapper>
                        </QueueProvider>
                      </ClimbActionsDataWrapper>
                    </ToastProvider>
                  </ConnectionSettingsProvider>
                </PartyProfileProvider>
              </AuthProvider>
            </FeatureFlagsProvider>
          </ThemeProvider>
        </QueryProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

export default wrapWithSentry(RootLayout);

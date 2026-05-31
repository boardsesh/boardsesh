import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, SplashScreen, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { QueryProvider } from '../src/providers/query-provider';
import { ThemeProvider } from '../src/providers/theme-provider';
import { AuthProvider } from '../src/providers/auth-provider';
import { I18nProvider } from '../src/providers/i18n-provider';
import { BluetoothProvider } from '../src/providers/bluetooth-provider';
import { ToastProvider } from '../src/providers/toast-provider';
import { QueueProvider } from '../src/providers/queue-provider';
import { DrawerHostProvider } from '../src/providers/drawer-host-provider';
import { FeatureFlagsProvider } from '../src/providers/feature-flags-provider';
import { PartyProfileProvider } from '../src/providers/party-profile-provider';
import { ConnectionSettingsProvider } from '../src/providers/connection-settings-provider';
import { FavoritesProvider } from '../src/providers/favorites-provider';
import { PlaylistsProvider } from '../src/providers/playlists-provider';
import { BoardProvider } from '../src/providers/board-provider';
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { useDefaultBoard } from '../src/lib/graphql/hooks';
import { LiveActivityBridge } from '../src/lib/live-activity/live-activity-bridge';
import { Text } from '../src/components/Text';
import { Button } from '../src/components/Button';
import { Icon } from '../src/components/Icon';
import { brandColors } from '../src/theme/colors';
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

function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: defaultBoard } = useDefaultBoard();

  if (!defaultBoard) {
    return <>{children}</>;
  }

  return (
    <BluetoothProvider boardName={defaultBoard.boardType} layoutId={defaultBoard.layoutId} sizeId={defaultBoard.sizeId}>
      <LiveActivityBridge
        boardName={defaultBoard.boardType}
        layoutId={defaultBoard.layoutId}
        sizeId={defaultBoard.sizeId}
        setIds={defaultBoard.setIds}
      />
      {children}
    </BluetoothProvider>
  );
}

function RootLayout() {
  const onAuthReady = useCallback(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={layoutStyles.root}>
      <StatusBar style="auto" />
      <I18nProvider>
        <QueryProvider>
          <ThemeProvider>
            <FeatureFlagsProvider>
              <AuthProvider onReady={onAuthReady}>
                <PartyProfileProvider>
                  <ConnectionSettingsProvider>
                    <ToastProvider>
                      <BottomSheetModalProvider>
                        <FavoritesProvider>
                          <PlaylistsProvider>
                            <QueueProvider>
                              <BoardProvider>
                                <BluetoothProviderWrapper>
                                  <DrawerHostProvider>
                                    <Stack screenOptions={{ headerShown: false }} initialRouteName="(tabs)">
                                      <Stack.Screen name="(tabs)" />
                                      <Stack.Screen
                                        name="auth"
                                        options={{ headerShown: false, gestureEnabled: false }}
                                      />
                                    </Stack>
                                    <PersistentQueueBar />
                                  </DrawerHostProvider>
                                </BluetoothProviderWrapper>
                              </BoardProvider>
                            </QueueProvider>
                          </PlaylistsProvider>
                        </FavoritesProvider>
                      </BottomSheetModalProvider>
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

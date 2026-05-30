import { useCallback, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
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
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { useDefaultBoard } from '../src/lib/graphql/hooks';
import { LiveActivityBridge } from '../src/lib/live-activity/live-activity-bridge';

SplashScreen.preventAutoHideAsync();

const styles = StyleSheet.create({
  root: { flex: 1 },
});

function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: defaultBoard } = useDefaultBoard();

  if (!defaultBoard) {
    // No board selected yet — BLE only makes sense with a board
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

export default function RootLayout() {
  const onAuthReady = useCallback(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
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

import { useCallback, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { Stack, SplashScreen } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { SQLiteProvider } from 'expo-sqlite';
import { QueryProvider } from '../src/providers/query-provider';
import { ThemeProvider } from '../src/providers/theme-provider';
import { AuthProvider } from '../src/providers/auth-provider';
import { I18nProvider } from '../src/providers/i18n-provider';
import { BluetoothProvider } from '../src/providers/bluetooth-provider';
import { ToastProvider } from '../src/providers/toast-provider';
import { QueueProvider } from '../src/providers/queue-provider';
import { DrawerHostProvider } from '../src/providers/drawer-host-provider';
import { PersistentQueueBar } from '../src/components/queue-control/persistent-queue-bar';
import { OfflineSyncBridge } from '../src/components/offline-sync-bridge';
import { useDefaultBoard } from '../src/lib/graphql/hooks';
import { LiveActivityBridge } from '../src/lib/live-activity/live-activity-bridge';
import { DATABASE_NAME, initializeDatabase } from '../src/db';

SplashScreen.preventAutoHideAsync();

// SQLiteProvider's default onError rethrows, which would white-screen the app if
// the on-device DB ever fails to open/migrate. Offline storage is non-essential
// chrome, so swallow the error (logged in dev) and let the app render online-only.
function handleDatabaseError(error: Error): void {
  if (__DEV__) {
    console.warn('[SQLite] database initialization failed; running without local storage:', error);
  }
}

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
          <SQLiteProvider databaseName={DATABASE_NAME} onInit={initializeDatabase} onError={handleDatabaseError}>
            <ThemeProvider>
              <AuthProvider onReady={onAuthReady}>
                <ToastProvider>
                  <BottomSheetModalProvider>
                    <QueueProvider>
                      <BluetoothProviderWrapper>
                        <DrawerHostProvider>
                          <Stack screenOptions={{ headerShown: false }} initialRouteName="(tabs)">
                            <Stack.Screen name="(tabs)" />
                            <Stack.Screen name="auth" options={{ headerShown: false, gestureEnabled: false }} />
                          </Stack>
                          <PersistentQueueBar />
                          <OfflineSyncBridge />
                        </DrawerHostProvider>
                      </BluetoothProviderWrapper>
                    </QueueProvider>
                  </BottomSheetModalProvider>
                </ToastProvider>
              </AuthProvider>
            </ThemeProvider>
          </SQLiteProvider>
        </QueryProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

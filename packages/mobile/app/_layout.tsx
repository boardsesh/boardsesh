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
import { useEffectiveDefaultBoard } from '../src/lib/hooks/use-effective-default-board';

SplashScreen.preventAutoHideAsync();

const styles = StyleSheet.create({
  root: { flex: 1 },
});

function BluetoothProviderWrapper({ children }: { children: ReactNode }) {
  const { data: defaultBoard } = useEffectiveDefaultBoard();

  if (!defaultBoard) {
    return <>{children}</>;
  }

  return (
    <BluetoothProvider boardName={defaultBoard.boardType} layoutId={defaultBoard.layoutId} sizeId={defaultBoard.sizeId}>
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
            <AuthProvider onReady={onAuthReady}>
              <ToastProvider>
                <BottomSheetModalProvider>
                  <QueueProvider>
                    <BluetoothProviderWrapper>
                      <Stack screenOptions={{ headerShown: false }} initialRouteName="(tabs)">
                        <Stack.Screen name="(tabs)" />
                        <Stack.Screen name="auth" options={{ headerShown: false, gestureEnabled: false }} />
                      </Stack>
                    </BluetoothProviderWrapper>
                  </QueueProvider>
                </BottomSheetModalProvider>
              </ToastProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryProvider>
      </I18nProvider>
    </GestureHandlerRootView>
  );
}

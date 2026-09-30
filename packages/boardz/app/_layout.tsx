import { useState } from 'react';
import { StyleSheet, useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, type Theme as NavigationTheme } from 'expo-router';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../src/auth/auth-provider';
import { BoardProvider } from '../src/board/board-provider';
import { BluetoothProvider } from '../src/ble/bluetooth-provider';
import { ClimbFiltersProvider } from '../src/climbs/climb-filters-provider';
import { ClimbSequenceProvider } from '../src/climbs/climb-sequence';
import { ListsProvider } from '../src/lists/lists-provider';
import { SessionProvider } from '../src/session/session-provider';
import { PreferencesProvider } from '../src/settings/preferences-provider';
import { WorkoutProvider } from '../src/workout/workout-provider';
import { FONT_FILES } from '../src/ui/fonts';
import { darkTheme, lightTheme, type Theme } from '../src/ui/theme';
import { ToastProvider } from '../src/ui/Toast';

function navigationTheme(base: NavigationTheme, theme: Theme): NavigationTheme {
  return {
    ...base,
    colors: {
      ...base.colors,
      primary: theme.accent,
      background: theme.bgApp,
      card: theme.bgApp,
      text: theme.fg1,
      border: theme.border2,
    },
  };
}

// Without these, React Navigation's own light background shows behind every
// screen in dark mode.
const lightNavigation = navigationTheme(DefaultTheme, lightTheme);
const darkNavigation = navigationTheme(DarkTheme, darkTheme);

// Every screen draws its own header (PageHeader, TopBar or SheetHeader).
const SHEET = { presentation: 'formSheet', sheetGrabberVisible: true, sheetCornerRadius: 20 } as const;

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, staleTime: 30_000 },
    },
  });
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [queryClient] = useState(createQueryClient);
  const [fontsLoaded] = useFonts(FONT_FILES);

  // A moment at launch while Geist loads, instead of a flash of the system font.
  if (!fontsLoaded) return null;

  return (
    <GestureHandlerRootView style={styles.root}>
      <QueryClientProvider client={queryClient}>
        <PreferencesProvider>
          <AuthProvider>
            <BoardProvider>
              <BluetoothProvider>
                <SessionProvider>
                  <ClimbFiltersProvider>
                    <ClimbSequenceProvider>
                      <ListsProvider>
                        <WorkoutProvider>
                          <ThemeProvider value={colorScheme === 'dark' ? darkNavigation : lightNavigation}>
                            <ToastProvider>
                              <Stack screenOptions={{ headerShown: false }}>
                                <Stack.Screen name="(tabs)" />
                                <Stack.Screen name="climb/[uuid]" />
                                {/* A stray swipe mid-set shouldn't leave the runner. */}
                                <Stack.Screen name="workout-run" options={{ gestureEnabled: false }} />
                                <Stack.Screen name="log" options={{ ...SHEET, sheetAllowedDetents: [0.85, 1] }} />
                                <Stack.Screen name="login" options={{ ...SHEET, sheetAllowedDetents: [0.8, 1] }} />
                                <Stack.Screen name="board-setup" options={{ presentation: 'modal' }} />
                                <Stack.Screen name="connect" options={{ ...SHEET, sheetAllowedDetents: [0.6, 1] }} />
                                <Stack.Screen name="filters" options={{ ...SHEET, sheetAllowedDetents: [0.85, 1] }} />
                                <Stack.Screen name="save" options={{ ...SHEET, sheetAllowedDetents: [0.6, 1] }} />
                                <Stack.Screen name="beta" options={{ ...SHEET, sheetAllowedDetents: [0.75, 1] }} />
                                <Stack.Screen
                                  name="session-summary"
                                  options={{ ...SHEET, sheetAllowedDetents: [0.75, 1] }}
                                />
                              </Stack>
                            </ToastProvider>
                          </ThemeProvider>
                        </WorkoutProvider>
                      </ListsProvider>
                    </ClimbSequenceProvider>
                  </ClimbFiltersProvider>
                </SessionProvider>
              </BluetoothProvider>
            </BoardProvider>
          </AuthProvider>
        </PreferencesProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

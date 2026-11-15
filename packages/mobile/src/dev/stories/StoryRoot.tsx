import { LayoutObserverProvider } from '../../lib/showcase-anchor';
import { reportLayoutObservation } from '../integration/layout-reporting';
import { GradeFormatProvider } from '../../hooks/use-grade-format';
import 'intl-pluralrules';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Stack, SplashScreen, useGlobalSearchParams, useSitemap, type ErrorBoundaryProps } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BottomSheetModalProvider } from '@expo/ui/community/bottom-sheet';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { DEFAULT_NAMESPACE, MOBILE_NAMESPACES, isSupportedLocale } from '@boardsesh/i18n';
import { isThemeOverride, isUiVariantPreference } from '@boardsesh/key-value-storage';
import { NavigationEntryProvider } from '../../providers/navigation-entry-provider';
import { ThemedNavigation } from '../../providers/navigation-theme-provider';
import { setRelativeTimeLocale } from '@boardsesh/profile-stats';
import { ThemeProvider } from '../../providers/theme-provider';
import { MaterialThemeProvider } from '../../providers/material-theme-provider';
import { DialogProvider } from '../../providers/dialog-provider';
import { SheetPresentationProvider } from '../../providers/sheet-presentation-provider';
import { resources } from '../../lib/i18n/catalogs';
import { loadRequiredFonts } from '../../lib/required-fonts';
import { StoryRenderModeContext, parseStoryRenderMode } from '../fixtures/board-render-style';
import { storyRouteName } from './story-route-name';

const styles = StyleSheet.create({ fill: { flex: 1 } });

function firstParam(parameter: string | string[] | undefined): string | undefined {
  return Array.isArray(parameter) ? parameter[0] : parameter;
}

/** A navigator with the app's presentation infrastructure, without its services. */
export default function StoryRoot() {
  const params = useGlobalSearchParams<{ theme?: string; variant?: string; locale?: string; renderMode?: string }>();
  const theme = firstParam(params.theme) ?? process.env.EXPO_PUBLIC_SCREENSHOT_THEME ?? 'dark';
  const variant = firstParam(params.variant) ?? process.env.EXPO_PUBLIC_SCREENSHOT_VARIANT ?? 'auto';
  const locale = firstParam(params.locale) ?? process.env.EXPO_PUBLIC_SCREENSHOT_LOCALE ?? 'en-US';
  const renderMode = parseStoryRenderMode(
    firstParam(params.renderMode) ?? process.env.EXPO_PUBLIC_STORY_RENDER_MODE ?? 'aura',
  );
  const [fontsReady, setFontsReady] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const sitemap = useSitemap();
  const localeInstance = useMemo(() => {
    const instance = createInstance();
    void instance.use(initReactI18next).init({
      resources,
      lng: isSupportedLocale(locale) ? locale : 'en-US',
      fallbackLng: 'en-US',
      defaultNS: DEFAULT_NAMESPACE,
      ns: [...MOBILE_NAMESPACES],
      initAsync: false,
      interpolation: { escapeValue: false },
    });
    return instance;
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    void loadRequiredFonts().then(
      () => {
        if (!cancelled) setFontsReady(true);
      },
      (error: unknown) => {
        if (!cancelled) setFailure(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!fontsReady) return;
    void SplashScreen.hideAsync();
    // eslint-disable-next-line no-console
    console.log('[stories] root ready');
  }, [fontsReady]);

  useEffect(() => {
    setRelativeTimeLocale(isSupportedLocale(locale) ? locale : 'en-US');
  }, [locale]);

  if (failure) throw failure;
  if (!fontsReady) return null;

  const applicationRoutes = (sitemap?.children ?? [])
    .map(({ contextKey }) => storyRouteName(contextKey))
    .filter((name) => !name.startsWith('dev/stories/') && name !== 'dev/story-tabs' && name !== 'index');

  return (
    <LayoutObserverProvider onLayoutObserved={reportLayoutObservation}>
      <GestureHandlerRootView style={styles.fill}>
        <SafeAreaProvider>
          <I18nextProvider i18n={localeInstance}>
            <ThemeProvider
              key={`${theme}:${variant}`}
              preferences={null}
              initialTheme={isThemeOverride(theme) ? theme : 'dark'}
              initialVariant={isUiVariantPreference(variant) ? variant : 'auto'}
            >
              <StoryRenderModeContext.Provider value={renderMode}>
                <GradeFormatProvider gradeFormat="v-grade">
                  <MaterialThemeProvider>
                    <DialogProvider>
                      <SheetPresentationProvider>
                        <BottomSheetModalProvider>
                          <ThemedNavigation>
                            <NavigationEntryProvider href="/dev/stories">
                              <Stack screenOptions={{ headerShown: false }}>
                                <Stack.Screen name="index" />
                                <Stack.Screen name="dev/stories/index" />
                                <Stack.Screen name="dev/stories/[id]" />
                                <Stack.Screen name="dev/story-tabs" />
                                <Stack.Protected guard={false} redirectTo="/dev/stories">
                                  {applicationRoutes.map((name) => (
                                    <Stack.Screen key={name} name={name} />
                                  ))}
                                </Stack.Protected>
                              </Stack>
                            </NavigationEntryProvider>
                          </ThemedNavigation>
                        </BottomSheetModalProvider>
                      </SheetPresentationProvider>
                    </DialogProvider>
                  </MaterialThemeProvider>
                </GradeFormatProvider>
              </StoryRenderModeContext.Provider>
            </ThemeProvider>
          </I18nextProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </LayoutObserverProvider>
  );
}

/** Story failures never initialize production error reporters or app services. */
export function StoryRootErrorBoundary({ error }: ErrorBoundaryProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(`[stories] error root ${error.message}`);
    void SplashScreen.hideAsync();
  }, [error]);
  return (
    <View>
      <Text accessibilityRole="alert">{error.message}</Text>
    </View>
  );
}

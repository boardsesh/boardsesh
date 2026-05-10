// app/layout.tsx
import React from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import ColorModeProvider from './components/providers/color-mode-provider';
import { AnalyticsProviders } from './components/analytics-providers';
import SessionProviderWrapper from './components/providers/session-provider';
import QueryClientProvider from './components/providers/query-client-provider';
import { NavigationLoadingProvider } from './components/providers/navigation-loading-provider';
import PersistentSessionWrapper from './components/providers/persistent-session-wrapper';
import { SnackbarProvider } from './components/providers/snackbar-provider';
import { AuthModalProvider } from './components/providers/auth-modal-provider';
import { NotificationSubscriptionManager } from './components/providers/notification-subscription-manager';
import I18nProvider from './components/providers/i18n-provider';
import { VercelToolbar } from '@vercel/toolbar/next';
import { getAllBoardConfigs } from './lib/server-board-configs';
import { EMPTY_FEATURE_FLAGS } from './flags';
import { FeatureFlagsProvider } from './components/providers/feature-flags-provider';
import { OnboardingTourProvider } from './components/onboarding/onboarding-tour-provider';
import OnboardingTourOverlay from './components/onboarding/onboarding-tour-overlay';
import OnboardingDummySeshMount from './components/onboarding/onboarding-dummy-sesh-mount';
import { getLocale } from './lib/i18n/get-locale';
import { getServerTranslation } from './lib/i18n/server';
import { LOCALE_HTML_LANG, LOCALE_OG } from './lib/i18n/config';
import { SITE_URL } from './lib/seo/base-url';
import './components/index.css';
import type { Viewport, Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
  const { t, locale } = await getServerTranslation('marketing');
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: t('metadata.home.title'),
      template: '%s | Boardsesh',
    },
    description: t('metadata.home.description'),
    openGraph: {
      type: 'website',
      siteName: 'Boardsesh',
      locale: LOCALE_OG[locale],
    },
    twitter: {
      card: 'summary_large_image',
    },
    icons: {
      icon: [
        { url: '/favicon.ico', sizes: '32x32' },
        { url: '/icon.svg', type: 'image/svg+xml' },
      ],
      apple: '/icons/apple-touch-icon.png',
    },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  // Match Mobile Safari behavior on Android: keyboard overlays the page
  // without resizing the layout viewport, so 100dvh and position:fixed
  // bottom bars stay anchored when an input is focused.
  interactiveWidget: 'resizes-visual',
  themeColor: '#101012',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [boardConfigs, locale] = await Promise.all([getAllBoardConfigs(), getLocale()]);

  return (
    <html lang={LOCALE_HTML_LANG[locale]} data-theme="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <AnalyticsProviders />
        <QueryClientProvider>
          <SessionProviderWrapper>
            <AppRouterCacheProvider>
              <ColorModeProvider>
                <I18nProvider
                  locale={locale}
                  namespaces={['common', 'playlists', 'session', 'auth', 'settings', 'boards', 'climbs']}
                >
                  <SnackbarProvider>
                    <AuthModalProvider>
                      <FeatureFlagsProvider flags={EMPTY_FEATURE_FLAGS}>
                        <PersistentSessionWrapper boardConfigs={boardConfigs}>
                          <NavigationLoadingProvider>
                            <OnboardingTourProvider>
                              <NotificationSubscriptionManager>{children}</NotificationSubscriptionManager>
                              <OnboardingTourOverlay />
                              <OnboardingDummySeshMount />
                            </OnboardingTourProvider>
                          </NavigationLoadingProvider>
                        </PersistentSessionWrapper>
                      </FeatureFlagsProvider>
                    </AuthModalProvider>
                  </SnackbarProvider>
                </I18nProvider>
              </ColorModeProvider>
            </AppRouterCacheProvider>
          </SessionProviderWrapper>
        </QueryClientProvider>
        {process.env.NODE_ENV === 'development' && <VercelToolbar />}
      </body>
    </html>
  );
}

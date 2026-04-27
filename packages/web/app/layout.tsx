// app/layout.tsx
import React, { Suspense } from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import ColorModeProvider from './components/providers/color-mode-provider';
import AnalyticsClient from './components/analytics-client';
import SessionProviderWrapper from './components/providers/session-provider';
import QueryClientProvider from './components/providers/query-client-provider';
import { NavigationLoadingProvider } from './components/providers/navigation-loading-provider';
import PersistentSessionWrapper from './components/providers/persistent-session-wrapper';
import { SnackbarProvider } from './components/providers/snackbar-provider';
import { AuthModalProvider } from './components/providers/auth-modal-provider';
import { NotificationSubscriptionManager } from './components/providers/notification-subscription-manager';
import { VercelToolbar } from '@vercel/toolbar/next';
import { getAllBoardConfigs } from './lib/server-board-configs';
import { EMPTY_FEATURE_FLAGS } from './flags';
import { FeatureFlagsProvider } from './components/providers/feature-flags-provider';
import { OnboardingTourProvider } from './components/onboarding/onboarding-tour-provider';
import OnboardingTourOverlay from './components/onboarding/onboarding-tour-overlay';
import OnboardingDummySeshMount from './components/onboarding/onboarding-dummy-sesh-mount';
import './components/index.css';
import type { Viewport, Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL('https://www.boardsesh.com'),
  title: {
    default: 'Boardsesh - Train smarter on your climbing board',
    template: '%s | Boardsesh',
  },
  description: 'Track your sends across Kilter, Tension, and MoonBoard. One app for your boards.',
  openGraph: {
    type: 'website',
    siteName: 'Boardsesh',
    locale: 'en_US',
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

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#101012',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const boardConfigs = await getAllBoardConfigs();

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Suspense fallback={null}>
          <AnalyticsClient />
        </Suspense>
        <QueryClientProvider>
          <SessionProviderWrapper>
            <AppRouterCacheProvider>
              <ColorModeProvider>
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
              </ColorModeProvider>
            </AppRouterCacheProvider>
          </SessionProviderWrapper>
        </QueryClientProvider>
        {process.env.NODE_ENV === 'development' && <VercelToolbar />}
      </body>
    </html>
  );
}

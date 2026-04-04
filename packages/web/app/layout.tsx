// app/layout.tsx
import React from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import ColorModeProvider from './components/providers/color-mode-provider';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/next';
import SessionProviderWrapper from './components/providers/session-provider';
import QueryClientProvider from './components/providers/query-client-provider';
import { NavigationLoadingProvider } from './components/providers/navigation-loading-provider';
import PersistentSessionWrapper from './components/providers/persistent-session-wrapper';
import { SnackbarProvider } from './components/providers/snackbar-provider';
import { NotificationSubscriptionManager } from './components/providers/notification-subscription-manager';
import { VercelToolbar } from '@vercel/toolbar/next';
import { getAllBoardConfigs } from './lib/server-board-configs';
import { EMPTY_FEATURE_FLAGS } from './flags';
import { FeatureFlagsProvider } from './components/providers/feature-flags-provider';
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
    icon: '/favicon.ico',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0A0A0A',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const boardConfigs = await getAllBoardConfigs();

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <Analytics />
        <QueryClientProvider>
          <SessionProviderWrapper>
            <AppRouterCacheProvider>
              <ColorModeProvider>
                <SnackbarProvider>
                  <FeatureFlagsProvider flags={EMPTY_FEATURE_FLAGS}>
                    <PersistentSessionWrapper boardConfigs={boardConfigs}>
                      <NavigationLoadingProvider>
                        <NotificationSubscriptionManager>{children}</NotificationSubscriptionManager>
                      </NavigationLoadingProvider>
                    </PersistentSessionWrapper>
                  </FeatureFlagsProvider>
                </SnackbarProvider>
              </ColorModeProvider>
            </AppRouterCacheProvider>
          </SessionProviderWrapper>
        </QueryClientProvider>
        <SpeedInsights />
        {process.env.NODE_ENV === 'development' && <VercelToolbar />}
      </body>
    </html>
  );
}

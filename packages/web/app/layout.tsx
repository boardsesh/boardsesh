// app/layout.tsx
import React, { Suspense } from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import ColorModeProvider from './components/providers/color-mode-provider';
import AnalyticsClient from './components/analytics-client';
import AnalyticsIdentity from './components/providers/analytics-identity';
import SessionProviderWrapper from './components/providers/session-provider';
import QueryClientProvider from './components/providers/query-client-provider';
import SiteChrome from './components/providers/site-chrome';
import { SnackbarProvider } from './components/providers/snackbar-provider';
import { AuthModalProvider } from './components/providers/auth-modal-provider';
import I18nProvider from './components/providers/i18n-provider';
import { CNC_PACKS_FLAG, EMPTY_FEATURE_FLAGS } from './flags';
import { FeatureFlagsProvider } from './components/providers/feature-flags-provider';
import CapacitorRetirementGate from './components/capacitor-retirement/capacitor-retirement-gate';
import { getServerFeatureFlag } from './lib/feature-flags/server-feature-flag';
import { getLocale } from './lib/i18n/get-locale';
import { getServerTranslation } from './lib/i18n/server';
import { LOCALE_HTML_LANG, LOCALE_OG } from './lib/i18n/config';
import { SITE_URL } from './lib/seo/base-url';
import { THEME_INIT_SCRIPT } from './theme/theme-init-script';
import { resolveShellStaticAssetUrl } from './lib/shell-static-asset-url';
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
        { url: resolveShellStaticAssetUrl('/favicon.ico'), sizes: '32x32' },
        { url: resolveShellStaticAssetUrl('/icon.png'), type: 'image/png' },
      ],
      apple: resolveShellStaticAssetUrl('/icons/apple-touch-icon.png'),
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
  themeColor: '#15101e',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  // Whether the footer offers a way into /build-plans. Resolved on the server
  // because SiteFooter renders in the first paint of every page and a link that
  // pops in after the browser resolves a flag is worse than no link.
  //
  // `distinctId: null` with `allowAnonymous: true`, NOT the signed-in person's
  // id, and that is a deliberate trade: `getPosthogDistinctId` reads the
  // next-auth session, and doing that in the ROOT layout would put a session
  // decode in front of every render of every page on the site for one footer
  // link. The anonymous bucket is a single shared distinct id, so this is one
  // cached answer for everyone — right for a percentage rollout, and it means a
  // rollout targeted at one PERSON hides the footer link from them while
  // /build-plans itself still opens. The page's own gate resolves the real
  // distinct id (see build-plans-page.ts) and is what actually decides
  // reachability.
  const showBuildPlans = await getServerFeatureFlag(CNC_PACKS_FLAG, { distinctId: null, allowAnonymous: true });

  return (
    <html lang={LOCALE_HTML_LANG[locale]} data-theme="dark" suppressHydrationWarning>
      <head>
        {/* Runs before first paint to correct data-theme from the saved
            preference (or OS setting for new visitors), so light-theme users
            don't get a dark flash. data-theme="dark" above is the SSR default;
            suppressHydrationWarning on <html> covers the attribute swap. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly, 1Password)
          inject attributes onto <body> at runtime — unrelated to the theme swap
          on <html>. */}
      <body suppressHydrationWarning>
        <Suspense fallback={null}>
          <AnalyticsClient />
        </Suspense>
        {/* QueryClientProvider sits inside SessionProviderWrapper so its
            PersistQueryClientProvider can read useSession() — do not reorder. */}
        <SessionProviderWrapper enableExpoAuthBridge={process.env.BOARDSESH_WEB === '1'}>
          {/* Reads useSession() to tell PostHog which person this browser is,
              so it has to sit inside SessionProviderWrapper — AnalyticsClient
              above cannot host it. Renders nothing. */}
          <AnalyticsIdentity />
          <QueryClientProvider>
            <AppRouterCacheProvider>
              <ColorModeProvider>
                <I18nProvider
                  locale={locale}
                  namespaces={[
                    'common',
                    'playlists',
                    'session',
                    'auth',
                    'settings',
                    'boards',
                    'climbs',
                    'profile',
                    'feed',
                  ]}
                >
                  <SnackbarProvider>
                    {/* Everything below is torn down inside the retired
                        Capacitor app, which gets a dead-end update screen. */}
                    <CapacitorRetirementGate>
                      <AuthModalProvider>
                        <FeatureFlagsProvider flags={EMPTY_FEATURE_FLAGS}>
                          <SiteChrome showBuildPlans={showBuildPlans}>{children}</SiteChrome>
                        </FeatureFlagsProvider>
                      </AuthModalProvider>
                    </CapacitorRetirementGate>
                  </SnackbarProvider>
                </I18nProvider>
              </ColorModeProvider>
            </AppRouterCacheProvider>
          </QueryClientProvider>
        </SessionProviderWrapper>
      </body>
    </html>
  );
}

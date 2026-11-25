'use client';

import React, { Suspense } from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import AppThemeProvider from '@/app/components/providers/app-theme-provider';
import AnalyticsClient from '@/app/components/analytics-client';
import AdPixelsClient from '@/app/components/ad-pixels-client';
import { ConsentProvider } from '@/app/components/consent/consent-provider';
import AnalyticsIdentity from '@/app/components/providers/analytics-identity';
import SessionProviderWrapper from '@/app/components/providers/session-provider';
import QueryClientProvider from '@/app/components/providers/query-client-provider';
import SiteChrome from '@/app/components/providers/site-chrome';
import { SnackbarProvider } from '@/app/components/providers/snackbar-provider';
import { AuthModalProvider } from '@/app/components/providers/auth-modal-provider';
import { I18nProvider } from '@/app/lib/i18n/client';
import { EMPTY_FEATURE_FLAGS } from '@/app/flags';
import { FeatureFlagsProvider } from '@/app/components/providers/feature-flags-provider';
import CapacitorRetirementGate from '@/app/components/capacitor-retirement/capacitor-retirement-gate';
import type { Locale } from '@/app/lib/i18n/config';
import type { MarketingBrowser } from '@/app/lib/marketing-platform';
import { MarketingPreviewProvider } from '@/app/components/marketing/marketing-preview-provider';

export type ApplicationProviderStackProps = {
  children: React.ReactNode;
  locale: Locale;
  resources: Record<string, Record<string, unknown>>;
  initialBrowser: MarketingBrowser;
  sharesMarketingHtml: boolean;
  developerHref: '/developers' | '/docs';
  devEditor: React.ReactNode;
  enableExpoAuthBridge: boolean;
};

/** Application root only: marketing routes have a separate document and client graph. */
export default function ApplicationProviderStack({
  children,
  locale,
  resources,
  initialBrowser,
  sharesMarketingHtml,
  developerHref,
  devEditor,
  enableExpoAuthBridge,
}: ApplicationProviderStackProps) {
  return (
    <SessionProviderWrapper enableExpoAuthBridge={enableExpoAuthBridge}>
      <QueryClientProvider>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nProvider locale={locale} resources={resources}>
              <ConsentProvider>
                {devEditor}
                <Suspense fallback={null}>
                  <AnalyticsIdentity />
                  <AnalyticsClient />
                  <AdPixelsClient />
                </Suspense>
                <SnackbarProvider>
                  {/* Everything below is torn down inside the retired
                        Capacitor app, which gets a dead-end update screen. */}
                  <CapacitorRetirementGate>
                    <AuthModalProvider>
                      <FeatureFlagsProvider flags={EMPTY_FEATURE_FLAGS}>
                        <MarketingPreviewProvider initialBrowser={initialBrowser} sharedHtml={sharesMarketingHtml}>
                          <SiteChrome developerHref={developerHref}>{children}</SiteChrome>
                        </MarketingPreviewProvider>
                      </FeatureFlagsProvider>
                    </AuthModalProvider>
                  </CapacitorRetirementGate>
                </SnackbarProvider>
              </ConsentProvider>
            </I18nProvider>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </QueryClientProvider>
    </SessionProviderWrapper>
  );
}

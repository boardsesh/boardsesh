import React from 'react';
import localFont from 'next/font/local';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import AppThemeProvider from '@/app/components/providers/app-theme-provider';
import CapacitorRetirementGate from '@/app/components/capacitor-retirement/capacitor-retirement-gate';
import I18nProvider from '@/app/components/providers/i18n-provider';
import { MarketingPreviewProvider } from './marketing-preview-provider';
import { MarketingRuntime } from './marketing-runtime';
import MarketingChrome from './marketing-chrome';
import { CONSENT_PREPAINT_SCRIPT } from '@/app/lib/consent';
import { LOCALE_HTML_LANG, type Locale } from '@/app/lib/i18n/config';
import { classifyMarketingBrowser, type MarketingBrowser } from '@/app/lib/marketing-platform';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { BUILD_RELEASE } from '@/app/api/health/build-release';
import { devEditorHostnames } from '@/app/lib/i18n/dev-editor';
import '@/app/components/index.css';

const displayFont = localFont({
  src: '../../fonts/GeistVF.woff',
  variable: '--font-display',
  display: 'swap',
  preload: true,
});

/** This document's render inputs are public build data plus an explicit locale. */
export default async function MarketingDocument({
  children,
  locale,
  initialBrowser = classifyMarketingBrowser(''),
  sharedHtml = true,
}: {
  children: React.ReactNode;
  locale: Locale;
  initialBrowser?: MarketingBrowser;
  sharedHtml?: boolean;
}) {
  const DevTranslationEditor =
    process.env.NODE_ENV === 'development'
      ? (await import('@/app/components/i18n/dev-translation-editor')).default
      : null;
  const assetOrigin = process.env.NEXT_PUBLIC_NEXT_ASSET_BASE_URL;
  const developerHref = getDeveloperDocsState() === 'unavailable' ? '/docs' : '/developers';
  return (
    <html className={displayFont.variable} lang={LOCALE_HTML_LANG[locale]} data-theme="dark" suppressHydrationWarning>
      <head>
        {assetOrigin ? <link rel="preconnect" href={assetOrigin} crossOrigin="anonymous" /> : null}
        <meta name="boardsesh-release" content={BUILD_RELEASE} />
        <script dangerouslySetInnerHTML={{ __html: CONSENT_PREPAINT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <I18nProvider
              locale={locale}
              namespaces={
                process.env.NODE_ENV === 'development' ? ['common', 'consent', 'devTools'] : ['common', 'consent']
              }
            >
              <MarketingRuntime enableExpoAuthBridge={process.env.BOARDSESH_WEB === '1'}>
                {DevTranslationEditor ? (
                  <DevTranslationEditor
                    key={locale}
                    locale={locale}
                    allowedHostnames={devEditorHostnames(process.env.DEV_ALLOWED_ORIGINS)}
                  />
                ) : null}
                <CapacitorRetirementGate>
                  <MarketingPreviewProvider initialBrowser={initialBrowser} sharedHtml={sharedHtml}>
                    <MarketingChrome locale={locale} developerHref={developerHref}>
                      {children}
                    </MarketingChrome>
                  </MarketingPreviewProvider>
                </CapacitorRetirementGate>
              </MarketingRuntime>
            </I18nProvider>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}

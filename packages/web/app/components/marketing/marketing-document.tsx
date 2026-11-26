import React from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import AppThemeProvider from '@/app/components/providers/app-theme-provider';
import CapacitorRetirementGate from '@/app/components/capacitor-retirement/capacitor-retirement-gate';
import { DocumentLocaleProvider } from '@/app/lib/i18n/document-locale-context';
import { getServerTranslationForLocale } from '@/app/lib/i18n/server';
import { MarketingPreviewProvider } from './marketing-preview-provider';
import { MarketingRuntime } from './marketing-runtime';
import MarketingChrome from './marketing-chrome';
import { CONSENT_PREPAINT_SCRIPT } from '@/app/lib/consent';
import { LOCALE_HTML_LANG, type Locale } from '@/app/lib/i18n/config';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { BUILD_RELEASE } from '@/app/api/health/build-release';
import { devEditorHostnames } from '@/app/lib/i18n/dev-editor';
import '@/app/components/index.css';
import styles from './marketing-document.module.css';

/** This document's render inputs are public build data plus an explicit locale. */
export default async function MarketingDocument({ children, locale }: { children: React.ReactNode; locale: Locale }) {
  const DevTranslationEditor =
    process.env.NODE_ENV === 'development'
      ? (await import('@/app/components/i18n/dev-translation-editor')).default
      : null;
  const assetOrigin = process.env.NEXT_PUBLIC_NEXT_ASSET_BASE_URL;
  const { t: common } = await getServerTranslationForLocale(locale, 'common');
  const retirementCopy = {
    title: common('capacitorRetirement.title'),
    description: common('capacitorRetirement.description'),
    cta: common('capacitorRetirement.cta'),
    fallbackCta: common('capacitorRetirement.fallbackCta'),
  };
  const devEditor = DevTranslationEditor ? (
    <DevTranslationEditor
      key={locale}
      locale={locale}
      allowedHostnames={devEditorHostnames(process.env.DEV_ALLOWED_ORIGINS)}
    />
  ) : null;
  // Development-only translation editing uses the full catalog provider.
  const editor = devEditor
    ? React.createElement((await import('@/app/components/providers/i18n-provider')).default, {
        locale,
        namespaces: ['common', 'consent', 'devTools'],
        children: devEditor,
      })
    : null;
  return (
    <html className={styles.displayFonts} lang={LOCALE_HTML_LANG[locale]} data-theme="dark" suppressHydrationWarning>
      <head>
        {assetOrigin ? <link rel="preconnect" href={assetOrigin} crossOrigin="anonymous" /> : null}
        <meta name="boardsesh-release" content={BUILD_RELEASE} />
        <script dangerouslySetInnerHTML={{ __html: CONSENT_PREPAINT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
        <AppRouterCacheProvider>
          <AppThemeProvider>
            <DocumentLocaleProvider locale={locale}>
              <MarketingRuntime>
                {editor}
                <CapacitorRetirementGate copy={retirementCopy}>
                  <MarketingPreviewProvider initialBrowser={classifyMarketingBrowser('')} sharedHtml>
                    <MarketingChrome locale={locale} developerHref="/docs">
                      {children}
                    </MarketingChrome>
                  </MarketingPreviewProvider>
                </CapacitorRetirementGate>
              </MarketingRuntime>
            </DocumentLocaleProvider>
          </AppThemeProvider>
        </AppRouterCacheProvider>
      </body>
    </html>
  );
}

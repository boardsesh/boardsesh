import React from 'react';
import localFont from 'next/font/local';
import ApplicationProviderStack from './application-provider-stack';
import { CONSENT_PREPAINT_SCRIPT } from '@/app/lib/consent';
import { getDeveloperDocsState } from '@/app/lib/developer-apps/docs-access';
import { devEditorHostnames } from '@/app/lib/i18n/dev-editor';
import { LOCALE_HTML_LANG, ROOT_NAMESPACES, type Locale } from '@/app/lib/i18n/config';
import { classifyMarketingBrowser } from '@/app/lib/marketing-platform';
import { loadServerResources } from '@/app/lib/i18n/server';
import '@/app/components/index.css';

const displayFont = localFont({
  src: '../../fonts/GeistVF.woff',
  variable: '--font-display',
  display: 'swap',
  preload: true,
});

export default async function ApplicationDocument({
  children,
  locale,
  requestHeaders,
}: {
  children: React.ReactNode;
  locale: Locale;
  requestHeaders: Headers;
}) {
  const DevTranslationEditor =
    process.env.NODE_ENV === 'development'
      ? (await import('@/app/components/i18n/dev-translation-editor')).default
      : null;
  const resources = await loadServerResources(
    locale,
    process.env.NODE_ENV === 'development' ? [...ROOT_NAMESPACES, 'devTools'] : ROOT_NAMESPACES,
  );
  const assetOrigin = process.env.NEXT_PUBLIC_NEXT_ASSET_BASE_URL;
  const developerHref = getDeveloperDocsState() === 'unavailable' ? '/docs' : '/developers';
  return (
    <html className={displayFont.variable} lang={LOCALE_HTML_LANG[locale]} data-theme="dark" suppressHydrationWarning>
      <head>
        {assetOrigin ? <link rel="preconnect" href={assetOrigin} crossOrigin="anonymous" /> : null}
        <script dangerouslySetInnerHTML={{ __html: CONSENT_PREPAINT_SCRIPT }} />
      </head>
      <body suppressHydrationWarning>
        <ApplicationProviderStack
          locale={locale}
          enableExpoAuthBridge={process.env.BOARDSESH_WEB === '1'}
          resources={resources}
          initialBrowser={classifyMarketingBrowser(requestHeaders.get('user-agent') ?? '')}
          sharesMarketingHtml={false}
          developerHref={developerHref}
          devEditor={
            DevTranslationEditor ? (
              <DevTranslationEditor
                key={locale}
                locale={locale}
                allowedHostnames={devEditorHostnames(process.env.DEV_ALLOWED_ORIGINS)}
              />
            ) : null
          }
        >
          {children}
        </ApplicationProviderStack>
      </body>
    </html>
  );
}

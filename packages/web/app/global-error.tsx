'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useState } from 'react';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, type Locale } from '@/app/lib/i18n/config';

// This is a Next.js root error boundary that renders when the root layout itself
// fails. It lives outside the normal provider tree, so we can't rely on
// I18nProvider here. Instead we read the locale prefix off the URL on the
// client and look up copy from this small inline map. The same strings are
// mirrored in `errors.json#globalError.*` for nested error boundaries that DO
// have access to i18n — keep them in sync. The `Record<Locale, ...>` type
// guarantees a TS error when a new locale is added to SUPPORTED_LOCALES
// without a matching entry here.
const COPY: Record<Locale, { htmlLang: string; title: string; subtitle: string; reload: string }> = {
  'en-US': {
    htmlLang: 'en',
    title: 'Something went wrong',
    subtitle: 'Try reloading to get back on track',
    reload: 'Reload app',
  },
  es: {
    htmlLang: 'es',
    title: 'Algo salió mal',
    subtitle: 'Recarga para volver a la pared',
    reload: 'Recargar',
  },
  fr: {
    htmlLang: 'fr',
    title: "Quelque chose s'est mal passé",
    subtitle: 'Essayez de recharger pour repartir du bon pied',
    reload: "Recharger l'app",
  },
};

function detectLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE;
  const { pathname } = window.location;
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const prefix = `/${locale}`;
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return locale;
  }
  return DEFAULT_LOCALE;
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Lazy initializer reads window.location on the client so /es/* renders
  // Spanish copy after hydration. App Router still SSRs this client component:
  // the server pass returns en-US (window is undefined), then the client
  // initializer returns es for /es/*. The mismatch is hidden by
  // suppressHydrationWarning on <html>, not prevented — Spanish users on a
  // direct /es/* hit will briefly see English until React commits the hydrated
  // tree. Acceptable for a rarely-hit root error boundary; the global-error
  // API does not let us pass locale as a prop.
  const [locale] = useState<Locale>(detectLocale);

  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  const copy = COPY[locale];

  return (
    <html lang={copy.htmlLang} data-theme="dark" suppressHydrationWarning>
      <body
        style={{
          margin: 0,
          backgroundColor: '#0A0A0A',
          color: '#F3F4F6',
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '100dvh',
            padding: '24px',
            textAlign: 'center',
          }}
        >
          <p style={{ fontSize: 18, fontWeight: 500, margin: '0 0 8px' }}>{copy.title}</p>
          <p style={{ fontSize: 14, color: '#9CA3AF', margin: '0 0 24px' }}>{copy.subtitle}</p>
          <button
            onClick={() => reset()}
            style={{
              padding: '12px 24px',
              borderRadius: 8,
              border: 'none',
              backgroundColor: '#8C4A52',
              color: '#fff',
              fontSize: 16,
              cursor: 'pointer',
              WebkitTapHighlightColor: 'transparent',
            }}
          >
            {copy.reload}
          </button>
        </div>
      </body>
    </html>
  );
}

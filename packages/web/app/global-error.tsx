'use client';

import * as Sentry from '@sentry/nextjs';
import { useEffect, useState } from 'react';

// This is a Next.js root error boundary that renders when the root layout
// itself fails. It lives outside the normal provider tree, so we can't rely
// on I18nProvider here. Instead we read the locale prefix off the URL on the
// client and look up copy from this small inline map.
const COPY = {
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
} as const;

type Locale = keyof typeof COPY;

function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en-US';
  const { pathname } = window.location;
  if (pathname === '/es' || pathname.startsWith('/es/')) return 'es';
  return 'en-US';
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
          backgroundColor: '#15101e',
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
              backgroundColor: '#6d28d9',
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

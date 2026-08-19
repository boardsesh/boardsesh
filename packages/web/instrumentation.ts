import * as Sentry from '@sentry/nextjs';
import { applyCanonicalAuthUrl } from './app/lib/auth/canonical-auth-url';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Once per server boot, so routes that read NEXTAUTH_URL without importing
    // auth-options (e.g. /api/internal/ws-auth via secure-cookies) also see the
    // canonical origin instead of next-auth's localhost fallback (issue #4227).
    applyCanonicalAuthUrl();
    await import('./sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;

// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { isAbortError } from '@/app/lib/is-abort-error';

// Only enable Sentry on boardsesh.com to avoid polluting error tracking
const isProductionDomain = typeof window !== 'undefined' && window.location.hostname.includes('boardsesh.com');

Sentry.init({
  dsn: 'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400',

  // Only send errors when running on boardsesh.com
  enabled: isProductionDomain,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Filter out errors from browser extensions and third-party scripts
  beforeSend(event, hint) {
    const error = hint.originalException;
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Ignore browser extension errors (runtime.sendMessage, etc.)
    if (
      errorMessage.includes('runtime.sendMessage') ||
      errorMessage.includes('Extension context invalidated') ||
      errorMessage.includes('message channel closed') ||
      errorMessage.includes('message port closed')
    ) {
      return null;
    }

    // Ignore in-flight fetches aborted by page navigation. Different browsers
    // surface this differently:
    //   - Chrome/Firefox: TypeError "Failed to fetch"
    //   - Older Safari/WebKit: TypeError "Load failed" or "cancelled"
    //   - Modern Safari/WKWebView (iOS 18+): DOMException name="AbortError" code=20
    // These checks are intentionally narrow — they're the platform-emitted
    // messages/shapes, not generic substrings that could swallow unrelated errors.
    // User-controlled AbortController errors (timeouts, BLE, share) are caught
    // at their call sites and never reach this global handler.
    if (errorMessage === 'Load failed' || errorMessage === 'Failed to fetch' || errorMessage === 'cancelled') {
      return null;
    }
    if (isAbortError(error)) {
      return null;
    }

    // Ignore DuckDuckGo browser-internal feature detection errors
    // (e.g., "feature named `pageContext` was not found")
    if (errorMessage.includes('feature named') && errorMessage.includes('was not found')) {
      return null;
    }

    return event;
  },
});

// eslint-disable-next-line import/namespace -- oxlint can't see captureRouterTransitionStart in @sentry/nextjs's exports, but it's a real export.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

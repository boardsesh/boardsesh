// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';

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
    const errorName = error instanceof Error ? error.name : '';
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Ignore AbortError — expected during rapid BLE swipes, fetch cancellation
    // on navigation, and graphql-ws teardown on iOS WKWebView. See also the
    // "Load failed" filter below and the dispose() wrapper in
    // components/graphql-queue/graphql-client.ts.
    if (errorName === 'AbortError') {
      return null;
    }

    // Ignore browser extension errors (runtime.sendMessage, etc.)
    if (
      errorMessage.includes('runtime.sendMessage') ||
      errorMessage.includes('Extension context invalidated') ||
      errorMessage.includes('message channel closed') ||
      errorMessage.includes('message port closed')
    ) {
      return null;
    }

    // Ignore Safari/WebKit "Load failed" errors caused by in-flight fetch requests
    // being aborted during page navigation (e.g., RSC fetches interrupted by route changes)
    if (errorMessage === 'Load failed' || errorMessage === 'Failed to fetch' || errorMessage === 'cancelled') {
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

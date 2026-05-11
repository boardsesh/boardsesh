// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { hasErrorMonitoringConsent } from './app/lib/consent';

// Only enable Sentry on boardsesh.com to avoid polluting error tracking
const isProductionDomain = typeof window !== 'undefined' && window.location.hostname.includes('boardsesh.com');

// Skip Sentry init entirely when the user hasn't granted error-monitoring
// consent. Passing `enabled: false` to `Sentry.init` still ships the SDK
// bytes and may install some instrumentation; we want to avoid the cost
// entirely until consent is granted. The user-facing reload after flipping
// consent will pick up the new state on next page load.
const shouldInitializeSentry = isProductionDomain && hasErrorMonitoringConsent();

if (shouldInitializeSentry) {
  Sentry.init({
    dsn: 'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400',

    // Only send errors when running on boardsesh.com. Kept here so the
    // config is internally consistent if the outer guard ever loosens.
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
      // These exact-string matches are intentionally narrow — they're the
      // platform-emitted messages, not generic substrings that could swallow
      // unrelated errors.
      //
      // We deliberately do NOT filter out `AbortError` here. AbortError is also
      // raised by user-controlled AbortControllers (timeouts, manual cancels)
      // and a blanket filter would mask real bugs. Instead, handle aborts at
      // the call site using `isAbortError` from `@/app/lib/is-abort-error`.
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
}

// Next.js requires this export from the instrumentation-client module. When
// Sentry has not been initialized (no consent, or non-production hostname)
// the router transition hook must still exist as a no-op — otherwise the
// router-transition wiring on the framework side throws on undefined.
// eslint-disable-next-line import/namespace -- oxlint can't see captureRouterTransitionStart in @sentry/nextjs's exports, but it's a real export.
export const onRouterTransitionStart = shouldInitializeSentry ? Sentry.captureRouterTransitionStart : () => {};

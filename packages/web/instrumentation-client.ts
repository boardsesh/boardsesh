// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { isProductionHost } from './app/lib/production-hosts';

// Only enable Sentry on the production boardsesh.com hosts. Exact-host match
// (see production-hosts.ts for why), NOT a substring: preview deploys run at
// `<pr>.preview.boardsesh.com` (branch-deploy.yml), which contains
// "boardsesh.com" and would pass an `.includes()` check — so every
// PR-preview browser session (and any browser test pointed at a preview host
// via PLAYWRIGHT_TEST_BASE_URL) leaked into the prod project. Shared with
// analytics.ts's PostHog gate so the two production-checks can't drift apart.
const isProductionDomain = typeof window !== 'undefined' && isProductionHost(window.location.hostname);

Sentry.init({
  dsn: 'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400',

  // Only send errors when running on the production boardsesh.com hosts
  enabled: isProductionDomain,

  // Sentry only initializes here on a production host (see the gate above), so
  // tag events accordingly for the environment:production filter.
  environment: 'production',

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Browser page loads and client-side navigations. `browserTracingIntegration`
  // is already in @sentry/nextjs's client defaults (its `getDefaultIntegrations`
  // pushes it unless `__SENTRY_TRACING__` is explicitly false), so setting a
  // rate is all that's needed — adding the integration by hand would register
  // it twice.
  //
  // 10%, not the server's 25%: a page load fans out into many more spans
  // (resource timings, fetches, navigations) than a server transaction.
  tracesSampleRate: 0.1,

  // `tracePropagationTargets` is deliberately LEFT UNSET here.
  //
  // The browser default is the opposite of Node's: unset means same-origin (and
  // relative) only, which is exactly what we want. Adding 'ws.boardsesh.com' to
  // reach the backend would be wrong *today* — packages/backend/src/handlers/cors.ts
  // answers preflights with
  //     Access-Control-Allow-Headers: 'Content-Type, Authorization, Content-Encoding'
  // and nothing else. The moment the browser SDK decides a cross-origin request
  // is a propagation target it puts `sentry-trace, baggage` into that request's
  // Access-Control-Request-Headers, the preflight fails against that allowlist,
  // and the request never goes out. That would take down every PostHog-proxy
  // POST (ws.boardsesh.com/api/posthog/*) and every gym-image upload — product
  // analytics would go dark to buy a trace link. Widen the CORS header first;
  // then, and only then, add the host here.
  //
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

// eslint-disable-next-line import/namespace -- oxlint can't see captureRouterTransitionStart in @sentry/nextjs's exports, but it's a real export.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

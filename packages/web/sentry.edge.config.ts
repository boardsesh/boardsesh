// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { isProductionSentryEnvironment, resolveSentryEnvironment } from '@boardsesh/db/client/config';
import { resolveWebTracesSampleRate, WEB_TRACE_PROPAGATION_TARGETS } from './app/lib/observability/sentry-tracing';

Sentry.init({
  dsn: 'https://f55e6626faf787ae5291ad75b010ea14@o4510644927660032.ingest.us.sentry.io/4510644930150400',

  // Report only from a real production deployment. This used to be
  // `VERCEL_ENV === 'production'`, which is unset on Railway and on every other
  // host — the swap would have taken web Sentry dark at exactly the moment the
  // telemetry mattered most (#4651). resolveSentryEnvironment() is the same
  // helper the backend's instrument.ts uses, and it already covers a Railway
  // deployment (NODE_ENV and SENTRY_ENVIRONMENT both unset, non-private
  // DATABASE_URL) as well as branch deploys (SENTRY_ENVIRONMENT=preview).
  enabled: isProductionSentryEnvironment(),

  environment: resolveSentryEnvironment(),

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,

  // Same shape as sentry.server.config.ts so a route can't be sampled at one
  // rate in middleware and another in its handler. The edge runtime only runs
  // middleware.ts here, so in practice this covers every request that reaches
  // the app — including the /monitoring tunnel POSTs the sampler zeroes.
  tracesSampler: (samplingContext) =>
    resolveWebTracesSampleRate({
      name: samplingContext.name,
      method: samplingContext.normalizedRequest?.method,
      url: samplingContext.normalizedRequest?.url,
    }),

  // Node defaults this to *every* host. Must be set. See the constant.
  tracePropagationTargets: WEB_TRACE_PROPAGATION_TARGETS,
});

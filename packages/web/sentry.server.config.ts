// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from '@sentry/nextjs';
import { isProductionSentryEnvironment, resolveSentryEnvironment } from '@boardsesh/db/client/config';
import { tagPostgresError } from '@/app/lib/observability/postgres-error-tags';

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

  // Normalise postgres.js and Drizzle wrapper shapes into queryable SQLSTATE
  // tags. Production alerts can now match `postgres.error_code:53300` without
  // relying on an English message or one particular error wrapper.
  beforeSend: tagPostgresError,

  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Enable sending user PII (Personally Identifiable Information)
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#sendDefaultPii
  sendDefaultPii: true,
});

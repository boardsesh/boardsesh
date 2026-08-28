import * as Sentry from '@sentry/nextjs';
import { applyCanonicalAuthUrl, diagnoseCanonicalOrigin } from './app/lib/auth/canonical-auth-url';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Read the diagnosis off the PRISTINE env, before applyCanonicalAuthUrl can
    // delete a loopback NEXTAUTH_URL — a deleted one would look like "no origin
    // named at all" and turn a warning into a spurious boot failure.
    const canonicalOriginDiagnosis = diagnoseCanonicalOrigin();

    // Once per server boot, so routes that read NEXTAUTH_URL without importing
    // auth-options (e.g. /api/internal/ws-auth via secure-cookies) also see the
    // canonical origin instead of next-auth's localhost fallback (issue #4227).
    applyCanonicalAuthUrl();

    // Sentry first, so the throw below is reported rather than only printed.
    await import('./sentry.server.config');

    if (canonicalOriginDiagnosis.level === 'warn') {
      console.warn(canonicalOriginDiagnosis.message);
    } else if (canonicalOriginDiagnosis.level === 'fatal') {
      // Refusing to boot beats serving a fleet-wide logout: an unconfigured
      // origin flips every session cookie's name and drops its domain scope, so
      // a container that starts "fine" quietly signs out the entire user base
      // (issue #4651).
      console.error(canonicalOriginDiagnosis.message);
      Sentry.captureException(new Error(canonicalOriginDiagnosis.message));
      await Sentry.flush(2000).catch(() => {});
      // Exit rather than throw. Measured on the Dockerfile.web runner: throwing
      // out of register() leaves Next answering EVERY request with a 500 while
      // the process stays alive — and the container's healthcheck still reports
      // healthy, so an orchestrator happily promotes it. Exiting is the signal
      // a deploy actually fails on. It cannot fire on a developer machine or in
      // CI: diagnoseCanonicalOrigin only returns 'fatal' when NODE_ENV is
      // production AND neither NEXTAUTH_URL nor BASE_URL names any origin, and
      // every local, test and build path names one (the tracked
      // packages/web/.env.local, or e2e-tests.yml's explicit NEXTAUTH_URL).
      process.exit(1);
    }
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;

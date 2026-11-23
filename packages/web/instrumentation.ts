import * as Sentry from '@sentry/nextjs';
import { markWebDatabaseUrlProcess } from '@boardsesh/db/client/config';
import { applyCanonicalAuthUrl, diagnoseCanonicalOrigin } from './app/lib/auth/canonical-auth-url';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Before the first request: a 4xx or 5xx must not leave with the
    // middleware's CDN-Cache-Control TTL, or Cloudflare keeps serving it for a
    // day (docs/operations/cloudflare.md, "Error pages stay out of the edge cache").
    const { installErrorResponseCdnCacheGuard } = await import('./app/lib/error-response-cdn-cache.server');
    installErrorResponseCdnCacheGuard();

    // Read the diagnosis off the PRISTINE env, before applyCanonicalAuthUrl can
    // delete a loopback NEXTAUTH_URL — a deleted one would look like "no origin
    // named at all" and turn a warning into a spurious boot failure.
    const canonicalOriginDiagnosis = diagnoseCanonicalOrigin();

    // Once per server boot, so routes that read NEXTAUTH_URL without importing
    // auth-options (e.g. /api/internal/ws-auth via secure-cookies) also see the
    // canonical origin instead of next-auth's localhost fallback (issue #4227).
    applyCanonicalAuthUrl();

    // Before Sentry, whose environment reads the database hostname: once this
    // process is marked as the web, that follows WEB_DATABASE_URL like the pool.
    // Marking refuses a WEB_DATABASE_URL while the web still writes identity
    // tables itself (WEB_DATABASE_LOGIN_BLOCKERS); that exits below.
    let webDatabaseRefusal: Error | undefined;
    try {
      markWebDatabaseUrlProcess();
    } catch (error) {
      webDatabaseRefusal = error instanceof Error ? error : new Error('WEB_DATABASE_LOGIN_BLOCKED');
    }

    // Sentry first, so the throw below is reported rather than only printed.
    await import('./sentry.server.config');

    if (webDatabaseRefusal) {
      // Same reasoning as the origin check below: a process left running would
      // fail sign-up, password reset and email verification with 42501.
      console.error(
        `${webDatabaseRefusal.message}: WEB_DATABASE_URL is set, but the web still writes identity tables. ` +
          'Unset it until runbook #7430 says otherwise (docs/auth/better-auth-writer-fence-proof.md).',
      );
      Sentry.captureException(webDatabaseRefusal);
      await Sentry.flush(2000).catch(() => {});
      process.exit(1);
    }

    // AUTH_BROWSER_SESSION_MODE: unset, empty or `legacy` boots as before. A
    // value that would answer 503 on every /api/auth route (a typo, a missing
    // precondition, www cutover work still listed) fails the deploy instead, so
    // the previous one keeps serving, as the backend refuses to start.
    const { browserSessionBootRefusal } = await import('./app/lib/auth/browser-session-mode.server');
    const browserSessionRefusal = browserSessionBootRefusal();
    if (browserSessionRefusal) {
      console.error(
        `${browserSessionRefusal.message}: AUTH_BROWSER_SESSION_MODE cannot serve sign-in on this deployment. ` +
          'Set it to legacy or meet its preconditions (docs/auth/better-auth-rollout.md).',
      );
      Sentry.captureException(browserSessionRefusal);
      await Sentry.flush(2000).catch(() => {});
      process.exit(1);
    }

    // The browser-session e2e run's provider stand-ins: only on `.boardsesh.test`
    // origins. Set anywhere else, refuse to serve rather than sign in against one.
    const { oidcStandInBootRefusal } = await import('./app/lib/auth/oidc-stand-in.server');
    const oidcStandInRefusal = oidcStandInBootRefusal();
    if (oidcStandInRefusal) {
      console.error(
        `${oidcStandInRefusal.message}: a provider stand-in variable is set outside the browser-session e2e run. Unset it.`,
      );
      Sentry.captureException(oidcStandInRefusal);
      await Sentry.flush(2000).catch(() => {});
      process.exit(1);
    }

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

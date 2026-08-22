import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { isProductionSentryEnvironment, resolveSentryEnvironment } from '@boardsesh/db/client/config';

// The gate that decides whether this process reports to the *production* Sentry
// and PostHog projects. `@boardsesh/db`'s own node:test suite has the full matrix,
// but that suite isn't part of CI's test run — this file is, and the regression it
// guards is expensive: production issues polluted with a developer's dev-database
// failures ("write CONNECTION_CLOSED localhost:5440"), filed under
// `environment: production` where nobody can tell them apart from the real thing.
//
// Vitest sets VITEST=true and points DATABASE_URL at the localhost test database,
// so every case restates the runtime it means rather than inheriting the runner's.
const RAILWAY_DATABASE_URL = 'postgresql://postgres:pw@postgres.railway.internal:5432/railway';

// The baseline is the production shape, so a case that forgets to name its
// database can't quietly inherit the runner's localhost URL and pass a
// "not production" assertion for the wrong reason.
function stubRuntime(overrides: Record<string, string>): void {
  const runtime = {
    NODE_ENV: '',
    SENTRY_ENVIRONMENT: '',
    VITEST: '',
    GITHUB_ACTIONS: '',
    DATABASE_URL: RAILWAY_DATABASE_URL,
    ...overrides,
  };
  for (const [name, value] of Object.entries(runtime)) vi.stubEnv(name, value);
}

describe('production Sentry gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // Railway prod sets none of NODE_ENV / SENTRY_ENVIRONMENT (issue #3603), so this
  // shape is the only thing keeping production reporting switched on.
  it('reports as production for a Railway-shaped runtime', () => {
    stubRuntime({ DATABASE_URL: RAILWAY_DATABASE_URL });

    expect(resolveSentryEnvironment()).toBe('production');
    expect(isProductionSentryEnvironment()).toBe(true);
  });

  // A backend started with the package's `start` script on a laptop sets no
  // NODE_ENV, so every var-based check reads it as prod. The database is the tell.
  it('stays out of production for a backend wired to a local database', () => {
    stubRuntime({ DATABASE_URL: 'postgres://postgres:password@localhost:5440/main' });

    expect(isProductionSentryEnvironment()).toBe(false);
  });

  it('stays out of production for a tailnet dev database', () => {
    stubRuntime({ DATABASE_URL: 'postgres://postgres:password@dev-box.tail1234.ts.net:5432/main' });

    expect(isProductionSentryEnvironment()).toBe(false);
  });

  // e2e jobs run that same `start` script on a runner, against a throwaway
  // Postgres service whose hostname says nothing about the environment.
  it('stays out of production on a GitHub Actions runner', () => {
    stubRuntime({ GITHUB_ACTIONS: 'true', DATABASE_URL: 'postgresql://postgres:password@postgres:5432/main' });

    expect(isProductionSentryEnvironment()).toBe(false);
  });

  it('keeps preview deploys named and out of the production project', () => {
    stubRuntime({ SENTRY_ENVIRONMENT: 'preview', NODE_ENV: 'production', DATABASE_URL: RAILWAY_DATABASE_URL });

    expect(resolveSentryEnvironment()).toBe('preview');
    expect(isProductionSentryEnvironment()).toBe(false);
  });
});

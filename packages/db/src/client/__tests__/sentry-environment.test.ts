import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateDatabaseTarget, isProductionSentryEnvironment, resolveSentryEnvironment } from '../config';

// These helpers read process.env at call time, so each case sets exactly the vars
// it cares about and the afterEach hook restores the runner's original values.
// Cast away the repo's readonly NODE_ENV augmentation so the test can mutate it.
const env = process.env as Record<string, string | undefined>;
const TOUCHED = ['SENTRY_ENVIRONMENT', 'NODE_ENV', 'VERCEL_ENV', 'VITEST', 'DATABASE_URL', 'GITHUB_ACTIONS'] as const;
const PRODUCTION_DATABASE_URL = 'postgresql://postgres:hunter2@postgres.railway.internal:5432/railway';
const original = new Map<string, string | undefined>(TOUCHED.map((key) => [key, env[key]]));

function setEnv(overrides: Partial<Record<(typeof TOUCHED)[number], string | undefined>>): void {
  for (const key of TOUCHED) {
    const value = key in overrides ? overrides[key] : undefined;
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

void describe('resolveSentryEnvironment', () => {
  afterEach(() => {
    for (const key of TOUCHED) {
      const value = original.get(key);
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  });

  void it('prefers an explicit SENTRY_ENVIRONMENT', () => {
    setEnv({ SENTRY_ENVIRONMENT: 'preview', NODE_ENV: 'production' });
    assert.equal(resolveSentryEnvironment(), 'preview');
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it("resolves to 'production' when nothing is set (mirrors Railway prod)", () => {
    setEnv({ DATABASE_URL: PRODUCTION_DATABASE_URL });
    assert.equal(resolveSentryEnvironment(), 'production');
    assert.equal(isProductionSentryEnvironment(), true);
  });

  void it("treats an explicit SENTRY_ENVIRONMENT='production' as production", () => {
    setEnv({ SENTRY_ENVIRONMENT: 'production', DATABASE_URL: PRODUCTION_DATABASE_URL });
    assert.equal(isProductionSentryEnvironment(), true);
  });

  void it('is not production in local development', () => {
    setEnv({ NODE_ENV: 'development' });
    assert.equal(resolveSentryEnvironment(), 'development');
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('is not production under the test runner', () => {
    setEnv({ NODE_ENV: 'test' });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('keeps preview/staging deploys (NODE_ENV=production) out of the prod project', () => {
    setEnv({ SENTRY_ENVIRONMENT: 'staging', NODE_ENV: 'production' });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  // A locally-run production-shaped backend (`bun run backend:start`, which sets
  // no NODE_ENV) used to resolve to 'production' and file its dev-DB failures
  // against the production project — "write CONNECTION_CLOSED localhost:5440".
  void it('is not production when the database is on localhost', () => {
    setEnv({ DATABASE_URL: 'postgres://postgres:password@localhost:5440/main' });
    assert.equal(resolveSentryEnvironment(), 'development');
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('is not production for a tailnet dev database', () => {
    setEnv({ DATABASE_URL: 'postgres://postgres:password@100.101.102.103:5432/main' });
    assert.equal(isProductionSentryEnvironment(), false);
    setEnv({ DATABASE_URL: 'postgres://postgres:password@dev-box.tail1234.ts.net:5432/main' });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('ignores an explicit production claim from a private database host', () => {
    setEnv({ SENTRY_ENVIRONMENT: 'production', DATABASE_URL: 'postgres://postgres:password@127.0.0.1:5440/main' });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('still lets a preview deploy name itself, private database or not', () => {
    setEnv({ SENTRY_ENVIRONMENT: 'preview', DATABASE_URL: 'postgres://postgres:password@10.0.0.4:5432/main' });
    assert.equal(resolveSentryEnvironment(), 'preview');
  });

  void it("doesn't let a local NODE_ENV=production re-open the gate", () => {
    setEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgres://postgres:password@localhost:5440/main' });
    assert.equal(resolveSentryEnvironment(), 'development');
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('keeps CI runs out of the production project', () => {
    setEnv({ GITHUB_ACTIONS: 'true', DATABASE_URL: 'postgresql://postgres:password@postgres:5432/main' });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('leaves a Railway production database reporting as production', () => {
    setEnv({ DATABASE_URL: PRODUCTION_DATABASE_URL });
    assert.equal(isPrivateDatabaseTarget(), false);
    assert.equal(isProductionSentryEnvironment(), true);
  });

  void it('falls back to production when DATABASE_URL is unparseable', () => {
    setEnv({ DATABASE_URL: '/var/run/postgresql' });
    assert.equal(isPrivateDatabaseTarget(), false);
    assert.equal(isProductionSentryEnvironment(), true);
  });
});

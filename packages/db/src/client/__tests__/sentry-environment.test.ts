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

  // A locally-run production-shaped backend (`pnpm --filter boardsesh-backend run start`, which sets
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

  // A backend run inside Compose reaches Postgres by service name — `db` in
  // packages/backend/docker-compose.yml, `postgres` in the e2e stack — which no
  // IP range catches.
  void it('is not production for a Compose service hostname', () => {
    setEnv({ DATABASE_URL: 'postgresql://postgres:postgres@db:5432/boardsesh_backend' });
    assert.equal(isPrivateDatabaseTarget(), true);
    assert.equal(isProductionSentryEnvironment(), false);
    setEnv({ DATABASE_URL: 'postgresql://postgres:password@postgres:5432/main' });
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

  // packages/web's sentry.{server,edge}.config.ts moved off
  // `VERCEL_ENV === 'production'` onto these helpers (#4651). The two cases below
  // are the ones that swap could have got wrong.
  void it('still reports from a Vercel production deployment', () => {
    setEnv({ VERCEL_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: PRODUCTION_DATABASE_URL });
    assert.equal(resolveSentryEnvironment(), 'production');
    assert.equal(isProductionSentryEnvironment(), true);
  });

  void it('is silenced by a VERCEL_ENV=development leaking out of packages/web/.env.local', () => {
    // The load-bearing half of the case above. The tracked packages/web/.env.local
    // sets VERCEL_ENV=development, and its NEXTAUTH_URL demonstrably DOES leak
    // into the Vercel production runtime. If VERCEL_ENV leaked the same way, the
    // swap off `VERCEL_ENV === 'production'` onto isLocalDevelopment() would turn
    // production Sentry off. It does not leak — Vercel sets VERCEL_ENV as a real
    // system variable, which wins over any .env file — but this pins what would
    // happen if that ever changed, so the failure is a red test and not silence.
    setEnv({ VERCEL_ENV: 'development', NODE_ENV: 'production', DATABASE_URL: PRODUCTION_DATABASE_URL });
    assert.equal(isProductionSentryEnvironment(), false);
  });

  void it('fails OPEN in an edge runtime that never sees DATABASE_URL', () => {
    // The edge sandbox may not carry DATABASE_URL, so isPrivateDatabaseTarget()
    // has no signal there. That resolves to 'production' and reports, which is
    // the safe direction — but it means edge Sentry can be enabled where server
    // Sentry is not. Asserted so the asymmetry is deliberate, not a surprise.
    setEnv({ NODE_ENV: 'production' });
    assert.equal(isPrivateDatabaseTarget(), false);
    assert.equal(isProductionSentryEnvironment(), true);
  });
});

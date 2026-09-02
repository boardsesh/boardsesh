import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

type NextConfigWithExternals = {
  serverExternalPackages?: string[];
};

const configModule = await import('../../next.config.mjs');
// Note this is the FINAL exported config — withSentryConfig (and, until the
// Vercel scrub, withVercelToolbar) have already wrapped it. That is the object
// Next actually reads, which is what makes it worth asserting on.
const exportedConfig = configModule.default as unknown as NextConfigWithExternals;

// The major @sentry/node's postgresJsIntegration declares it can instrument
// (SUPPORTED_VERSIONS = [">=3.0.0 <4"] in
// @sentry/node/build/cjs/integrations/tracing/postgresjs.js).
const SENTRY_SUPPORTED_POSTGRES_MAJOR = 3;

describe('serverExternalPackages', () => {
  it('keeps postgres.js external so Sentry can instrument it', () => {
    // Sentry's postgresJsIntegration patches postgres.js through
    // OpenTelemetry's require-hook, which only fires for modules the bundler
    // leaves external. Neither Next's own externals list nor @sentry/nextjs's
    // DEFAULT_SERVER_EXTERNAL_PACKAGES includes `postgres` — both list `pg`,
    // which this repo does not use.
    //
    // Drop this and every db.query span disappears with no error anywhere. The
    // failure mode is an empty Sentry Queries view, which is exactly the panel
    // that replaced Vercel Observability Plus's per-route latency breakdown.
    expect(exportedConfig.serverExternalPackages).toContain('postgres');
  });

  it('pins postgres.js to a major Sentry can still instrument', () => {
    // The externals entry above is necessary but not sufficient: the
    // integration only patches `>=3.0.0 <4`. A bump to postgres@4 would leave
    // the config looking correct while DB spans silently stopped, so fail here
    // instead — loudly, at the moment of the bump.
    const dbPackageJsonPath = path.join(import.meta.dirname, '../../../db/package.json');
    const dbPackageJson = JSON.parse(readFileSync(dbPackageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const postgresRange = dbPackageJson.dependencies?.postgres;

    expect(postgresRange).toBeDefined();
    // Accept `^3.x`, `~3.x` and a bare `3.x` — all of them stay inside the
    // supported range. Only a different major should fail here.
    expect(postgresRange).toMatch(new RegExp(`^[\\^~]?${SENTRY_SUPPORTED_POSTGRES_MAJOR}\\.`));
  });
});

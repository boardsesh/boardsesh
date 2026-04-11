/**
 * Regression tests for `withTransaction` and the neon-http limitation that
 * motivated it. These exist to prevent us from accidentally going back to a
 * long-lived pool or to a pool-free ctx.db.transaction() pattern that would
 * crash in production.
 *
 * Context: the request-scoped db (`createRequestDb` / `ctx.db`) is a
 * stateless neon-http drizzle client. It does not support callback
 * transactions — calling `.transaction()` on it throws
 * `"No transactions support in neon-http driver"`. Production code must use
 * `withTransaction(...)` which opens an ephemeral WebSocket pool for the
 * duration of the callback and closes it immediately, so the Neon compute
 * can still spin down while the service is idle.
 */
import { describe, it, expect, vi } from 'vitest';
import { drizzle as drizzleHttp } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import { withTransaction } from '../db/client';

describe('withTransaction regression safety net', () => {
  it('neon-http drizzle clients throw on .transaction() — production ctx.db must never call it', async () => {
    // Build a neon-http drizzle client against a dummy connection string.
    // We never actually issue a query, we just verify the driver rejects
    // callback transactions up-front. This locks in the invariant that
    // motivated withTransaction.
    const httpClient = drizzleHttp({
      client: neon('postgres://u:p@example.invalid/db'),
    });

    await expect(
      httpClient.transaction(async () => {
        /* never runs */
      }),
    ).rejects.toThrow(/No transactions support in neon-http driver/);
  });

  it('withTransaction runs the callback and returns its value (test fallback path)', async () => {
    // In Vitest the helper falls back to the process-wide postgres-js
    // singleton, which does support transactions. We don't need a live DB
    // for this assertion — it fails fast on connection only if the callback
    // actually issues a query. We pass a no-op callback to prove the
    // helper wires things up correctly.
    const callback = vi.fn(async () => 'done');
    // The postgres-js test singleton is lazy; with a no-op body it may still
    // open a BEGIN before calling back. We only care that (a) our function
    // invokes the callback and (b) the return value is preserved. If the
    // ambient test DB isn't reachable the setup file will have skipped,
    // so we allow failure here rather than hard-fail in environments
    // without Postgres.
    try {
      const result = await withTransaction(callback);
      expect(callback).toHaveBeenCalledOnce();
      expect(result).toBe('done');
    } catch (err) {
      // Tolerate environments without a configured/reachable test DB — we
      // only care that withTransaction wired into the driver, not that a
      // real query succeeded.
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toMatch(
        /ECONNREFUSED|ENOTFOUND|terminat|connect|DATABASE_URL/i,
      );
    }
  });
});

/**
 * Cleanup tests for `withTransaction`'s production path. These tests exercise
 * the ephemeral-pool branch of the helper (which only runs when
 * `isTestEnvironment()` returns false) and verify that `pool.end()` always
 * runs in the `finally` block — even when the callback throws.
 *
 * We can't reach the production branch from a normal Vitest run because the
 * helper bails out to the postgres-js test singleton when `VITEST=true`. So
 * this file stubs the relevant env vars, mocks out `@neondatabase/serverless`
 * and `drizzle-orm/neon-serverless`, and then imports `withTransaction`
 * dynamically so the real helper runs against our mocks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock state shared with the vi.mock factories below.
const mocks = vi.hoisted(() => {
  const endSpy = vi.fn<[], Promise<void>>(() => Promise.resolve());
  const poolCtorSpy = vi.fn();
  class MockPool {
    end = endSpy;
    constructor(config: unknown) {
      poolCtorSpy(config);
    }
  }
  return { endSpy, poolCtorSpy, MockPool };
});

vi.mock('@neondatabase/serverless', async () => {
  const actual = await vi.importActual<typeof import('@neondatabase/serverless')>(
    '@neondatabase/serverless',
  );
  return {
    ...actual,
    Pool: mocks.MockPool,
  };
});

// Route drizzle-serverless through a fake transaction runner that just calls
// the callback with a stubbed tx object. We don't care what queries the
// callback runs — we only care that `withTransaction` awaits it inside a
// try/finally that reliably ends the pool.
vi.mock('drizzle-orm/neon-serverless', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm/neon-serverless')>(
    'drizzle-orm/neon-serverless',
  );
  return {
    ...actual,
    drizzle: () => ({
      transaction: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
    }),
  };
});

describe('withTransaction ephemeral-pool cleanup', () => {
  beforeEach(() => {
    mocks.endSpy.mockClear();
    mocks.poolCtorSpy.mockClear();
    // Force the production branch: pretend we're not running under Vitest.
    vi.stubEnv('VITEST', '');
    vi.stubEnv('NODE_ENV', 'production');
    // getConnectionConfig() requires DATABASE_URL when not in test/local mode.
    vi.stubEnv('DATABASE_URL', 'postgresql://user:pass@example.invalid/db');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('closes the ephemeral pool after the callback resolves', async () => {
    // Import inside the test so the mocked deps are picked up.
    const { withTransaction } = await import('@boardsesh/db/client');

    const result = await withTransaction(async () => 'done');

    expect(result).toBe('done');
    expect(mocks.poolCtorSpy).toHaveBeenCalledTimes(1);
    expect(mocks.endSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the ephemeral pool even when the callback throws', async () => {
    const { withTransaction } = await import('@boardsesh/db/client');

    await expect(
      withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mocks.poolCtorSpy).toHaveBeenCalledTimes(1);
    expect(mocks.endSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the ephemeral pool even if pool.end itself rejects', async () => {
    mocks.endSpy.mockRejectedValueOnce(new Error('pool.end failed'));
    const { withTransaction } = await import('@boardsesh/db/client');

    // The helper swallows end() failures with a console.warn so the original
    // callback result still propagates.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await withTransaction(async () => 42);
    warnSpy.mockRestore();

    expect(result).toBe(42);
    expect(mocks.endSpy).toHaveBeenCalledTimes(1);
  });
});

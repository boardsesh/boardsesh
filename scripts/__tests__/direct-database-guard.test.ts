import { describe, expect, it, vi } from 'vite-plus/test';
import {
  assertExpectedDirectEndpoint,
  databaseEndpointIdentity,
  verifyDirectConnectivity,
} from '../../packages/db/scripts/direct-database-guard';

describe('direct database guard', () => {
  it('normalizes the default PostgreSQL port without retaining credentials', () => {
    expect(databaseEndpointIdentity('postgresql://migrator:secret@DIRECT.EXAMPLE/boardsesh?sslmode=require')).toBe(
      'direct.example:5432/boardsesh',
    );
  });

  it('accepts the pinned direct host, port, and database', () => {
    expect(() =>
      assertExpectedDirectEndpoint(
        'postgres://migrator:secret@direct.example:15432/boardsesh',
        'direct.example:15432/boardsesh',
      ),
    ).not.toThrow();
  });

  it('rejects a PgBouncer endpoint even when credentials and database match', () => {
    expect(() =>
      assertExpectedDirectEndpoint(
        'postgres://migrator:secret@pooler.example:6432/boardsesh',
        'direct.example:15432/boardsesh',
      ),
    ).toThrow(/does not match the trusted PostgreSQL endpoint/);
  });

  it('requires the protected endpoint identity', () => {
    expect(() => assertExpectedDirectEndpoint('postgres://migrator:secret@direct.example/boardsesh', '')).toThrow(
      /DATABASE_DIRECT_ENDPOINT is required/,
    );
  });

  it('redacts malformed connection strings from parse errors', () => {
    const sentinelPassword = 'never-print-this-password';
    let thrownError: unknown;

    try {
      databaseEndpointIdentity(`postgresql://migrator:${sentinelPassword}@[invalid/boardsesh`);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    const serializedError = JSON.stringify(thrownError, Object.getOwnPropertyNames(thrownError as object));
    expect(String(thrownError)).not.toContain(sentinelPassword);
    expect(serializedError).not.toContain(sentinelPassword);
    expect(String(thrownError)).toContain('DATABASE_DIRECT_URL is not a valid PostgreSQL URL');
  });

  it('runs a read-only connectivity probe and propagates failures', async () => {
    const unsafe = vi.fn<(query: string) => Promise<unknown>>().mockResolvedValue([{ '?column?': 1 }]);
    await verifyDirectConnectivity({ unsafe });
    expect(unsafe).toHaveBeenCalledExactlyOnceWith('SELECT 1');

    const connectionError = Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' });
    await expect(
      verifyDirectConnectivity({
        unsafe: () => Promise.reject(connectionError),
      }),
    ).rejects.toBe(connectionError);
  });
});

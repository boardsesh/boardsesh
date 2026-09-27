import { describe, expect, it } from 'vitest';
import { requireProviderSecrets, workerConfig } from '../config';

const environment = { WORKER_ROLE: 'interactive-import', DATABASE_URL: 'postgresql://worker:secret@localhost/test' };

describe('worker configuration', () => {
  it('defaults to paused and accepts the fixed pool/concurrency budget', () => {
    expect(workerConfig(environment)).toMatchObject({ paused: true, role: 'interactive-import', healthPort: 9090 });
    expect(
      workerConfig({
        ...environment,
        WORKER_PAUSED: 'false',
        DB_POOL_MAX: '2',
        PGBOSS_POOL_SIZE: '1',
        WORKER_CONCURRENCY: '1',
      }).paused,
    ).toBe(false);
  });
  it.each([
    { WORKER_ROLE: 'backend' },
    { WORKER_PAUSED: 'yes' },
    { DB_POOL_MAX: '3' },
    { PGBOSS_POOL_SIZE: '4' },
    { WORKER_CONCURRENCY: '2' },
    { HEALTH_PORT: '0' },
    { READ_REPLICA_URL: 'postgresql://replica/test' },
    { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { DATABASE_URL: 'postgresql://worker:secret@remote.example/test' },
    { DATABASE_URL: 'postgresql://worker:secret@remote.example/test?sslmode=verify-full&sslmode=disable' },
    { DATABASE_URL: 'postgresql://worker:secret@remote.example/test?sslmode=verify-full&host=elsewhere' },
  ])('rejects unsafe configuration %j', (override) => {
    expect(() => workerConfig({ ...environment, ...override })).toThrow();
  });
  it('requires hostname verification for a remote primary', () => {
    expect(
      workerConfig({
        ...environment,
        DATABASE_URL: 'postgresql://worker:secret@remote.example/test?sslmode=verify-full',
      }).paused,
    ).toBe(true);
  });
  it('refuses an unpaused role serving a provider family without that family’s secrets', () => {
    const families = [{ name: 'worker-probe' }, { name: 'aurora-user-sync' }, { name: 'kilter-user-sync' }];
    expect(() => requireProviderSecrets('interactive-import', families, false, {})).toThrow(
      'AURORA_CREDENTIALS_SECRET, KILTER_OAUTH_CLIENT_ID',
    );
    expect(() =>
      requireProviderSecrets('interactive-import', families, false, { AURORA_CREDENTIALS_SECRET: 'secret' }),
    ).toThrow('KILTER_OAUTH_CLIENT_ID');
    expect(
      requireProviderSecrets('interactive-import', families, false, {
        AURORA_CREDENTIALS_SECRET: 'secret',
        KILTER_OAUTH_CLIENT_ID: 'client',
      }),
    ).toBe(true);
    // A role with no provider family needs nothing.
    expect(requireProviderSecrets('batch', [{ name: 'worker-probe' }], false, {})).toBe(true);
  });
  it('lets a paused role start without provider secrets, but reports it unready', () => {
    const families = [{ name: 'worker-probe' }, { name: 'aurora-user-sync' }, { name: 'kilter-user-sync' }];
    expect(() => requireProviderSecrets('interactive-import', families, true, {})).not.toThrow();
    expect(requireProviderSecrets('interactive-import', families, true, {})).toBe(false);
    expect(
      requireProviderSecrets('interactive-import', families, true, {
        AURORA_CREDENTIALS_SECRET: 'secret',
        KILTER_OAUTH_CLIENT_ID: 'client',
      }),
    ).toBe(true);
  });
});

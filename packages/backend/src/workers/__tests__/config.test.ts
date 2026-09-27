import { describe, expect, it } from 'vitest';
import { ROUTINE_CYCLE_DEFAULTS, requireProviderSecrets, routineCycleLimits, workerConfig } from '../config';

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
  it('reads the routine cycle limits, with defaults of 4 credentials and 3 minutes', () => {
    expect(routineCycleLimits({})).toEqual({ maxCredentials: 4, budgetMs: 120_000 });
    expect(ROUTINE_CYCLE_DEFAULTS).toEqual({ maxCredentials: 4, budgetMs: 120_000 });
    expect(routineCycleLimits({ ROUTINE_CYCLE_MAX_CREDENTIALS: '10', ROUTINE_CYCLE_BUDGET_MS: '60000' })).toEqual({
      maxCredentials: 10,
      budgetMs: 60_000,
    });
  });
  it.each([
    { ROUTINE_CYCLE_MAX_CREDENTIALS: '0' },
    { ROUTINE_CYCLE_MAX_CREDENTIALS: '51' },
    { ROUTINE_CYCLE_MAX_CREDENTIALS: '4.5' },
    { ROUTINE_CYCLE_MAX_CREDENTIALS: 'many' },
    { ROUTINE_CYCLE_BUDGET_MS: '0' },
    // The budget is soft, so it has to leave a credential's worth of the 600 s lease.
    { ROUTINE_CYCLE_BUDGET_MS: '400001' },
    { ROUTINE_CYCLE_BUDGET_MS: '-1' },
  ])('fails worker startup on an invalid routine limit %j', (override) => {
    expect(() => workerConfig({ ...environment, ...override })).toThrow();
  });
  it('needs both provider secrets for the routine families, and none for MoonBoard or the self-heal', () => {
    const routine = [
      { name: 'provider-routine-cycle' },
      { name: 'aurora-shared-sync' },
      { name: 'kilter-catalog-sync' },
      { name: 'moonboard-locations-sync' },
    ];
    expect(() => requireProviderSecrets('routine-provider', routine, false, {})).toThrow(
      'AURORA_CREDENTIALS_SECRET, KILTER_OAUTH_CLIENT_ID',
    );
    expect(() =>
      requireProviderSecrets('routine-provider', [{ name: 'moonboard-locations-sync' }], false, {}),
    ).not.toThrow();
    expect(() =>
      requireProviderSecrets('maintenance-delivery', [{ name: 'climb-stats-self-heal' }], false, {}),
    ).not.toThrow();
  });
});

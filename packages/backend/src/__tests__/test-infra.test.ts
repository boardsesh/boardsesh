import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { withPostgresDatabaseName } from './postgres-url';
import { ensureTestInfrastructure, type TestInfraDependencies } from './test-infra';
import { getWorkerDatabaseUrl } from './worker-db';

const BASE_URL = 'postgresql://test%40er:p%40ss@db.example:15432/audit?sslmode=verify-full&connect_timeout=7';

function dependencies(isPortOpen: TestInfraDependencies['isPortOpen']) {
  return {
    isPortOpen,
    dockerAvailable: vi.fn(() => true),
    startCompose: vi.fn((_services: string[]) => {}),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('test infrastructure with a custom Postgres server', () => {
  it('starts only Redis when the database override is set and local Redis is absent', async () => {
    const checkPort = vi.fn(async (_host: string, port: number) => port !== 6380);
    const infra = dependencies(checkPort);

    await ensureTestInfrastructure(
      {
        ci: false,
        skip: false,
        databaseUrlOverride: BASE_URL,
        postgresPort: 5433,
        redisPort: 6380,
      },
      infra,
    );

    expect(checkPort).toHaveBeenCalledTimes(1);
    expect(checkPort).toHaveBeenCalledWith('127.0.0.1', 6380);
    expect(infra.startCompose).toHaveBeenCalledTimes(1);
    expect(infra.startCompose).toHaveBeenCalledWith(['redis']);
  });

  it('refuses to start local Redis for an unreachable custom Redis URL', async () => {
    const infra = dependencies(vi.fn(async () => false));

    await expect(
      ensureTestInfrastructure(
        {
          ci: false,
          skip: false,
          redisUrl: 'redis://redis.example:16379/2',
          postgresPort: 5433,
          redisPort: 6380,
        },
        infra,
      ),
    ).rejects.toThrow('refusing to start the shared local test Redis');

    expect(infra.startCompose).not.toHaveBeenCalled();
  });

  it('starts only local Postgres when a custom Redis endpoint is reachable', async () => {
    const checkPort = vi.fn(async (_host: string, port: number) => port === 16379);
    const infra = dependencies(checkPort);

    await ensureTestInfrastructure(
      {
        ci: false,
        skip: false,
        redisUrl: 'rediss://redis.example:16379/2',
        postgresPort: 5433,
        redisPort: 6380,
      },
      infra,
    );

    expect(checkPort).toHaveBeenCalledWith('redis.example', 16379);
    expect(infra.startCompose).toHaveBeenCalledTimes(1);
    expect(infra.startCompose).toHaveBeenCalledWith(['db']);
  });
});

describe('PostgreSQL URL database replacement', () => {
  it('preserves credentials, endpoint, and query options for the admin database', () => {
    const adminUrl = new URL(withPostgresDatabaseName(BASE_URL, 'postgres'));

    expect(adminUrl.pathname).toBe('/postgres');
    expect(adminUrl.username).toBe('test%40er');
    expect(adminUrl.password).toBe('p%40ss');
    expect(adminUrl.host).toBe('db.example:15432');
    expect(adminUrl.searchParams.get('sslmode')).toBe('verify-full');
    expect(adminUrl.searchParams.get('connect_timeout')).toBe('7');
  });

  it('preserves URL options in the actual worker database path', () => {
    vi.stubEnv('BOARDSESH_TEST_DATABASE_URL', BASE_URL);
    vi.stubEnv('VITEST_POOL_ID', '3');

    const workerUrl = new URL(getWorkerDatabaseUrl());

    expect(workerUrl.pathname).toBe('/boardsesh_backend_test_w3');
    expect(workerUrl.username).toBe('test%40er');
    expect(workerUrl.password).toBe('p%40ss');
    expect(workerUrl.host).toBe('db.example:15432');
    expect(workerUrl.searchParams.get('sslmode')).toBe('verify-full');
    expect(workerUrl.searchParams.get('connect_timeout')).toBe('7');
  });
});

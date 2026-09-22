import { BACKGROUND_WORKER_ROLES, type BackgroundWorkerRole } from '@boardsesh/db/background-jobs';

export function workerConfig(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const role = environment.WORKER_ROLE;
  if (!BACKGROUND_WORKER_ROLES.includes(role as BackgroundWorkerRole)) throw new Error('Invalid WORKER_ROLE');
  if (environment.READ_REPLICA_URL) throw new Error('Workers must not configure READ_REPLICA_URL');
  for (const [name, expected] of Object.entries({ DB_POOL_MAX: '2', PGBOSS_POOL_SIZE: '1', WORKER_CONCURRENCY: '1' })) {
    if (environment[name] !== undefined && environment[name] !== expected) throw new Error(`Invalid ${name}`);
  }
  if (environment.WORKER_PAUSED !== undefined && !['true', 'false'].includes(environment.WORKER_PAUSED)) {
    throw new Error('WORKER_PAUSED must be true or false');
  }
  if (!environment.DATABASE_URL) throw new Error('Missing DATABASE_URL');
  const database = new URL(environment.DATABASE_URL);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
  const supportedOptions = new Set(['sslmode', 'application_name']);
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    environment.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    [...database.searchParams.keys()].some(
      (name) => !supportedOptions.has(name) || database.searchParams.getAll(name).length !== 1,
    ) ||
    (!local && database.searchParams.get('sslmode') !== 'verify-full')
  )
    throw new Error('DATABASE_URL must unambiguously verify TLS for remote PostgreSQL');
  const healthPort = Number(environment.HEALTH_PORT ?? 9090);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) throw new Error('Invalid HEALTH_PORT');
  return {
    role: role as BackgroundWorkerRole,
    paused: environment.WORKER_PAUSED !== 'false',
    databaseUrl: environment.DATABASE_URL,
    healthPort,
  };
}

export type WorkerConfig = ReturnType<typeof workerConfig>;

/** Call before dynamically importing handlers that might construct DB singletons. */
export function configureWorkerPools(): void {
  process.env.DB_POOL_MAX = '2';
  process.env.PGBOSS_POOL_SIZE = '1';
}

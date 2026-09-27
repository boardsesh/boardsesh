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

/**
 * Secrets a family's provider client reads at run time. Missing ones would
 * only surface on the first job, as a failed sync the climber sees; checking at
 * startup turns that into a worker that refuses to start.
 */
export const PROVIDER_FAMILY_SECRETS: Readonly<Record<string, readonly string[]>> = {
  'aurora-user-sync': ['AURORA_CREDENTIALS_SECRET'],
  'kilter-user-sync': ['AURORA_CREDENTIALS_SECRET', 'KILTER_OAUTH_CLIENT_ID'],
};

/**
 * Refuse to start a worker whose role serves a provider family without that
 * family's secrets. `families` is what the role serves (`familiesForRole`);
 * passed in so this module never imports the registry and the sync packages
 * behind it before `configureWorkerPools` has run.
 */
export function requireProviderSecrets(
  role: BackgroundWorkerRole,
  families: Iterable<{ name: string }>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const missing = new Set<string>();
  for (const family of families) {
    for (const secret of PROVIDER_FAMILY_SECRETS[family.name] ?? []) {
      if (!environment[secret]) missing.add(secret);
    }
  }
  if (missing.size) throw new Error(`Worker role ${role} needs ${[...missing].sort().join(', ')}`);
}

import { BACKGROUND_WORKER_ROLES, type BackgroundWorkerRole } from '@boardsesh/db/background-jobs';
import { logger } from '../utils/logger';

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
  // Validated for every role so a typo fails at boot, not on the first routine cycle.
  routineCycleLimits(environment);
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
  // Both providers, every cycle.
  'provider-routine-cycle': ['AURORA_CREDENTIALS_SECRET', 'KILTER_OAUTH_CLIENT_ID'],
  // The borrowed donor token (or password) is encrypted with it.
  'aurora-shared-sync': ['AURORA_CREDENTIALS_SECRET'],
  // The donor's refresh token, refreshed through Keycloak.
  'kilter-catalog-sync': ['AURORA_CREDENTIALS_SECRET', 'KILTER_OAUTH_CLIENT_ID'],
  // moonboard-locations-sync: MOONBOARD_USERNAME/PASSWORD are optional on
  // purpose. Without them each run succeeds as a logged skip (#3863).
};

/** Defaults for one `provider-routine-cycle` run; see docs/background-workers.md. */
export const ROUTINE_CYCLE_DEFAULTS = { maxCredentials: 4, budgetMs: 180_000 } as const;

/**
 * How much one routine cycle may do: at most `maxCredentials` credentials, and
 * no new credential once `budgetMs` has passed. The budget is soft (a started
 * credential finishes), so it must leave room inside the family's 600 s lease:
 * at most 400 s here. Overridden by `ROUTINE_CYCLE_MAX_CREDENTIALS` /
 * `ROUTINE_CYCLE_BUDGET_MS`.
 */
export function routineCycleLimits(environment: Readonly<Record<string, string | undefined>> = process.env): {
  maxCredentials: number;
  budgetMs: number;
} {
  const read = (name: string, fallback: number, max: number): number => {
    const raw = environment[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    if (!/^\d+$/.test(raw.trim())) throw new Error(`Invalid ${name}`);
    const value = Number(raw.trim());
    if (value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  return {
    maxCredentials: read('ROUTINE_CYCLE_MAX_CREDENTIALS', ROUTINE_CYCLE_DEFAULTS.maxCredentials, 50),
    budgetMs: read('ROUTINE_CYCLE_BUDGET_MS', ROUTINE_CYCLE_DEFAULTS.budgetMs, 400_000),
  };
}

/**
 * Refuse to start a worker whose role serves a provider family without that
 * family's secrets. `families` is what the role serves (`familiesForRole`);
 * passed in so this module never imports the registry and the sync packages
 * behind it before `configureWorkerPools` has run.
 *
 * A paused worker starts anyway: the homelab's first deploy is deliberately
 * paused with only `DATABASE_URL` set, and a paused worker must start and
 * report healthy. Missing secrets are logged once at warn, as a bounded list
 * of env var NAMES only (never values), and the return value tells the caller
 * to report `providerSecretsReady: false`. An unpaused worker keeps the
 * fail-fast behaviour and throws before connecting.
 */
export function requireProviderSecrets(
  role: BackgroundWorkerRole,
  families: Iterable<{ name: string }>,
  paused: boolean,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const missing = new Set<string>();
  for (const family of families) {
    for (const secret of PROVIDER_FAMILY_SECRETS[family.name] ?? []) {
      if (!environment[secret]) missing.add(secret);
    }
  }
  if (!missing.size) return true;
  const missingNames = [...missing].sort();
  const message = `Worker role ${role} needs ${missingNames.join(', ')}`;
  if (!paused) throw new Error(message);
  logger.warn(`[worker] starting paused without provider secrets: ${message}`, { missing: missingNames });
  return false;
}

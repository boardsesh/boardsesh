import type postgres from 'postgres';

/** Per-tool session settings. Every profile opens read-only sessions. */
export interface ExplicitConnectionProfile {
  readonly applicationName: string;
  /** `read-only` accepts a hot standby as well as a primary. */
  readonly targetSessionAttrs: 'primary' | 'read-only';
  readonly statementTimeoutMs: number;
  readonly lockTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  readonly maxLifetimeSeconds: number;
}

/** Carries no detail: the rejected URL can hold a password. */
export class ExplicitConnectionConfigurationError extends Error {
  constructor() {
    super('Database connection configuration was rejected.');
    this.name = 'ExplicitConnectionConfigurationError';
  }
}

/**
 * Builds postgres.js options from one explicit URL. Explicit fields avoid
 * postgres.js URI/startup and ambient PG* precedence, so nothing falls back to
 * DATABASE_URL, PGHOST or PGPASSWORD.
 */
export function explicitReadOnlyConnectionOptions(
  databaseUrl: string | undefined,
  debugSql: string | undefined,
  profile: ExplicitConnectionProfile,
) {
  try {
    if (!databaseUrl || debugSql === 'true' || databaseUrl !== databaseUrl.trim() || /\p{Cc}/u.test(databaseUrl))
      throw new ExplicitConnectionConfigurationError();
    const address = new URL(databaseUrl);
    if (
      !['postgres:', 'postgresql:'].includes(address.protocol) ||
      address.hash ||
      !/^[a-zA-Z0-9.-]+$/.test(address.hostname) ||
      !address.username ||
      !address.pathname.startsWith('/') ||
      address.pathname.length < 2
    )
      throw new ExplicitConnectionConfigurationError();
    const entries = [...address.searchParams.entries()];
    const isLoopback = address.hostname === 'localhost' || address.hostname === '127.0.0.1';
    if (
      entries.length > 1 ||
      entries.some(
        ([key, mode]) => key !== 'sslmode' || (mode !== 'verify-full' && !(isLoopback && mode === 'disable')),
      )
    )
      throw new ExplicitConnectionConfigurationError();
    const username = decodeURIComponent(address.username);
    const password = decodeURIComponent(address.password);
    const database = decodeURIComponent(address.pathname.slice(1));
    const port = address.port ? Number(address.port) : 5432;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ExplicitConnectionConfigurationError();
    if ([username, database].some((part) => !part || /\p{Cc}/u.test(part)) || password.includes('\0'))
      throw new ExplicitConnectionConfigurationError();
    return {
      host: address.hostname,
      port,
      database,
      username,
      // An empty string would fall through to PGPASSWORD in postgres.js 3.4.9.
      password: () => password,
      ssl: isLoopback && entries[0]?.[1] !== 'verify-full' ? (false as const) : { rejectUnauthorized: true },
      sslnegotiation: null,
      max: 1,
      max_pipeline: 1,
      prepare: false,
      debug: false,
      fetch_types: false,
      target_session_attrs: profile.targetSessionAttrs,
      connect_timeout: 10,
      idle_timeout: 5,
      max_lifetime: profile.maxLifetimeSeconds,
      keep_alive: 30,
      backoff: () => 0.1,
      publications: 'alltables',
      onnotice: () => {},
      connection: {
        application_name: profile.applicationName,
        default_transaction_read_only: true,
        statement_timeout: profile.statementTimeoutMs,
        lock_timeout: profile.lockTimeoutMs,
        idle_in_transaction_session_timeout: profile.idleInTransactionTimeoutMs,
      },
      // postgres.js 3.4.9 implements this default but omits its type declaration.
    } satisfies postgres.Options<{}> & { readonly sslnegotiation: null; readonly max_pipeline: 1 };
  } catch {
    throw new ExplicitConnectionConfigurationError();
  }
}

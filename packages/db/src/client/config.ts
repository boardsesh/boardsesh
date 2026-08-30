export type ConnectionConfig = {
  connectionString: string;
  readReplicaUrl: string | null;
  isLocal: boolean;
  isTest: boolean;
};

export function isLocalDevelopment(): boolean {
  return process.env.VERCEL_ENV === 'development' || process.env.NODE_ENV === 'development';
}

export function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

/**
 * The Postgres hostname this process is configured to talk to, lowercased and
 * with IPv6 brackets stripped, or undefined when DATABASE_URL is unset or isn't
 * a parseable URL (a socket path, say). Callers treat "unknown" as "no signal".
 */
function getDatabaseHostname(): string | undefined {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return undefined;

  try {
    const { hostname } = new URL(connectionString);
    if (!hostname) return undefined;
    return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * True for a hostname that can only be a developer machine or a private network:
 * the loopback interface (`vp run dev`'s docker Postgres), a Compose service name,
 * an RFC1918 LAN address, or the Tailnet the shared dev DB lives on —
 * `scripts/dev-db-discover.ts` hands back a `100.64.0.0/10` CGNAT address or a
 * `*.ts.net` name for that one.
 *
 * Production Postgres is a Railway host (`*.railway.internal`, or a public proxy
 * hostname), so none of these can match it.
 *
 * Private IPv6 ranges are deliberately absent. Railway's own private networking
 * is IPv6 unique-local (`fc00::/7`), so a rule that called those "definitely not
 * production" would be one config change away from silencing prod reporting —
 * the exact failure #3603 was filed for. A dev database reached by literal IPv6
 * address stays unrecognised instead, which fails the safe way: it reports.
 */
export function isPrivateHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.local') || hostname.endsWith('.ts.net')) return true;
  // A single-label hostname — `db` (packages/backend/docker-compose.yml),
  // `postgres` / `postgres-test` (the e2e and test stacks), any other Compose
  // service name — resolves only through container DNS or /etc/hosts, so it can
  // never be the production database, which is a multi-label Railway host. This
  // is the general form of the `postgres` / `postgres-test` entries in
  // LOCAL_HOST_PATTERN over in ./postgres.ts; the two lists can't be shared
  // because this module has to stay import-free for instrument.ts.
  if (!hostname.includes('.') && !hostname.includes(':')) return true;
  // The IPv6 loopback/unspecified forms, plus IPv4's unspecified address, which
  // the octet ranges below deliberately don't cover (0.0.0.0 is its own case, not
  // part of any private block). Keep this check — nothing else catches them.
  if (hostname === '::1' || hostname === '::' || hostname === '0.0.0.0') return true;

  const ipv4Octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(hostname);
  if (!ipv4Octets) return false;

  const firstOctet = Number(ipv4Octets[1]);
  const secondOctet = Number(ipv4Octets[2]);
  if (firstOctet === 127 || firstOctet === 10) return true;
  if (firstOctet === 192 && secondOctet === 168) return true;
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) return true;
  // Tailscale CGNAT range — a tailnet dev DB, never production.
  if (firstOctet === 100 && secondOctet >= 64 && secondOctet <= 127) return true;
  return false;
}

/**
 * Whether DATABASE_URL points at a developer machine or a private network. This
 * is the signal that catches a locally-run *production-shaped* backend — one
 * started with `pnpm --filter boardsesh-backend run start`, which (unlike the `dev` script) sets no
 * NODE_ENV, so every other check reads it as prod. That is how a laptop's dev DB
 * ended up filing `write CONNECTION_CLOSED localhost:5440` against the
 * production Sentry project.
 */
export function isPrivateDatabaseTarget(): boolean {
  const hostname = getDatabaseHostname();
  return hostname !== undefined && isPrivateHostname(hostname);
}

/**
 * True inside a GitHub Actions job. The generic `CI` var is deliberately not
 * used: Railway sets it during a build, and a runtime false positive here would
 * silence production Sentry outright (the #3603 regression). GITHUB_ACTIONS is
 * only ever set by the Actions runner, so e2e/workflow backends stop reporting
 * and Railway prod is untouched.
 */
function isContinuousIntegration(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

/**
 * Any runtime that is definitionally not production, whatever the env vars claim:
 * local dev, the test runner, a CI job, or a process wired to a private database.
 */
function isNonProductionRuntime(): boolean {
  return isLocalDevelopment() || isTestEnvironment() || isContinuousIntegration() || isPrivateDatabaseTarget();
}

/**
 * The backend's resolved Sentry `environment`. SENTRY_ENVIRONMENT (Sentry's
 * standard var) names the environment for a hosted deploy; otherwise 'production'
 * in a prod-like runtime (Railway leaves NODE_ENV unset — see issue #3603) and
 * NODE_ENV / 'development' anywhere that isn't production.
 *
 * An explicit SENTRY_ENVIRONMENT='production' does not override the runtime
 * checks, because the prod DSN is hardcoded as a fallback: a prod env file copied
 * onto a laptop would otherwise be enough to make it report as prod. Every other
 * explicit value (preview, staging) still wins outright, so branch deploys keep
 * their own name.
 *
 * There is deliberately no local escape hatch: no env var re-opens production
 * reporting from a laptop or a CI runner, because the events would land in the
 * live project indistinguishable from real ones. Smoke-test the wiring against a
 * scratch project by pointing SENTRY_DSN at it instead.
 *
 * Single source of truth for both the `Sentry.init({ enabled, environment })`
 * gate in the backend's instrument.ts and the SentryWinstonTransport gate, so
 * the two can't drift.
 */
export function resolveSentryEnvironment(): string {
  const explicit = process.env.SENTRY_ENVIRONMENT;
  if (explicit && explicit !== 'production') return explicit;
  if (isNonProductionRuntime()) {
    // NODE_ENV names the runtime here, except when it *also* says 'production' —
    // a prod-shaped NODE_ENV on a laptop or a CI runner is exactly the claim the
    // checks above just disproved, and echoing it would re-open the gate.
    const nodeEnv = process.env.NODE_ENV;
    return nodeEnv && nodeEnv !== 'production' ? nodeEnv : 'development';
  }
  return 'production';
}

/**
 * Whether the backend should report to the *production* Sentry project. Only a
 * resolved environment of 'production' sends. Preview / staging deploys run with
 * NODE_ENV=production too (branch-deploy.yml) and are otherwise indistinguishable
 * from real prod, so they declare SENTRY_ENVIRONMENT=preview and stay out. Railway
 * prod leaves both NODE_ENV and SENTRY_ENVIRONMENT unset and connects to a Railway
 * host, so it resolves to 'production' and remains enabled (no ops change, keeps
 * the #3603 fix intact).
 */
export function isProductionSentryEnvironment(): boolean {
  return resolveSentryEnvironment() === 'production';
}

export function getConnectionConfig(): ConnectionConfig {
  const connectionString = process.env.DATABASE_URL;
  const readReplicaUrl = process.env.READ_REPLICA_URL || null;
  const isLocal = isLocalDevelopment();
  const isTest = isTestEnvironment();

  if (!connectionString && isLocal && !isTest) {
    return {
      connectionString: 'postgres://postgres:password@localhost:5432/main',
      readReplicaUrl,
      isLocal,
      isTest,
    };
  }

  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  return { connectionString, readReplicaUrl, isLocal, isTest };
}

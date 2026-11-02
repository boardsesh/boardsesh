import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDirectory, '..');
const drizzleDirectory = join(repoRoot, 'packages/db/drizzle');
const generatedEnvDirectory = join(repoRoot, '.boardsesh');
const generatedEnvFile = join(generatedEnvDirectory, 'dev-db.env');

const postgresPort = 5432;
const redisPort = 6379;
const postgresUser = 'postgres';
const postgresPassword = 'password';
const postgresDatabase = 'main';
const postgresProbeTimeoutMs = 2500;
const redisProbeTimeoutMs = 800;
const tailscaleStatusTimeoutMs = 1500;
const maxTailscaleCandidates = 32;
// Per-candidate ceiling covering the Postgres shape probe, the Redis port
// probe, and connection teardown, so a single wedged candidate can never
// stall the Promise.all in discoverDatabases().
const probeCandidateBudgetMs = postgresProbeTimeoutMs + redisProbeTimeoutMs + 1_000;
// See https://github.com/boardsesh/boardsesh/issues/3874: postgres.js
// `client.end()` can leave a promise unsettled after its socket handle is
// destroyed on a half-open connection. With no live timer/handle left, Node
// treats the event loop as drained and exits 0 mid-`await` instead
// of hanging or throwing. This watchdog keeps a real timer alive around
// discovery so that scenario surfaces as a loud, actionable timeout instead
// of a silent premature exit.
const discoveryWatchdogTimeoutMs = 30_000;

type CandidateSource = 'local-standalone' | 'tailscale' | 'env';

type DatabaseCandidate = {
  host: string;
  label: string;
  source: CandidateSource;
};

type DatabaseSelection = DatabaseCandidate & {
  connectionString: string;
  redisUrl: string | null;
};

type TailscaleNode = {
  DNSName?: unknown;
  HostName?: unknown;
  TailscaleIPs?: unknown;
  Online?: unknown;
};

type TailscaleStatus = {
  Peer?: Record<string, TailscaleNode>;
};

type MigrationJournalEntry = {
  tag: string;
  when: number;
};

type MigrationJournal = {
  entries: MigrationJournalEntry[];
};

type MigrationTrackerRow = {
  created_at: number | string | null;
};

type BoardseshShapeRow = {
  has_board_products: boolean;
  has_board_climbs: boolean;
  has_migration_tracker: boolean;
};

type CountRow = {
  product_count: number | string;
};

function normalizeHost(rawHost: string | undefined): string | null {
  const trimmedHost = rawHost?.trim().replace(/\.$/, '');
  if (!trimmedHost) return null;
  if (trimmedHost.includes('://') || trimmedHost.includes('/')) return null;
  if (!/^[a-zA-Z0-9.:-]+$/.test(trimmedHost)) return null;
  return trimmedHost.toLowerCase();
}

function hostForConnectionString(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function buildPostgresUrl(host: string): string {
  const encodedUser = encodeURIComponent(postgresUser);
  const encodedPassword = encodeURIComponent(postgresPassword);
  const encodedHost = hostForConnectionString(host);
  return `postgresql://${encodedUser}:${encodedPassword}@${encodedHost}:${postgresPort}/${postgresDatabase}`;
}

function buildRedisUrl(host: string): string {
  return `redis://${hostForConnectionString(host)}:${redisPort}`;
}

async function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePortCheck) => {
    const socket = createConnection({ host, port });
    let settled = false;

    function finish(isOpen: boolean): void {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePortCheck(isOpen);
    }

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  // ReturnType<typeof setTimeout> adapts to whichever lib the type-checker
  // resolves (Node's Timeout handle or the DOM number).
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export class DiscoveryTimeoutError extends Error {}

/**
 * Races `operation` against a real (non-unref'd) timer. The live timer
 * handle is the point: it is what keeps the runtime's event loop from
 * deciding "nothing left to do" and exiting 0 while `operation` is stuck
 * unsettled (see the module-level comment on `discoveryWatchdogTimeoutMs`).
 * The timer is always cleared once either side settles.
 */
export async function raceAgainstWatchdog<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const watchdog = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new DiscoveryTimeoutError(`Discovery timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([operation, watchdog]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function isBoardseshDevDatabase(client: postgres.Sql): Promise<boolean> {
  const shapeRows = await client<BoardseshShapeRow[]>`
    SELECT
      to_regclass('public.board_products') IS NOT NULL AS has_board_products,
      to_regclass('public.board_climbs') IS NOT NULL AS has_board_climbs,
      (
        to_regclass('drizzle.__drizzle_migrations') IS NOT NULL
        OR to_regclass('public.__drizzle_migrations') IS NOT NULL
      ) AS has_migration_tracker
  `;
  const shape = shapeRows[0];
  if (!shape?.has_board_products || !shape.has_board_climbs || !shape.has_migration_tracker) {
    return false;
  }

  const countRows = await client<CountRow[]>`
    SELECT count(*)::int AS product_count
    FROM public.board_products
  `;
  return Number(countRows[0]?.product_count ?? 0) > 0;
}

async function probeDatabaseCandidate(candidate: DatabaseCandidate): Promise<DatabaseSelection | null> {
  // Bound the entire probe (including connection teardown) so one wedged
  // candidate can never stall the Promise.all in discoverDatabases() -- see
  // the module-level comment on probeCandidateBudgetMs.
  return withTimeout(probeDatabaseCandidateUnbounded(candidate), probeCandidateBudgetMs).catch(() => null);
}

async function probeDatabaseCandidateUnbounded(candidate: DatabaseCandidate): Promise<DatabaseSelection | null> {
  const connectionString = buildPostgresUrl(candidate.host);
  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: Math.ceil(postgresProbeTimeoutMs / 1000),
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    const isBoardseshDatabase = await withTimeout(isBoardseshDevDatabase(client), postgresProbeTimeoutMs);
    if (!isBoardseshDatabase) return null;

    const hasRedis = await isTcpPortOpen(candidate.host, redisPort, redisProbeTimeoutMs);
    return {
      ...candidate,
      connectionString,
      redisUrl: hasRedis ? buildRedisUrl(candidate.host) : null,
    };
  } catch {
    return null;
  } finally {
    // Force-close after 1s instead of waiting indefinitely for in-flight
    // queries to settle on a half-open/filtered socket (issue #3874).
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

function uniqueCandidates(candidates: DatabaseCandidate[]): DatabaseCandidate[] {
  const seenHosts = new Set<string>();
  const unique: DatabaseCandidate[] = [];

  for (const candidate of candidates) {
    if (seenHosts.has(candidate.host)) continue;
    seenHosts.add(candidate.host);
    unique.push(candidate);
  }

  return unique;
}

function hostCandidatesFromNode(node: TailscaleNode, labelFallback: string): DatabaseCandidate[] {
  const candidates: DatabaseCandidate[] = [];
  const dnsName = typeof node.DNSName === 'string' ? normalizeHost(node.DNSName) : null;
  const hostName = typeof node.HostName === 'string' ? node.HostName : labelFallback;
  if (dnsName) {
    candidates.push({ host: dnsName, label: hostName, source: 'tailscale' });
  }

  if (Array.isArray(node.TailscaleIPs)) {
    for (const tailscaleIp of node.TailscaleIPs) {
      if (typeof tailscaleIp !== 'string') continue;
      const normalizedIp = normalizeHost(tailscaleIp);
      if (normalizedIp) {
        candidates.push({ host: normalizedIp, label: hostName, source: 'tailscale' });
      }
    }
  }

  return candidates;
}

function tailscaleCandidates(): DatabaseCandidate[] {
  try {
    const statusJson = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: tailscaleStatusTimeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsedStatus = JSON.parse(statusJson) as TailscaleStatus;
    const peerEntries = Object.entries(parsedStatus.Peer ?? {});
    const onlinePeers = peerEntries.filter(([, peer]) => peer.Online === true);
    const peerCandidates = onlinePeers.flatMap(([peerId, peer]) => hostCandidatesFromNode(peer, peerId));
    return uniqueCandidates(peerCandidates).slice(0, maxTailscaleCandidates);
  } catch {
    return [];
  }
}

// Every responding database in preference order. A local database is always
// ours to migrate, so it ends the search; otherwise the caller gates each
// remote candidate on its own migration state and takes the first usable one.
async function discoverDatabases(): Promise<DatabaseSelection[]> {
  const localCandidate: DatabaseCandidate = {
    host: 'localhost',
    label: 'localhost',
    source: 'local-standalone',
  };
  const localSelection = await probeDatabaseCandidate(localCandidate);
  if (localSelection) return [localSelection];

  const selections: DatabaseSelection[] = [];
  const explicitHost = normalizeHost(process.env.BOARDSESH_DEV_DB_HOST);
  if (explicitHost && explicitHost !== 'localhost' && explicitHost !== '127.0.0.1') {
    const explicitSelection = await probeDatabaseCandidate({
      host: explicitHost,
      label: explicitHost,
      source: 'env',
    });
    if (explicitSelection) selections.push(explicitSelection);
  }

  const candidates = tailscaleCandidates();
  if (candidates.length > 0) {
    const probeResults = await Promise.all(candidates.map((candidate) => probeDatabaseCandidate(candidate)));
    selections.push(...probeResults.filter((selection): selection is DatabaseSelection => selection !== null));
  }
  return selections;
}

async function ensureMigrationTracker(client: postgres.Sql): Promise<void> {
  await client`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await client`
    CREATE TABLE IF NOT EXISTS drizzle."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const publicTrackerRows = await client<{ public_tracker_exists: boolean }[]>`
    SELECT to_regclass('public.__drizzle_migrations') IS NOT NULL AS public_tracker_exists
  `;
  if (!publicTrackerRows[0]?.public_tracker_exists) return;

  await client`
    INSERT INTO drizzle."__drizzle_migrations" (hash, created_at)
    SELECT hash, created_at
    FROM public."__drizzle_migrations"
    WHERE NOT EXISTS (SELECT 1 FROM drizzle."__drizzle_migrations" LIMIT 1)
      AND EXISTS (SELECT 1 FROM public."__drizzle_migrations" LIMIT 1)
    ORDER BY id
  `;
}

export function loadMigrationJournal(): MigrationJournal {
  const journalPath = join(drizzleDirectory, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournal;
  return {
    entries: journal.entries.filter(
      (entry): entry is MigrationJournalEntry => typeof entry.tag === 'string' && typeof entry.when === 'number',
    ),
  };
}

export type MigrationTargetDecision =
  | { action: 'use' }
  | { action: 'migrate' }
  | { action: 'skip-remote'; message: string };

// Only a database on this machine may be migrated. A Tailscale peer or an
// env-provided host belongs to someone else: each migration commits on its
// own, so a failure partway (0272 needs a cutoff helper that only installs on
// a local host) would leave their database half-migrated. See #6497.
export function decideMigrationTarget(
  selection: Pick<DatabaseCandidate, 'source' | 'host' | 'label'>,
  pendingTags: string[],
): MigrationTargetDecision {
  if (pendingTags.length === 0) return { action: 'use' };
  if (selection.source === 'local-standalone') return { action: 'migrate' };

  const firstTag = pendingTags[0];
  const lastTag = pendingTags[pendingTags.length - 1];
  return {
    action: 'skip-remote',
    message:
      `[dev-db] ${selection.label} (${selection.host}:${postgresPort}) is behind this checkout by ` +
      `${pendingTags.length} migration(s) (${firstTag} to ${lastTag}). Not migrating another machine's database. ` +
      'Run `vp run db:up` on that machine to bring it up to date. Falling back to local Docker, which must be installed.',
  };
}

function createMigrationClient(connectionString: string): postgres.Sql {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });
}

async function readTrackerCreatedAt(client: postgres.Sql, trackerSchema: 'drizzle' | 'public'): Promise<number> {
  const trackerRows =
    trackerSchema === 'drizzle'
      ? await client<MigrationTrackerRow[]>`
          SELECT COALESCE((SELECT created_at FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1), 0) AS created_at
        `
      : await client<MigrationTrackerRow[]>`
          SELECT COALESCE((SELECT created_at FROM public."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1), 0) AS created_at
        `;
  return Number(trackerRows[0]?.created_at ?? 0);
}

// Read-only: unlike ensureMigrationTracker this never creates the tracker, so
// it is safe to point at a database that is not ours. The drizzle tracker only
// counts when it has rows: an empty one beside a populated public tracker is
// the state ensureMigrationTracker is about to fill from public.
async function readLastMigrationCreatedAt(client: postgres.Sql): Promise<number> {
  const existenceRows = await client<{ has_drizzle: boolean; has_public: boolean }[]>`
    SELECT
      to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS has_drizzle,
      to_regclass('public.__drizzle_migrations') IS NOT NULL AS has_public
  `;
  const { has_drizzle: hasDrizzle, has_public: hasPublic } = existenceRows[0] ?? {
    has_drizzle: false,
    has_public: false,
  };
  const drizzleCreatedAt = hasDrizzle ? await readTrackerCreatedAt(client, 'drizzle') : 0;
  if (drizzleCreatedAt > 0) return drizzleCreatedAt;
  return hasPublic ? await readTrackerCreatedAt(client, 'public') : 0;
}

async function listPendingMigrations(client: postgres.Sql): Promise<MigrationJournalEntry[]> {
  const lastMigrationCreatedAt = await readLastMigrationCreatedAt(client);
  return loadMigrationJournal().entries.filter((entry) => entry.when > lastMigrationCreatedAt);
}

async function applyPendingMigrations(client: postgres.Sql, pendingMigrations: MigrationJournalEntry[]): Promise<void> {
  await ensureMigrationTracker(client);

  console.info(`  Applying ${pendingMigrations.length} pending migration(s) from ${drizzleDirectory}...`);
  for (const migration of pendingMigrations) {
    const migrationFile = join(drizzleDirectory, `${migration.tag}.sql`);
    const migrationSql = readFileSync(migrationFile, 'utf8');
    const migrationHash = createHash('sha256').update(migrationSql).digest('hex');
    console.info(`    -> ${migration.tag}`);

    await client.unsafe('BEGIN');
    try {
      await client.unsafe(migrationSql);
      await client`
        INSERT INTO drizzle."__drizzle_migrations" (hash, created_at)
        VALUES (${migrationHash}, ${migration.when})
      `;
      await client.unsafe('COMMIT');
    } catch (migrationError) {
      await client.unsafe('ROLLBACK').catch(() => undefined);
      throw migrationError;
    }
  }
}

// 0272 reads a cutoff helper that only exists once the bootstrap script has
// run. Docker installs it in dev-db-up.sh; a standalone local Postgres has to
// get it here, before any migration commits, or 0265-0271 land and 0272 fails.
const cutoffGuardMigrationTag = 'sync_deletions_cutoff';

function installSyncDeletionsCutoffHelper(): void {
  const databaseDirectory = join(repoRoot, 'packages/db');
  const environment = { ...process.env };
  for (const name of ['DB_URL', 'POSTGRES_URL', 'DATABASE_URL', 'SYNC_CUTOFF_RUNTIME_ROLE']) delete environment[name];
  execFileSync(
    join(repoRoot, 'node_modules/.bin/tsx'),
    ['scripts/bootstrap-sync-deletions-cutoff-development.ts', '--apply'],
    {
      cwd: databaseDirectory,
      stdio: 'inherit',
      env: {
        ...environment,
        SYNC_CUTOFF_DEVELOPMENT_BOOTSTRAP: 'true',
        SYNC_CUTOFF_ADMIN_DATABASE_URL: `postgresql://${postgresUser}:${postgresPassword}@localhost:${postgresPort}/${postgresDatabase}`,
      },
    },
  );
}

export type PrepareMigrationsOptions = {
  client?: postgres.Sql;
  installCutoffHelper?: () => void;
};

// Returns false when the database is another machine's and is behind: the
// caller must not use it.
export async function prepareMigrations(
  selection: Pick<DatabaseSelection, 'source' | 'host' | 'label' | 'connectionString'>,
  options: PrepareMigrationsOptions = {},
): Promise<boolean> {
  const client = options.client ?? createMigrationClient(selection.connectionString);
  const installCutoffHelper = options.installCutoffHelper ?? installSyncDeletionsCutoffHelper;

  try {
    const pendingMigrations = await listPendingMigrations(client);
    const decision = decideMigrationTarget(
      selection,
      pendingMigrations.map((migration) => migration.tag),
    );

    if (decision.action === 'skip-remote') {
      console.warn(decision.message);
      return false;
    }
    if (decision.action === 'use') {
      console.info('  No pending migrations.');
      return true;
    }
    // Match on the tag, not the number: the renumber bot may move 0272.
    const needsCutoffHelper = pendingMigrations.some((migration) => migration.tag.includes(cutoffGuardMigrationTag));
    if (needsCutoffHelper) installCutoffHelper();
    await applyPendingMigrations(client, pendingMigrations);
    return true;
  } finally {
    // Bound teardown for the same reason as probeDatabaseCandidateUnbounded
    // above -- see the module-level comment on discoveryWatchdogTimeoutMs.
    await client.end({ timeout: 5 }).catch(() => undefined);
  }
}

function writeGeneratedEnv(selection: DatabaseSelection): void {
  mkdirSync(generatedEnvDirectory, { recursive: true });
  const redisValue = selection.redisUrl ?? '';
  const envContent = [
    '# Generated by scripts/dev-db-discover.ts or scripts/dev-db-up.sh.',
    '# Do not edit by hand; rerun `vp run db:up`.',
    `BOARDSESH_DEV_DB_SOURCE=${selection.source}`,
    'BOARDSESH_DEV_DB_PLAINTEXT=true',
    `BOARDSESH_DEV_DB_HOST=${selection.host}`,
    `DATABASE_URL=${selection.connectionString}`,
    `POSTGRES_URL=${selection.connectionString}`,
    `POSTGRES_HOST=${selection.host}`,
    `POSTGRES_PORT=${postgresPort}`,
    `POSTGRES_USER=${postgresUser}`,
    `POSTGRES_PASSWORD=${postgresPassword}`,
    `POSTGRES_DATABASE=${postgresDatabase}`,
    `REDIS_URL=${redisValue}`,
    '',
  ].join('\n');
  writeFileSync(generatedEnvFile, envContent, 'utf8');
}

function clearGeneratedEnv(): void {
  if (!existsSync(generatedEnvFile)) return;
  rmSync(generatedEnvFile);
}

async function main(): Promise<void> {
  let selections: DatabaseSelection[];
  try {
    // Watchdog covers discovery only -- migrations can legitimately take
    // minutes and must not be raced against this timer.
    selections = await raceAgainstWatchdog(discoverDatabases(), discoveryWatchdogTimeoutMs);
  } catch (error) {
    if (!(error instanceof DiscoveryTimeoutError)) throw error;
    clearGeneratedEnv();
    console.error(
      `[dev-db] ${error.message}; falling back to Docker. See https://github.com/boardsesh/boardsesh/issues/3874.`,
    );
    process.exit(2);
  }

  if (selections.length === 0) {
    clearGeneratedEnv();
    console.info('[dev-db] No local or Tailscale Boardsesh dev database found.');
    process.exit(2);
  }

  // First candidate that is current (or ours to migrate) wins; a peer that is
  // behind is skipped, not fatal, while another peer may be fine.
  for (const selection of selections) {
    const sourceLabel = selection.source === 'tailscale' ? `Tailscale peer ${selection.label}` : selection.label;
    console.info(`[dev-db] Trying ${sourceLabel} Postgres at ${selection.host}:${postgresPort}.`);
    console.info('[dev-db] Checking for pending migrations...');
    if (!(await prepareMigrations(selection))) continue;

    if (selection.redisUrl) {
      console.info(`[dev-db] Redis available at ${selection.redisUrl}.`);
    } else {
      console.info('[dev-db] Redis not reachable; backend will run in local-only pub/sub mode.');
    }
    writeGeneratedEnv(selection);

    console.info('');
    console.info('Development database is ready.');
    console.info('  Test user: test@boardsesh.com / test');
    return;
  }

  clearGeneratedEnv();
  process.exit(2);
}

function isEntryPoint(): boolean {
  const entryPath = process.argv[1];
  return entryPath !== undefined && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
}

// Guarded so importing this module (e.g. from Vitest) never runs main() or
// triggers its process.exit() side effects. tsx compiles this file to CJS in
// this repository, where import.meta.main is undefined, so compare real paths.
if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error('[dev-db] Failed to discover or prepare a dev database:', error);
    process.exit(1);
  });
}

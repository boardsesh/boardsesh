import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    await client.end().catch(() => undefined);
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

async function discoverDatabase(): Promise<DatabaseSelection | null> {
  const localCandidate: DatabaseCandidate = {
    host: 'localhost',
    label: 'localhost',
    source: 'local-standalone',
  };
  const localSelection = await probeDatabaseCandidate(localCandidate);
  if (localSelection) return localSelection;

  const explicitHost = normalizeHost(process.env.BOARDSESH_DEV_DB_HOST);
  if (explicitHost && explicitHost !== 'localhost' && explicitHost !== '127.0.0.1') {
    const explicitSelection = await probeDatabaseCandidate({
      host: explicitHost,
      label: explicitHost,
      source: 'env',
    });
    if (explicitSelection) return explicitSelection;
  }

  const candidates = tailscaleCandidates();
  if (candidates.length === 0) return null;

  const probeResults = await Promise.all(candidates.map((candidate) => probeDatabaseCandidate(candidate)));
  return probeResults.find((selection): selection is DatabaseSelection => selection !== null) ?? null;
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

function loadMigrationJournal(): MigrationJournal {
  const journalPath = join(drizzleDirectory, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as MigrationJournal;
  return {
    entries: journal.entries.filter(
      (entry): entry is MigrationJournalEntry => typeof entry.tag === 'string' && typeof entry.when === 'number',
    ),
  };
}

async function runPendingMigrations(connectionString: string): Promise<void> {
  const client = postgres(connectionString, {
    max: 1,
    idle_timeout: 1,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    await ensureMigrationTracker(client);
    const migrationTrackerRows = await client<MigrationTrackerRow[]>`
      SELECT COALESCE(
        (SELECT created_at FROM drizzle."__drizzle_migrations" ORDER BY created_at DESC LIMIT 1),
        0
      ) AS created_at
    `;
    const lastMigrationCreatedAt = Number(migrationTrackerRows[0]?.created_at ?? 0);
    const pendingMigrations = loadMigrationJournal().entries.filter((entry) => entry.when > lastMigrationCreatedAt);

    if (pendingMigrations.length === 0) {
      console.info('  No pending migrations.');
      return;
    }

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
  } finally {
    await client.end().catch(() => undefined);
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
  const selection = await discoverDatabase();
  if (!selection) {
    clearGeneratedEnv();
    console.info('[dev-db] No local or Tailscale Boardsesh dev database found.');
    process.exit(2);
  }

  const sourceLabel = selection.source === 'tailscale' ? `Tailscale peer ${selection.label}` : selection.label;
  console.info(`[dev-db] Using ${sourceLabel} Postgres at ${selection.host}:${postgresPort}.`);
  if (selection.redisUrl) {
    console.info(`[dev-db] Redis available at ${selection.redisUrl}.`);
  } else {
    console.info('[dev-db] Redis not reachable; backend will run in local-only pub/sub mode.');
  }

  console.info('[dev-db] Checking for pending migrations...');
  await runPendingMigrations(selection.connectionString);
  writeGeneratedEnv(selection);

  console.info('');
  console.info('Development database is ready.');
  console.info('  Test user: test@boardsesh.com / test');
}

main().catch((error: unknown) => {
  console.error('[dev-db] Failed to discover or prepare a dev database:', error);
  process.exit(1);
});

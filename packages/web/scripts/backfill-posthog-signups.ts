import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { v5 as uuidv5 } from 'uuid';
import { users } from '@boardsesh/db/schema/auth';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

config({ path: path.resolve(__dirname, '../../../.boardsesh/dev-db.env') });
config({ path: path.resolve(__dirname, '../../../.env.local') });
config({ path: path.resolve(__dirname, '../.env.local') });
config({ path: path.resolve(__dirname, '../.env.development.local') });

// Hardcoded namespace so re-runs derive the same event UUIDs. PostHog
// deduplicates on (distinct_id, event, timestamp, uuid), so this is what
// makes the backfill idempotent.
const POSTHOG_BACKFILL_NAMESPACE = 'a8f2d9e1-3c7b-4d5a-9e6f-1b2c3d4e5f60';
const BATCH_SIZE = 1000;
const INTER_BATCH_DELAY_MS = 200;

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
};

type LogbookStats = {
  firstClimbedAtIso: string;
  firstStatus: string;
  firstBoardType: string;
  entryCount: number;
};

type LogbookStatsRow = {
  user_id: string;
  entry_count: number;
  first_climbed_at: Date | string;
  first_status: string;
  first_board_type: string;
};

type Args = {
  dryRun: boolean;
  limit: number | null;
  userId: string | null;
  skipLogbook: boolean;
};

type PosthogEvent = {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
  uuid: string;
};

type ScriptDb = ReturnType<typeof drizzle>;

function parseArgs(argv: string[]): Args {
  const parsed: Args = { dryRun: false, limit: null, userId: null, skipLogbook: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
    } else if (arg === '--skip-logbook') {
      parsed.skipLogbook = true;
    } else if (arg === '--limit') {
      const next = argv[++i];
      const asNumber = Number(next);
      if (!Number.isFinite(asNumber) || asNumber <= 0) {
        console.error(`--limit requires a positive integer, got: ${next}`);
        process.exit(1);
      }
      parsed.limit = Math.floor(asNumber);
    } else if (arg === '--user-id') {
      const next = argv[++i];
      if (!next) {
        console.error('--user-id requires a value');
        process.exit(1);
      }
      parsed.userId = next;
    } else {
      console.error(`Unknown argument: ${arg}`);
      console.error(
        'Usage: tsx scripts/backfill-posthog-signups.ts [--dry-run] [--limit N] [--user-id <id>] [--skip-logbook]',
      );
      process.exit(1);
    }
  }
  return parsed;
}

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL or POSTGRES_URL is not set');
    process.exit(1);
  }
  return databaseUrl;
}

async function loadLogbookStats(db: ScriptDb): Promise<Map<string, LogbookStats>> {
  // Raw CTE: drizzle's query builder doesn't express DISTINCT ON cleanly,
  // and CLAUDE.md sanctions raw SQL for this kind of aggregation.
  const result = await db.execute(sql`
    WITH first_entries AS (
      SELECT DISTINCT ON (user_id)
        user_id,
        climbed_at AS first_climbed_at,
        status AS first_status,
        board_type AS first_board_type
      FROM boardsesh_ticks
      ORDER BY user_id, climbed_at ASC
    ),
    entry_counts AS (
      SELECT user_id, COUNT(*)::int AS entry_count
      FROM boardsesh_ticks
      GROUP BY user_id
    )
    SELECT
      c.user_id,
      c.entry_count,
      f.first_climbed_at,
      f.first_status,
      f.first_board_type
    FROM entry_counts c
    LEFT JOIN first_entries f ON f.user_id = c.user_id
  `);

  const stats = new Map<string, LogbookStats>();
  for (const raw of result as unknown as LogbookStatsRow[]) {
    const climbedAt = raw.first_climbed_at instanceof Date ? raw.first_climbed_at : new Date(raw.first_climbed_at);
    stats.set(raw.user_id, {
      firstClimbedAtIso: climbedAt.toISOString(),
      firstStatus: raw.first_status,
      firstBoardType: raw.first_board_type,
      entryCount: raw.entry_count,
    });
  }
  return stats;
}

function identifyEvent(user: UserRow, stats?: LogbookStats): PosthogEvent {
  const createdAtIso = user.createdAt.toISOString();
  const yearMonth = createdAtIso.slice(0, 7);

  const setProps: Record<string, string | number> = { email: user.email };
  if (user.name) setProps.name = user.name;
  if (stats) setProps.logbook_entry_count = stats.entryCount;

  const setOnceProps: Record<string, string | boolean> = {
    signup_date: createdAtIso,
    signup_year_month: yearMonth,
    backfilled: true,
  };
  if (stats) {
    setOnceProps.first_logbook_entry_at = stats.firstClimbedAtIso;
    setOnceProps.first_logbook_board_type = stats.firstBoardType;
  }

  return {
    event: '$identify',
    properties: {
      distinct_id: user.id,
      $set: setProps,
      $set_once: setOnceProps,
    },
    timestamp: createdAtIso,
    uuid: uuidv5(`${user.id}:identify`, POSTHOG_BACKFILL_NAMESPACE),
  };
}

function signupEvent(user: UserRow): PosthogEvent {
  const createdAtIso = user.createdAt.toISOString();
  return {
    event: 'user_signed_up',
    properties: {
      distinct_id: user.id,
      signup_source: 'backfill',
    },
    timestamp: createdAtIso,
    uuid: uuidv5(`${user.id}:signup`, POSTHOG_BACKFILL_NAMESPACE),
  };
}

function firstLogbookEntryEvent(user: UserRow, stats: LogbookStats): PosthogEvent {
  return {
    event: 'first_logbook_entry',
    properties: {
      distinct_id: user.id,
      tick_status: stats.firstStatus,
      board_type: stats.firstBoardType,
      entry_count_at_backfill: stats.entryCount,
    },
    timestamp: stats.firstClimbedAtIso,
    uuid: uuidv5(`${user.id}:first_logbook_entry`, POSTHOG_BACKFILL_NAMESPACE),
  };
}

function eventsForUser(user: UserRow, stats: LogbookStats | undefined): PosthogEvent[] {
  const out: PosthogEvent[] = [identifyEvent(user, stats), signupEvent(user)];
  if (stats) out.push(firstLogbookEntryEvent(user, stats));
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBatch(host: string, apiKey: string, events: PosthogEvent[]): Promise<void> {
  const response = await fetch(`${host}/batch/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      historical_migration: true,
      batch: events,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '<no body>');
    throw new Error(`PostHog batch failed: ${response.status} ${response.statusText} — ${body}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = getDatabaseUrl();
  const dbHost = databaseUrl.split('@')[1]?.split('/')[0] ?? 'unknown';
  console.info(`Connecting to: ${dbHost}`);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  const baseSelect = db
    .select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt })
    .from(users);
  let rows: UserRow[];
  if (args.userId) {
    rows = await baseSelect.where(eq(users.id, args.userId));
  } else if (args.limit) {
    rows = await baseSelect.limit(args.limit);
  } else {
    rows = await baseSelect;
  }

  if (rows.length === 0) {
    console.warn('No users matched. Nothing to do.');
    await client.end();
    return;
  }

  console.info(`Found ${rows.length} user${rows.length === 1 ? '' : 's'} to backfill.`);

  const logbookStats = args.skipLogbook ? new Map<string, LogbookStats>() : await loadLogbookStats(db);
  if (!args.skipLogbook) {
    const withEntries = rows.filter((row) => logbookStats.has(row.id)).length;
    console.info(`Loaded logbook stats: ${withEntries}/${rows.length} matched users have ≥1 logbook entry.`);
  }

  if (args.dryRun) {
    const sample = rows.slice(0, Math.min(3, rows.length));
    const events = sample.flatMap((row) => eventsForUser(row, logbookStats.get(row.id)));
    console.info('--dry-run: not posting. Sample payload (first 3 users):');
    console.info(JSON.stringify({ api_key: '<redacted>', historical_migration: true, batch: events }, null, 2));
    await client.end();
    return;
  }

  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  const apiKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!apiKey) {
    console.error('NEXT_PUBLIC_POSTHOG_KEY is not set. Cannot post to PostHog.');
    await client.end();
    process.exit(1);
  }

  const batches = chunk(rows, BATCH_SIZE);
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const events = batch.flatMap((row) => eventsForUser(row, logbookStats.get(row.id)));
    await postBatch(host, apiKey, events);
    console.info(`Batch ${i + 1}/${batches.length}: ${batch.length} users → ${events.length} events posted.`);
    if (i < batches.length - 1) await sleep(INTER_BATCH_DELAY_MS);
  }

  await client.end();
  console.info(`Done. Backfilled ${rows.length} users.`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { runMigrations, MIGRATIONS } from '../../db/migrations';
import {
  clearDeadLetterRecoveryNotice,
  isRecoverableTransportDeadLetter,
  readDeadLetterRecoveryNotice,
  requeueTransportDeadLetters,
  setDeadLetterRecoveryNotice,
  DEAD_LETTER_RECOVERY_NOTICE_KEY,
  EDGE_404_LAST_ERROR_PREFIX,
  FETCH_TIMEOUT_LAST_ERROR,
} from '../dead-letter-recovery';
import { createTestDatabase, type TestSqliteDb } from '../../testing/sqlite-test-db';
import type { SqlRunResult, SqlValue } from '../../database';

// The two `last_error` values off the production rows, copied verbatim from the
// Sentry events named in issue #5335. The drainer stores `error.message`, so
// these ARE what sits in the column — not a paraphrase of it.
//
// BOARDSESH-HT: `extra.errorMessage = "Network request timed out"`.
const TIMEOUT_LAST_ERROR = 'Network request timed out';
// BOARDSESH-H8: graphql-request's ClientError message for the Railway edge 404
// (`x-railway-fallback: true`), truncated after the parts that matter — note
// that the real string continues with the whole request, variables included,
// which is why the matcher anchors at the start rather than searching.
const EDGE_404_LAST_ERROR =
  'GraphQL Error (Code: 404): {"response":{"status":404,"headers":{"map":{"server":"cloudflare",' +
  '"x-railway-fallback":"true"}},"body":"{\\"status\\":\\"error\\",\\"code\\":404,\\"message\\":' +
  '\\"Application not found\\"}"},"request":{"query":"mutation SaveTick($input: SaveTickInput!) ' +
  '{ saveTick(input: $input) { uuid } }","variables":{"input":{"uuid":"3a4205a3"}}}}';
// A server's permanent verdict on the payload, served with a real 4xx and no
// GraphQL `errors` array, so graphql-request falls back to the status wording.
// This row is the whole reason the matcher is narrow: reviving it would make the
// migration "replay everything in the bin". Note how little separates it from
// EDGE_404_LAST_ERROR above — one digit — which is the point of putting the
// status inside the anchored prefix.
const VALIDATION_400_LAST_ERROR =
  'GraphQL Error (Code: 400): {"response":{"status":400,"body":"Bad Request"},' +
  '"request":{"query":"mutation SaveTick"}}';
// The OTHER permanent verdict, and the one the field will mostly produce from
// now on: GraphQL answers "your input is invalid" with HTTP 200 and an `errors`
// array, so `ClientError.extractMessage` returns errors[0].message and the
// recorded string carries NO "GraphQL Error (Code: …)" prefix at all. The
// classifier this recovery ships behind reads `extensions.code` for exactly this
// shape, which is what puts these rows in the dead-letter bin — so the matcher
// has to reject a shape that looks nothing like either of the two it accepts.
const VALIDATION_200_BAD_USER_INPUT_LAST_ERROR =
  'climbedAt is required: {"response":{"status":200,"errors":[{"message":"climbedAt is required",' +
  '"extensions":{"code":"BAD_USER_INPUT"}}]},"request":{"query":"mutation SaveTick"}}';

const RECOVERY_MIGRATION_VERSION = 6;

let db: TestSqliteDb;

beforeEach(async () => {
  db = createTestDatabase();
});

afterEach(() => {
  db.close();
});

type SeedRow = {
  key: string;
  status: 'pending' | 'dead_letter';
  lastError: string | null;
  retryCount?: number;
};

/** Seeds the outbox directly, so a row can be planted in any state the field produced. */
async function seed(rows: SeedRow[]): Promise<void> {
  for (const row of rows) {
    await db.runAsync(
      `INSERT INTO pending_mutations (table_name, operation, payload, idempotency_key, retry_count, last_error, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        'boardsesh_ticks',
        'create',
        JSON.stringify({ climbUuid: row.key }),
        row.key,
        row.retryCount ?? 10,
        row.lastError,
        row.status,
      ],
    );
  }
}

async function rowByKey(key: string): Promise<{ status: string; retry_count: number; last_error: string | null }> {
  const row = await db.getFirstAsync<{ status: string; retry_count: number; last_error: string | null }>(
    'SELECT status, retry_count, last_error FROM pending_mutations WHERE idempotency_key = ?',
    [key],
  );
  if (row === null) throw new Error(`no row for ${key}`);
  return row;
}

/** Brings the schema up to the version just before the recovery migration. */
async function migrateToBeforeRecovery(): Promise<void> {
  const upTo = MIGRATIONS.filter((migration) => migration.version < RECOVERY_MIGRATION_VERSION);
  await db.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)',
  );
  for (const migration of upTo) {
    for (const statement of migration.statements) {
      await db.execAsync(statement);
    }
  }
  await db.runAsync('INSERT OR REPLACE INTO schema_version (id, version) VALUES (1, ?)', [
    RECOVERY_MIGRATION_VERSION - 1,
  ]);
}

// The array-form overload of SqlExecutor.runAsync — the only one the engine
// calls, so the interruption case can swap it for one that throws partway.
type PatchedRunAsync = (source: string, params: SqlValue[]) => Promise<SqlRunResult>;

function patchRunAsync(target: TestSqliteDb, replacement: PatchedRunAsync): void {
  (target as unknown as { runAsync: PatchedRunAsync }).runAsync = replacement;
}

async function storedSchemaVersion(): Promise<number | null> {
  const row = await db.getFirstAsync<{ version: number }>('SELECT version FROM schema_version WHERE id = 1');
  return row?.version ?? null;
}

describe('isRecoverableTransportDeadLetter', () => {
  it('matches the fetch timeout by whole-string equality', () => {
    expect(isRecoverableTransportDeadLetter(TIMEOUT_LAST_ERROR)).toBe(true);
    expect(isRecoverableTransportDeadLetter(`  ${TIMEOUT_LAST_ERROR}  `)).toBe(true);
  });

  it('matches the Railway edge 404 by its ClientError prefix', () => {
    expect(isRecoverableTransportDeadLetter(EDGE_404_LAST_ERROR)).toBe(true);
  });

  it('does NOT match a 400 the server decided on the payload', () => {
    expect(isRecoverableTransportDeadLetter(VALIDATION_400_LAST_ERROR)).toBe(false);
  });

  it('does NOT match a BAD_USER_INPUT the server answered over HTTP 200', () => {
    // The shape the revised classifier sends to the dead letter from now on. It
    // shares no prefix with either accepted shape, and must stay in the bin.
    expect(isRecoverableTransportDeadLetter(VALIDATION_200_BAD_USER_INPUT_LAST_ERROR)).toBe(false);
  });

  it('cannot be spelled into a match by request content echoed inside a ClientError', () => {
    // The 404 message embeds the whole request. A climber whose tick comment
    // says "Network request timed out" must not be able to talk a 400 rejection
    // into a replay — which is why the timeout is an equality match and the 404
    // an anchored prefix, never a substring search.
    const spoofed =
      'GraphQL Error (Code: 400): {"response":{"status":400},"request":{"variables":' +
      '{"comment":"Network request timed out","body":"Application not found"}}}';
    expect(isRecoverableTransportDeadLetter(spoofed)).toBe(false);
  });

  it('leaves every other recorded error alone, including none at all', () => {
    expect(isRecoverableTransportDeadLetter(null)).toBe(false);
    expect(isRecoverableTransportDeadLetter(undefined)).toBe(false);
    expect(isRecoverableTransportDeadLetter('')).toBe(false);
    expect(isRecoverableTransportDeadLetter('Network request failed')).toBe(false);
    expect(isRecoverableTransportDeadLetter('BLE write timed out waiting for the board')).toBe(false);
    expect(isRecoverableTransportDeadLetter('GraphQL Error (Code: 422): {}')).toBe(false);
  });

  it('keeps the two literals it matches on in sync with the exported constants', () => {
    expect(TIMEOUT_LAST_ERROR).toBe(FETCH_TIMEOUT_LAST_ERROR);
    expect(EDGE_404_LAST_ERROR.startsWith(EDGE_404_LAST_ERROR_PREFIX)).toBe(true);
  });
});

describe('requeueTransportDeadLetters', () => {
  beforeEach(async () => {
    await runMigrations(db);
  });

  it('requeues a fetch-timeout dead letter as pending with a fresh retry budget', async () => {
    await seed([{ key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR }]);

    expect(await requeueTransportDeadLetters(db)).toBe(1);

    expect(await rowByKey('timeout')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
  });

  it('requeues an edge-404 dead letter as pending with a fresh retry budget', async () => {
    await seed([{ key: 'edge404', status: 'dead_letter', lastError: EDGE_404_LAST_ERROR }]);

    expect(await requeueTransportDeadLetters(db)).toBe(1);

    expect(await rowByKey('edge404')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
  });

  it('leaves a dead letter the server permanently rejected exactly where it is', async () => {
    await seed([
      { key: 'validation400', status: 'dead_letter', lastError: VALIDATION_400_LAST_ERROR },
      { key: 'validation200', status: 'dead_letter', lastError: VALIDATION_200_BAD_USER_INPUT_LAST_ERROR },
    ]);

    expect(await requeueTransportDeadLetters(db)).toBe(0);

    expect(await rowByKey('validation400')).toEqual({
      status: 'dead_letter',
      retry_count: 10,
      last_error: VALIDATION_400_LAST_ERROR,
    });
    expect(await rowByKey('validation200')).toEqual({
      status: 'dead_letter',
      retry_count: 10,
      last_error: VALIDATION_200_BAD_USER_INPUT_LAST_ERROR,
    });
  });

  it('does not touch a row that is already pending', async () => {
    await seed([{ key: 'inflight', status: 'pending', lastError: TIMEOUT_LAST_ERROR, retryCount: 3 }]);

    expect(await requeueTransportDeadLetters(db)).toBe(0);

    expect(await rowByKey('inflight')).toEqual({
      status: 'pending',
      retry_count: 3,
      last_error: TIMEOUT_LAST_ERROR,
    });
  });

  it('requeues only the matching rows out of a mixed outbox', async () => {
    await seed([
      { key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR },
      { key: 'edge404', status: 'dead_letter', lastError: EDGE_404_LAST_ERROR },
      { key: 'validation400', status: 'dead_letter', lastError: VALIDATION_400_LAST_ERROR },
      { key: 'validation200', status: 'dead_letter', lastError: VALIDATION_200_BAD_USER_INPUT_LAST_ERROR },
      { key: 'noError', status: 'dead_letter', lastError: null },
      { key: 'inflight', status: 'pending', lastError: null, retryCount: 0 },
    ]);

    expect(await requeueTransportDeadLetters(db)).toBe(2);

    const remaining = await db.getAllAsync<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM pending_mutations WHERE status = 'dead_letter' ORDER BY idempotency_key",
    );
    expect(remaining.map((row) => row.idempotency_key)).toEqual(['noError', 'validation200', 'validation400']);
  });

  it('requeues nothing on a second run', async () => {
    await seed([{ key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR }]);

    expect(await requeueTransportDeadLetters(db)).toBe(1);
    expect(await requeueTransportDeadLetters(db)).toBe(0);
  });
});

describe('the recovery migration (version 6)', () => {
  it('requeues both shapes, leaves the 400 alone, and records the count once', async () => {
    await migrateToBeforeRecovery();
    await seed([
      { key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR },
      { key: 'edge404', status: 'dead_letter', lastError: EDGE_404_LAST_ERROR },
      { key: 'validation', status: 'dead_letter', lastError: VALIDATION_400_LAST_ERROR },
    ]);

    await runMigrations(db);

    expect(await rowByKey('timeout')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
    expect(await rowByKey('edge404')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
    expect((await rowByKey('validation')).status).toBe('dead_letter');
    expect(await readDeadLetterRecoveryNotice(db)).toBe(2);
  });

  it('records nothing when it requeues nothing — a fresh install owes no notice', async () => {
    await migrateToBeforeRecovery();
    await seed([{ key: 'validation', status: 'dead_letter', lastError: VALIDATION_400_LAST_ERROR }]);

    await runMigrations(db);

    expect(await readDeadLetterRecoveryNotice(db)).toBeNull();
    // Not merely unreadable — absent. Every install on earth runs this migration,
    // and none of them should be left holding a row that says "recovered 0".
    const noticeRows = await db.getAllAsync<{ key: string }>('SELECT key FROM sync_meta WHERE key = ?', [
      DEAD_LETTER_RECOVERY_NOTICE_KEY,
    ]);
    expect(noticeRows).toEqual([]);
  });

  it('is idempotent: a second launch requeues nothing and writes no second notice', async () => {
    await migrateToBeforeRecovery();
    await seed([{ key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR }]);

    await runMigrations(db);
    expect(await readDeadLetterRecoveryNotice(db)).toBe(1);
    // The climber has been told; the notice is consumed.
    await clearDeadLetterRecoveryNotice(db);

    // A row dead-lettered AFTER the recovery — by the same shape — must not be
    // swept up by a re-run, because there is no re-run: the version is stamped.
    await seed([{ key: 'later', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR }]);
    await runMigrations(db);

    expect((await rowByKey('later')).status).toBe('dead_letter');
    expect(await readDeadLetterRecoveryNotice(db)).toBeNull();
  });

  it('interrupted mid-run, every row is still pending or dead_letter and the migration re-runs', async () => {
    await migrateToBeforeRecovery();
    await seed([
      { key: 'timeout', status: 'dead_letter', lastError: TIMEOUT_LAST_ERROR },
      { key: 'edge404', status: 'dead_letter', lastError: EDGE_404_LAST_ERROR },
    ]);

    // Stands in for the app being killed after the first row moved: the write
    // that would have followed it throws instead, so the transaction unwinds
    // exactly where a process death would have left it.
    const originalRunAsync = db.runAsync.bind(db) as unknown as PatchedRunAsync;
    let requeueWrites = 0;
    const killAfterFirstRequeue: PatchedRunAsync = async (source, params) => {
      if (source.includes("SET status = 'pending'")) {
        requeueWrites += 1;
        if (requeueWrites > 1) throw new Error('app killed mid-migration');
      }
      return originalRunAsync(source, params);
    };
    patchRunAsync(db, killAfterFirstRequeue);

    await expect(runMigrations(db)).rejects.toThrow('app killed mid-migration');

    patchRunAsync(db, originalRunAsync);

    // No third state anywhere, and no half-recovery: the rollback took the one
    // moved row back with it.
    const statuses = await db.getAllAsync<{ idempotency_key: string; status: string }>(
      'SELECT idempotency_key, status FROM pending_mutations ORDER BY idempotency_key',
    );
    for (const row of statuses) {
      expect(['pending', 'dead_letter']).toContain(row.status);
    }
    expect(statuses).toEqual([
      { idempotency_key: 'edge404', status: 'dead_letter' },
      { idempotency_key: 'timeout', status: 'dead_letter' },
    ]);
    // The stamp rolled back with the rows, so the next launch tries again.
    expect(await storedSchemaVersion()).toBe(RECOVERY_MIGRATION_VERSION - 1);
    expect(await readDeadLetterRecoveryNotice(db)).toBeNull();

    await runMigrations(db);

    expect(await rowByKey('timeout')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
    expect(await rowByKey('edge404')).toEqual({ status: 'pending', retry_count: 0, last_error: null });
    expect(await readDeadLetterRecoveryNotice(db)).toBe(2);
  });
});

describe('the recovery notice', () => {
  beforeEach(async () => {
    await runMigrations(db);
  });

  it('reads back null once cleared, so it is shown once and never again', async () => {
    await setDeadLetterRecoveryNotice(db, 3);

    expect(await readDeadLetterRecoveryNotice(db)).toBe(3);
    await clearDeadLetterRecoveryNotice(db);
    expect(await readDeadLetterRecoveryNotice(db)).toBeNull();
  });

  it('reads a corrupt or non-positive value as no notice rather than crashing a launch', async () => {
    for (const stored of ['0', '-3', 'lots', '']) {
      await db.runAsync('INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)', [
        DEAD_LETTER_RECOVERY_NOTICE_KEY,
        stored,
      ]);
      expect(await readDeadLetterRecoveryNotice(db)).toBeNull();
    }
  });
});

import {
  beginImmediateWrite,
  bootstrapScopeFromSnapshot,
  configureMainConnection,
  ensureMutationQueueTable,
  isDatabaseLockedError,
  LATEST_SCHEMA_VERSION,
  OFFLINE_LOCAL_WRITE_BUDGET_MS,
  runMigrations,
  SNAPSHOT_MANIFEST_FORMAT_VERSION,
  stampLocalUserId,
  type OfflineDatabase,
  type SqlExecutor,
} from '@boardsesh/offline-sync';
import type { SaveTickInput, FavoriteInput } from '../../hooks/use-offline-mutations';

export const QA_USER_ID = 'offline-write-qa-user';
export const DEFAULT_IMPORT_ROWS = 369_000;
const WATERMARK = '2026-01-01T00:00:00.000Z';

export type QaPhase = 'contention' | 'prepare-reload' | 'verify-reload';
export type QaRequest = { runId: string; phase: QaPhase; rows: number; receiptPort?: number };
export type QaDatabase = OfflineDatabase & { databasePath: string; closeAsync(): Promise<void> };
export type WriteTrace = { site: string; stage: string; elapsedMs: number };
export type QaReceipt = {
  runId: string;
  phase: QaPhase;
  status: 'passed' | 'failed' | 'holding' | 'reloaded';
  runtimeId: string;
  databaseName: string;
  details?: Record<string, unknown>;
};
export type QaDependencies = {
  open: (name: string) => Promise<QaDatabase>;
  writeTick: (database: OfflineDatabase, input: SaveTickInput, tickUuid: string) => Promise<void>;
  addFavorite: (database: OfflineDatabase, input: FavoriteInput) => Promise<void>;
  favoriteKey: (input: FavoriteInput) => string;
  follow: (
    database: OfflineDatabase,
    userId: string,
    kind: 'user',
    identifier: string,
    follow: true,
  ) => Promise<unknown>;
  emit: (receipt: QaReceipt) => Promise<void>;
  runtimeId: string;
};

/** A filename can never escape the test namespace, even from an arbitrary deep link. */
export function parseQaRequest(params: Record<string, unknown>): QaRequest {
  if (typeof params.runId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(params.runId)) {
    throw new Error('runId must contain 1–64 letters, digits or hyphens');
  }
  if (!['contention', 'prepare-reload', 'verify-reload'].includes(String(params.phase))) {
    throw new Error('Unknown offline-write QA phase');
  }
  const rows = params.rows === undefined ? DEFAULT_IMPORT_ROWS : Number(params.rows);
  if (!Number.isSafeInteger(rows) || rows < 1_000 || rows > 500_000) {
    throw new Error('rows must be an integer between 1000 and 500000');
  }
  const receiptPort = params.receiptPort === undefined ? undefined : Number(params.receiptPort);
  if (receiptPort !== undefined && (!Number.isInteger(receiptPort) || receiptPort < 1024 || receiptPort > 65535)) {
    throw new Error('receiptPort must be an integer between 1024 and 65535');
  }
  return { runId: params.runId, phase: params.phase as QaPhase, rows, receiptPort };
}

export function qaDatabaseName(runId: string, suffix = 'reload'): string {
  // Validate again at the I/O boundary rather than trusting a caller's type assertion.
  parseQaRequest({ runId, phase: 'prepare-reload' });
  if (!['reload', 'fresh', 'partial', 'artifact', 'prolonged'].includes(suffix)) throw new Error('Unknown QA database');
  return `offline-write-qa-${runId}-${suffix}.db`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function tickInput(uuid: string): SaveTickInput {
  return {
    boardType: 'kilter',
    climbUuid: 'qa-climb-1',
    angle: 40,
    isMirror: false,
    status: 'send',
    attemptCount: 1,
    isBenchmark: false,
    comment: '',
    uuid,
    climbedAt: WATERMARK,
  };
}

async function initialize(database: QaDatabase): Promise<void> {
  await configureMainConnection(database);
  await ensureMutationQueueTable(database);
  await runMigrations(database);
  await stampLocalUserId(database, QA_USER_ID);
}

/** The oracle reads the persisted local row and its exact outbox key independently. */
export async function tickPair(database: SqlExecutor, uuid: string): Promise<{ ticks: number; mutations: number }> {
  const tick = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM boardsesh_ticks WHERE uuid = ?',
    [uuid],
  );
  const mutation = await database.getFirstAsync<{ count: number }>(
    'SELECT COUNT(*) AS count FROM pending_mutations WHERE idempotency_key = ?',
    [uuid],
  );
  return { ticks: tick?.count ?? 0, mutations: mutation?.count ?? 0 };
}

function assertPair(pair: { ticks: number; mutations: number }, count: number, label: string): void {
  assert(
    pair.ticks === count && pair.mutations === count,
    `${label}: expected ${count} tick and outbox rows, received ${JSON.stringify(pair)}`,
  );
}

/** Reopening must retain each favorite/follow row as well as its own queued operation. */
export async function verifyNonTickPairs(
  database: SqlExecutor,
  favoriteKey: QaDependencies['favoriteKey'],
): Promise<void> {
  for (const group of ['reconcile', 'batch']) {
    const favorite = { boardName: 'kilter', climbUuid: group === 'reconcile' ? 'qa-climb-1' : 'qa-climb-2', angle: 40 };
    const followingId = `qa-followed-${group}`;
    const expected = [
      {
        table: 'user_favorites',
        predicate: 'board_name = ? AND climb_uuid = ? AND angle = ? AND user_id = ?',
        params: [favorite.boardName, favorite.climbUuid, favorite.angle, QA_USER_ID],
        key: favoriteKey(favorite),
      },
      {
        table: 'user_follows',
        predicate: 'following_id = ? AND follower_id = ?',
        params: [followingId, QA_USER_ID],
        key: `add:user_follows:${followingId}`,
      },
    ];
    for (const pair of expected) {
      const local = await database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM ${pair.table} WHERE ${pair.predicate}`,
        pair.params,
      );
      const queued = await database.getFirstAsync<{ count: number }>(
        'SELECT COUNT(*) AS count FROM pending_mutations WHERE idempotency_key = ?',
        [pair.key],
      );
      assert(
        local?.count === 1 && queued?.count === 1,
        `Reopened ${group} ${pair.table}: local row and queued operation must both survive`,
      );
    }
  }
}

/** Track only statements that acquire/release a writer, never the enclosing ATTACH lifetime. */
function tracedDatabase(
  database: QaDatabase,
  site: string,
  trace: WriteTrace[],
  startedAt: number,
  onAcquired?: () => void,
): QaDatabase {
  const record = (stage: string) => {
    // Keep the initial reconciliation evidence as well as the latest cleanup.
    if (trace.length >= 500) trace.splice(100, 1);
    trace.push({ site, stage, elapsedMs: Date.now() - startedAt });
  };
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'withExclusiveTransactionAsync') {
        return async (task: (transaction: SqlExecutor) => Promise<void>) => {
          record('transaction-start');
          try {
            await target.withExclusiveTransactionAsync((transaction) =>
              task(
                new Proxy(transaction, {
                  get(executor, member, executorReceiver) {
                    if (member === 'execAsync')
                      return async (statement: string) => {
                        const acquiring = /^BEGIN (?:IMMEDIATE|EXCLUSIVE)$/i.test(statement.trim());
                        const releasing = /^(?:COMMIT|ROLLBACK)$/i.test(statement.trim());
                        if (acquiring) record('waiting');
                        if (releasing) record('cleanup-start');
                        await executor.execAsync(statement);
                        if (acquiring) {
                          record('acquired');
                          onAcquired?.();
                        }
                        if (releasing) record('released');
                      };
                    const method: unknown = Reflect.get(executor, member, executorReceiver);
                    return typeof method === 'function' ? method.bind(executor) : method;
                  },
                }),
              ),
            );
          } finally {
            record('transaction-settled');
          }
        };
      }
      const method: unknown = Reflect.get(target, property, receiver);
      return typeof method === 'function' ? method.bind(target) : method;
    },
  });
}

async function makeArtifact(database: QaDatabase, rows: number): Promise<void> {
  await initialize(database);
  // Synthetic catalogue at real Kilter row volume. Payload width is deliberately
  // reported as synthetic: this is not a substitute for a real-catalogue device test.
  await database.execAsync(`WITH RECURSIVE sequence(number) AS (
    SELECT 1 UNION ALL SELECT number + 1 FROM sequence WHERE number < ${rows}
  ) INSERT INTO board_climbs (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
    SELECT 'qa-climb-' || number, 'kilter', 1, 'Synthetic QA climb ' || number, 0, 1, '[10]', '${WATERMARK}', 1 FROM sequence`);
  await database.execAsync(`INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, updated_at, sync_seq)
    SELECT 'kilter', uuid, 40, 20, '${WATERMARK}', 1 FROM board_climbs`);
  await database.execAsync(`CREATE TABLE snapshot_meta (
    table_name TEXT PRIMARY KEY, watermark_updated_at TEXT NOT NULL, watermark_sync_seq TEXT NOT NULL,
    row_count INTEGER NOT NULL, built_at TEXT NOT NULL, schema_version INTEGER NOT NULL, format_version INTEGER NOT NULL)`);
  for (const tableName of ['board_climbs', 'board_climb_stats', 'sync_deletions']) {
    await database.runAsync('INSERT INTO snapshot_meta VALUES (?, ?, ?, ?, ?, ?, ?)', [
      tableName,
      WATERMARK,
      tableName === 'sync_deletions' ? '0' : '1',
      tableName === 'sync_deletions' ? 0 : rows,
      WATERMARK,
      LATEST_SCHEMA_VERSION,
      SNAPSHOT_MANIFEST_FORMAT_VERSION,
    ]);
  }
}

class QaCaseFailure extends Error {
  constructor(
    error: unknown,
    readonly evidence: Record<string, unknown>,
  ) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

async function runImportCase(
  request: QaRequest,
  dependencies: QaDependencies,
  filePath: string,
  partial: boolean,
): Promise<Record<string, unknown>> {
  const databaseName = qaDatabaseName(request.runId, partial ? 'partial' : 'fresh');
  let database = await dependencies.open(databaseName);
  const trace: WriteTrace[] = [];
  let failure: QaCaseFailure | undefined;
  let caseResult: Record<string, unknown> | undefined;
  let open = true;
  try {
    await initialize(database);
    if (partial) {
      await database.runAsync(
        `INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, is_draft, is_listed, compatible_size_ids, updated_at, sync_seq)
        VALUES ('qa-obsolete', 'kilter', 1, 'Synthetic obsolete climb', 0, 1, '[10]', ?, 1)`,
        [WATERMARK],
      );
      await database.runAsync(
        `INSERT INTO board_climb_stats
        (board_type, climb_uuid, angle, updated_at, sync_seq) VALUES ('kilter', 'qa-obsolete', 40, ?, 1)`,
        [WATERMARK],
      );
      // A partial previous import with overlapping rows and a stale local row.
      await database.runAsync('ATTACH DATABASE ? AS qa_seed', [filePath]);
      try {
        await database.execAsync(
          `INSERT INTO board_climbs SELECT * FROM qa_seed.board_climbs LIMIT ${Math.floor(request.rows / 2)}`,
        );
        await database.execAsync(
          `INSERT INTO board_climb_stats SELECT * FROM qa_seed.board_climb_stats LIMIT ${Math.floor(request.rows / 2)}`,
        );
      } finally {
        await database.execAsync('DETACH DATABASE qa_seed');
      }
    }
    const caseName = partial ? 'partial' : 'fresh';
    const startedAt = Date.now();
    let importing = true;
    const foreground: Promise<PromiseSettledResult<void>[]>[] = [];
    const groups = new Set<string>();
    const writes: { operation: string; elapsedMs: number; importActiveAtCompletion: boolean }[] = [];
    const measure = async (operation: string, task: () => Promise<unknown>) => {
      const writeStartedAt = Date.now();
      await task();
      writes.push({ operation, elapsedMs: Date.now() - writeStartedAt, importActiveAtCompletion: importing });
    };
    const startWrites = (group: 'reconcile' | 'batch') => {
      if (groups.has(group)) return;
      groups.add(group);
      const foregroundDatabase = tracedDatabase(database, `${group}-foreground`, trace, startedAt);
      const tickUuid = `qa-${caseName}-${group}-tick`;
      foreground.push(
        Promise.allSettled([
          measure(`${group}:tick`, () => dependencies.writeTick(foregroundDatabase, tickInput(tickUuid), tickUuid)),
          measure(`${group}:favorite`, () =>
            dependencies.addFavorite(foregroundDatabase, {
              boardName: 'kilter',
              climbUuid: group === 'reconcile' ? 'qa-climb-1' : 'qa-climb-2',
              angle: 40,
            }),
          ),
          measure(`${group}:follow`, () =>
            dependencies.follow(foregroundDatabase, QA_USER_ID, 'user', `qa-followed-${group}`, true),
          ),
        ]),
      );
    };
    let importResult;
    try {
      importResult = await bootstrapScopeFromSnapshot({
        db: tracedDatabase(database, 'snapshot', trace, startedAt, () => startWrites('reconcile')),
        scope: { boardType: 'kilter', layoutId: 1, sizeId: 10 },
        scopeKey: 'kilter:1:10',
        filePath,
        onBatch: () => startWrites('batch'),
      });
    } finally {
      importing = false;
      // Observe every contender even when import throws; no leaked promise or
      // close racing work that is still admitted to the native queue.
      await Promise.all(foreground);
    }
    assert(groups.size === 2, 'Import must exercise reconciliation and committed batches');
    const outcomes = (await Promise.all(foreground)).flat();
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    assert(writes.length === 6, 'All six foreground operations must complete');
    for (const write of writes)
      assert(write.elapsedMs <= OFFLINE_LOCAL_WRITE_BUDGET_MS, `${write.operation} exceeded the foreground budget`);
    for (const group of groups)
      assertPair(await tickPair(database, `qa-${caseName}-${group}-tick`), 1, `Contended ${group} tick`);
    const catalog = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM board_climbs');
    assert(catalog?.count === request.rows, 'Imported catalogue differs from artifact');
    const favorite = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM user_favorites');
    const follow = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM user_follows');
    assert(favorite?.count === 2 && follow?.count === 2, 'Favorite or follow was not persisted');
    await database.closeAsync();
    open = false;
    database = await dependencies.open(databaseName);
    open = true;
    for (const group of groups)
      assertPair(await tickPair(database, `qa-${caseName}-${group}-tick`), 1, `Reopened ${group} tick`);
    await verifyNonTickPairs(database, dependencies.favoriteKey);
    const outbox = await database.getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM pending_mutations');
    assert(outbox?.count === 6, 'Expected exactly six durable queued writes');
    caseResult = {
      databaseName,
      rows: request.rows,
      partialRows: partial ? Math.floor(request.rows / 2) : 0,
      elapsedMs: Date.now() - startedAt,
      writes,
      importResult,
      trace,
      reopenedOutboxRows: outbox.count,
    };
  } catch (error) {
    failure = new QaCaseFailure(error, { case: partial ? 'partial' : 'fresh', databaseName, trace });
  } finally {
    if (open) {
      try {
        await database.closeAsync();
      } catch (cleanupError) {
        const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        if (failure) failure.evidence.cleanupError = cleanup;
        else
          failure = new QaCaseFailure(cleanupError, {
            case: partial ? 'partial' : 'fresh',
            databaseName,
            trace,
            cleanupError: cleanup,
          });
      }
    }
  }
  if (failure) throw failure;
  assert(caseResult, 'Import case produced no result');
  return caseResult;
}

async function prolongedLock(request: QaRequest, dependencies: QaDependencies): Promise<Record<string, unknown>> {
  const databaseName = qaDatabaseName(request.runId, 'prolonged');
  const database = await dependencies.open(databaseName);
  let release: (() => void) | undefined;
  let holder: Promise<void> | undefined;
  try {
    await initialize(database);
    let acquired: (() => void) | undefined;
    const acquisition = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    holder = database.withExclusiveTransactionAsync(async (transaction) => {
      await beginImmediateWrite(transaction, 0);
      acquired?.();
      await released;
    });
    // Failure to acquire the fixture holder must reject instead of hanging.
    await Promise.race([acquisition, holder]);
    const startedAt = Date.now();
    let failure: unknown;
    try {
      await dependencies.writeTick(database, tickInput('qa-exhausted'), 'qa-exhausted');
    } catch (error) {
      failure = error;
    }
    const elapsedMs = Date.now() - startedAt;
    assert(isDatabaseLockedError(failure), 'Prolonged lock must report a genuine SQLite lock failure');
    assert(elapsedMs <= OFFLINE_LOCAL_WRITE_BUDGET_MS, 'Prolonged-lock failure exceeded the foreground budget');
    assertPair(await tickPair(database, 'qa-exhausted'), 0, 'Unacknowledged tick');
    release?.();
    await holder;
    await dependencies.writeTick(database, tickInput('qa-after-lock'), 'qa-after-lock');
    assertPair(await tickPair(database, 'qa-after-lock'), 1, 'Write after lock release');
    return { databaseName, elapsedMs, acknowledgedFailedWrite: false, newWriteSucceeded: true };
  } finally {
    release?.();
    if (holder) await holder.catch(() => {});
    await database.closeAsync();
  }
}

export async function runQaPhase(request: QaRequest, dependencies: QaDependencies): Promise<void> {
  const databaseName = qaDatabaseName(request.runId);
  const emit = async (status: QaReceipt['status'], details: Record<string, unknown>) =>
    dependencies.emit({
      runId: request.runId,
      phase: request.phase,
      status,
      runtimeId: dependencies.runtimeId,
      databaseName,
      details,
    });
  const startedAt = Date.now();
  try {
    if (request.phase === 'contention') {
      const artifact = await dependencies.open(qaDatabaseName(request.runId, 'artifact'));
      let filePath: string;
      try {
        await makeArtifact(artifact, request.rows);
        filePath = artifact.databasePath;
      } finally {
        await artifact.closeAsync();
      }
      const fresh = await runImportCase(request, dependencies, filePath, false);
      const partial = await runImportCase(request, dependencies, filePath, true);
      const prolonged = await prolongedLock(request, dependencies);
      await emit('passed', { elapsedMs: Date.now() - startedAt, syntheticCatalogue: true, fresh, partial, prolonged });
      return;
    }
    const database = await dependencies.open(databaseName);
    const runWithDatabase = async (): Promise<{
      status: 'passed' | 'reloaded';
      details: Record<string, unknown>;
    }> => {
      await initialize(database);
      if (request.phase === 'prepare-reload') {
        const prepared = await database.getFirstAsync<{ value: string }>(
          "SELECT value FROM sync_meta WHERE key = 'qa:prepared-runtime'",
        );
        if (prepared) {
          assert(prepared.value !== dependencies.runtimeId, 'This runtime already prepared the reload');
          return { status: 'reloaded', details: { previousRuntimeId: prepared.value } };
        }
        await dependencies.writeTick(database, tickInput('qa-committed'), 'qa-committed');
        assertPair(await tickPair(database, 'qa-committed'), 1, 'Committed baseline');
        await database.runAsync("INSERT INTO sync_meta (key, value) VALUES ('qa:prepared-runtime', ?)", [
          dependencies.runtimeId,
        ]);
        // Suspend the ACTUAL tick writer after its two INSERTs, before COMMIT.
        const heldDatabase = new Proxy(database, {
          get(target, property, receiver) {
            if (property === 'withExclusiveTransactionAsync')
              return async (task: (transaction: SqlExecutor) => Promise<void>) =>
                target.withExclusiveTransactionAsync(async (transaction) => {
                  await task(transaction);
                  assertPair(await tickPair(transaction, 'qa-interrupted'), 1, 'Interrupted pair before reload');
                  await emit('holding', {
                    committed: await tickPair(transaction, 'qa-committed'),
                    interrupted: await tickPair(transaction, 'qa-interrupted'),
                  });
                  // A timer would let a broken runtime teardown falsely pass. Only
                  // the host's real JS reload ends this fixture's writer lifetime.
                  await new Promise<void>(() => {});
                });
            const method: unknown = Reflect.get(target, property, receiver);
            return typeof method === 'function' ? method.bind(target) : method;
          },
        });
        await dependencies.writeTick(heldDatabase, tickInput('qa-interrupted'), 'qa-interrupted');
        throw new Error('Reload holder unexpectedly returned');
      }
      const prepared = await database.getFirstAsync<{ value: string }>(
        "SELECT value FROM sync_meta WHERE key = 'qa:prepared-runtime'",
      );
      assert(
        prepared && prepared.value !== dependencies.runtimeId,
        'Verification requires a different prepared JS runtime',
      );
      assertPair(await tickPair(database, 'qa-committed'), 1, 'Committed pair after reload');
      assertPair(await tickPair(database, 'qa-interrupted'), 0, 'Interrupted pair after reload');
      await dependencies.writeTick(database, tickInput('qa-after-reload'), 'qa-after-reload');
      assertPair(await tickPair(database, 'qa-after-reload'), 1, 'New pair after reload');
      return {
        status: 'passed',
        details: {
          previousRuntimeId: prepared.value,
          elapsedMs: Date.now() - startedAt,
          committed: await tickPair(database, 'qa-committed'),
          interrupted: await tickPair(database, 'qa-interrupted'),
          newWrite: await tickPair(database, 'qa-after-reload'),
        },
      };
    };
    let completion: Awaited<ReturnType<typeof runWithDatabase>> | undefined;
    let failure: QaCaseFailure | undefined;
    try {
      completion = await runWithDatabase();
    } catch (error) {
      failure = new QaCaseFailure(error, { case: request.phase, databaseName });
    }
    try {
      await database.closeAsync();
    } catch (cleanupError) {
      const cleanup = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      if (failure) failure.evidence.cleanupError = cleanup;
      else failure = new QaCaseFailure(cleanupError, { case: request.phase, databaseName, cleanupError: cleanup });
    }
    if (failure) throw failure;
    assert(completion, 'Reload case produced no result');
    await emit(completion.status, completion.details);
  } catch (error) {
    await emit('failed', {
      elapsedMs: Date.now() - startedAt,
      isLockError: isDatabaseLockedError(error),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof QaCaseFailure ? error.evidence : {}),
    });
  }
}

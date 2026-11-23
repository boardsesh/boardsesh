import type {
  OfflineWriteDeliveryReceipt,
  OfflineWriteEnqueueContext,
  OfflineWriteObservation,
  OfflineWriteState,
} from '@boardsesh/shared-schema';
import type { SqlExecutor } from '../database';

export type { OfflineWriteEnqueueContext };

/** No mutation payload or target identity is included in the upload shape. */
export const OFFLINE_WRITE_DELIVERY_SCHEMA = `
CREATE TABLE IF NOT EXISTS offline_write_delivery_journal (
  delivery_id TEXT PRIMARY KEY,
  mutation_id INTEGER NOT NULL UNIQUE,
  table_name TEXT NOT NULL,
  operation TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  connectivity_reason TEXT NOT NULL,
  origin_release TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  observed_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  uploaded_revision INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0,
  had_failure INTEGER NOT NULL DEFAULT 0,
  server_response_at TEXT,
  first_dead_letter_at TEXT,
  last_dead_letter_at TEXT,
  reconciled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_offline_write_delivery_unpublished
  ON offline_write_delivery_journal (uploaded_revision, revision, observed_at);
CREATE TRIGGER IF NOT EXISTS offline_write_delivery_enqueue
AFTER INSERT ON pending_mutations
WHEN NEW.delivery_id IS NOT NULL AND NEW.delivery_context IS NOT NULL
BEGIN
  INSERT INTO offline_write_delivery_journal (
    delivery_id, mutation_id, table_name, operation, queued_at, connectivity_reason,
    origin_release, target, observed_at
  ) VALUES (
    NEW.delivery_id, NEW.id, NEW.table_name, NEW.operation,
    json_extract(NEW.delivery_context, '$.queuedAt'),
    json_extract(NEW.delivery_context, '$.connectivityReason'),
    json_extract(NEW.delivery_context, '$.originRelease'),
    NEW.delivery_target, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  );
END;
CREATE TRIGGER IF NOT EXISTS offline_write_delivery_status
AFTER UPDATE OF status ON pending_mutations
WHEN OLD.status <> NEW.status AND NEW.delivery_id IS NOT NULL
BEGIN
  UPDATE offline_write_delivery_journal SET
    state = CASE WHEN NEW.status = 'dead_letter' THEN 'dead_letter' ELSE 'pending' END,
    observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revision = revision + 1,
    recovered = CASE WHEN OLD.status = 'dead_letter' AND NEW.status = 'pending' THEN 1 ELSE recovered END,
    first_dead_letter_at = CASE WHEN NEW.status = 'dead_letter'
      THEN COALESCE(first_dead_letter_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE first_dead_letter_at END,
    last_dead_letter_at = CASE WHEN NEW.status = 'dead_letter'
      THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_dead_letter_at END
  WHERE mutation_id = NEW.id;
END;
CREATE TRIGGER IF NOT EXISTS offline_write_delivery_finalize
AFTER DELETE ON pending_mutations
WHEN OLD.delivery_id IS NOT NULL
BEGIN
  UPDATE offline_write_delivery_journal SET
    state = CASE WHEN state IN ('superseded', 'discarded') THEN state
      WHEN OLD.status = 'dead_letter' THEN 'discarded' ELSE 'finalized' END,
    observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revision = revision + 1
  WHERE mutation_id = OLD.id;
END;
`;

/** Additive device-only schema; an old queue is not retroactively enrolled. */
export async function ensureOfflineWriteDeliveryJournal(db: SqlExecutor): Promise<void> {
  const columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(pending_mutations)');
  const columnNames = new Set(columns.map((column) => column.name));
  for (const columnName of ['delivery_id', 'delivery_context', 'delivery_target']) {
    if (!columnNames.has(columnName))
      await db.execAsync(`ALTER TABLE pending_mutations ADD COLUMN ${columnName} TEXT;`);
  }
  await db.execAsync(OFFLINE_WRITE_DELIVERY_SCHEMA);
}

/** Private device-only references needed to check actual local persistence. */
export function offlineWriteReconciliationTarget(
  tableName: string,
  operation: string,
  payload: Record<string, unknown>,
  idempotencyKey: string,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  for (const field of [
    'uuid',
    'boardType',
    'boardName',
    'climbUuid',
    'angle',
    'followingId',
    'setterUsername',
    'playlistUuid',
    'playlistId',
    'sessionId',
    'revision',
  ]) {
    if (typeof payload[field] === 'string' || typeof payload[field] === 'number') target[field] = payload[field];
  }
  if (operation === 'create' && (tableName === 'boardsesh_ticks' || tableName === 'playlists')) {
    target.uuid = idempotencyKey;
  }
  return target;
}

type JournalRow = {
  delivery_id: string;
  table_name: string;
  operation: OfflineWriteObservation['operation'];
  queued_at: string;
  connectivity_reason: OfflineWriteObservation['connectivityReason'];
  origin_release: string;
  state: OfflineWriteState;
  observed_at: string;
  revision: number;
  recovered: number;
  server_response_at: string | null;
  first_dead_letter_at: string | null;
  last_dead_letter_at: string | null;
  reconciled_at: string | null;
};

function boundedLimit(limit: number): number {
  return Math.max(1, Math.min(100, Number.isFinite(limit) ? Math.floor(limit) : 100));
}

export async function readOfflineWriteObservations(db: SqlExecutor, limit = 100): Promise<OfflineWriteObservation[]> {
  const rows = await db.getAllAsync<JournalRow>(
    `SELECT * FROM offline_write_delivery_journal WHERE uploaded_revision < revision
     ORDER BY observed_at, delivery_id LIMIT ?`,
    [boundedLimit(limit)],
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    tableName: row.table_name,
    operation: row.operation,
    queuedAt: row.queued_at,
    connectivityReason: row.connectivity_reason,
    originRelease: JSON.parse(row.origin_release) as OfflineWriteObservation['originRelease'],
    state: row.state,
    observedAt: row.observed_at,
    revision: row.revision,
    recovered: row.recovered === 1,
    serverResponseAt: row.server_response_at,
    firstDeadLetterAt: row.first_dead_letter_at,
    lastDeadLetterAt: row.last_dead_letter_at,
    reconciledAt: row.reconciled_at,
  }));
}

/** A late acknowledgement must never consume a newer local observation. */
export async function acknowledgeOfflineWriteObservations(
  db: SqlExecutor,
  receipts: ReadonlyArray<Pick<OfflineWriteDeliveryReceipt, 'deliveryId' | 'revision'>>,
): Promise<void> {
  for (const receipt of receipts.slice(0, 100)) {
    await db.runAsync(
      `UPDATE offline_write_delivery_journal SET uploaded_revision = ?
       WHERE delivery_id = ? AND revision = ? AND uploaded_revision < ?`,
      [receipt.revision, receipt.deliveryId, receipt.revision, receipt.revision],
    );
  }
}

/** Heartbeat unresolved entries only; observing silence never creates success. */
export async function touchOfflineWriteObservations(db: SqlExecutor, limit = 100): Promise<void> {
  await db.runAsync(
    `UPDATE offline_write_delivery_journal SET observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revision = revision + 1
     WHERE delivery_id IN (SELECT delivery_id FROM offline_write_delivery_journal
       WHERE state IN ('pending', 'dead_letter', 'finalized') ORDER BY observed_at, delivery_id LIMIT ?)`,
    [boundedLimit(limit)],
  );
}

export type OfflineWriteReconciliationCandidate = {
  deliveryId: string;
  tableName: string;
  operation: OfflineWriteObservation['operation'];
  target: Record<string, unknown>;
};

export async function readOfflineWriteReconciliationCandidates(
  db: SqlExecutor,
  limit = 100,
): Promise<OfflineWriteReconciliationCandidate[]> {
  const rows = await db.getAllAsync<{
    delivery_id: string;
    table_name: string;
    operation: OfflineWriteObservation['operation'];
    target: string;
  }>(
    `SELECT delivery_id, table_name, operation, target FROM offline_write_delivery_journal
     WHERE state = 'finalized' ORDER BY observed_at, delivery_id LIMIT ?`,
    [boundedLimit(limit)],
  );
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    tableName: row.table_name,
    operation: row.operation,
    target: JSON.parse(row.target) as Record<string, unknown>,
  }));
}

export async function reconcileOfflineWrite(db: SqlExecutor, deliveryId: string): Promise<void> {
  await db.runAsync(
    `UPDATE offline_write_delivery_journal SET state = 'reconciled', revision = revision + 1,
       observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE delivery_id = ? AND state = 'finalized'`,
    [deliveryId],
  );
}

/** Client response observation only. Server acceptance comes from the backend. */
export async function observeOfflineWriteServerResponse(db: SqlExecutor, mutationId: number): Promise<void> {
  await db.runAsync(
    `UPDATE offline_write_delivery_journal SET
       recovered = CASE WHEN had_failure = 1 OR server_response_at IS NOT NULL THEN 1 ELSE recovered END,
       server_response_at = COALESCE(server_response_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
       observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), revision = revision + 1
     WHERE mutation_id = ? AND (server_response_at IS NULL OR recovered = 0)`,
    [mutationId],
  );
}

/** Call in the same local transaction as the matching cancellation DELETE. */
export async function markOfflineWritesSuperseded(db: SqlExecutor, idempotencyKeys: readonly string[]): Promise<void> {
  for (const key of idempotencyKeys) {
    await db.runAsync(
      `UPDATE offline_write_delivery_journal SET state = 'superseded', revision = revision + 1,
         observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE mutation_id IN (SELECT id FROM pending_mutations WHERE idempotency_key = ?)
         AND state NOT IN ('superseded', 'discarded')`,
      [key],
    );
  }
}

/** Private retry history contains no error text or mutation payload. */
export async function observeOfflineWriteAttemptFailure(db: SqlExecutor, mutationId: number): Promise<void> {
  await db.runAsync(
    `UPDATE offline_write_delivery_journal SET had_failure = 1, revision = revision + 1,
       observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE mutation_id = ? AND had_failure = 0`,
    [mutationId],
  );
}

/** Record recovery only once the existing local retry ladder has succeeded. */
export async function observeOfflineWriteLocalRecovery(db: SqlExecutor, mutationId: number): Promise<void> {
  await db.runAsync(
    `UPDATE offline_write_delivery_journal SET recovered = 1, revision = revision + 1,
       observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE mutation_id = ? AND recovered = 0`,
    [mutationId],
  );
}

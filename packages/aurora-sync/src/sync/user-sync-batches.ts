import { isAuroraListedFalse } from './apply-user-logbook';
import { normalizeAuroraCircuitItems } from './circuit-arbitration';

const ROWS_PER_TRANSACTION = 100;

function* slices<Row>(rows: readonly Row[]): Generator<Row[]> {
  for (let offset = 0; offset < rows.length; offset += ROWS_PER_TRANSACTION) {
    yield rows.slice(offset, offset + ROWS_PER_TRANSACTION);
  }
}

/** Keep duplicate log IDs together so the applier still selects the last valid row. */
function* logbookBatches<Row extends Record<string, unknown>>(rows: readonly Row[]): Generator<Row[]> {
  const rowsById = new Map<string, Row[]>();
  for (const row of rows) {
    const id = String(row.uuid);
    const group = rowsById.get(id);
    if (group) group.push(row);
    else rowsById.set(id, [row]);
  }
  // Bound actual writes, rather than duplicate wire rows. The applier already
  // reduces each group to at most one live log entry before its SQL writes.
  for (const groups of slices([...rowsById.values()])) yield groups.flat();
}

/**
 * Write units for a fenced worker. A page can be arbitrarily large, but the
 * worker must release its run/queue locks often enough to renew its heartbeat.
 * The caller checkpoints only after every unit has committed.
 */
export function* userSyncWriteBatches<Row extends Record<string, unknown>>(
  tableName: string,
  rows: readonly Row[],
): Generator<Row[]> {
  if (tableName === 'ascents') {
    // The full-payload applier deletes every tombstone before it claims live
    // rows. Preserve that ordering across transactions too: a later tombstone
    // may release a native/JSON tick that an earlier live row should adopt.
    yield* slices(rows.filter((row) => isAuroraListedFalse(row.is_listed)));
    yield* logbookBatches(rows.filter((row) => !isAuroraListedFalse(row.is_listed)));
    return;
  }
  if (tableName === 'bids') {
    yield* logbookBatches(rows);
    return;
  }
  if (tableName === 'circuits') {
    // Normalize the COMPLETE page before slicing. Otherwise duplicate UUIDs
    // across boundaries could replace the same playlist several times. Keep
    // their wire rows together so existing accepted/rejected counters retain
    // their meaning; upsertTableData applies just the final normalized row.
    const { items } = normalizeAuroraCircuitItems(rows);
    const groups = new Map(items.map((item) => [item.uuid, [] as Row[]]));
    const rejected: Row[] = [];
    for (const row of rows) {
      const group = typeof row.uuid === 'string' ? groups.get(row.uuid) : undefined;
      if (group) group.push(row);
      else rejected.push(row);
    }
    // One circuit remains atomic: its source, owner and replacement climb list
    // must never become visible separately. Large lists use the writer's bulk
    // inserts; splitting one list would require a separate staging protocol.
    for (const group of groups.values()) yield group;
    yield* slices(rejected);
    return;
  }
  yield* slices(rows);
}

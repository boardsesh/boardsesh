import { useQuery } from '@tanstack/react-query';
import { getDatabaseHandle } from '../db';

/**
 * Counts this device's ticks for a climb that have NOT yet reached the server —
 * i.e. a local `boardsesh_ticks` row whose uuid is still sitting in
 * `pending_mutations` as an un-drained `boardsesh_ticks` write. Once the
 * mutation drains, the queue row is deleted and the count drops to 0.
 *
 * Read-only, additive visibility for the logbook: it never replaces the
 * server-derived send/attempt counts, it just surfaces writes that are still in
 * flight (e.g. queued while offline).
 *
 * Resilience: it reads the module-level database handle published by
 * `initializeDatabase` (the SQLiteProvider `onInit`) rather than
 * `useSQLiteContext()`, so the hook is safe to call from a component rendered
 * outside a `<SQLiteProvider>` (tests, isolated previews). When no handle exists
 * yet — or any query fails — it resolves to 0 and the caller renders exactly as
 * it would without local data.
 */
export function useLocalPendingTicks(climbUuid: string, boardType: string) {
  return useQuery({
    queryKey: ['localTicks', climbUuid, boardType],
    // Never refetch on its own; the mutation drainer invalidates ['localTicks']
    // explicitly once a tick reaches the server (see drainer.ts invalidateForTable).
    staleTime: Infinity,
    enabled: climbUuid.length > 0 && boardType.length > 0,
    queryFn: async (): Promise<number> => {
      const db = getDatabaseHandle();
      if (!db) return 0;

      const row = await db.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM boardsesh_ticks t
         JOIN pending_mutations m ON m.idempotency_key = t.uuid
         WHERE t.climb_uuid = ?
           AND t.board_type = ?
           AND m.table_name = 'boardsesh_ticks'`,
        [climbUuid, boardType],
      );

      return row?.count ?? 0;
    },
  });
}

import type { OfflineDatabase, readOfflineWriteReconciliationCandidates } from '@boardsesh/offline-sync';
import { getPreference } from '../lib/preference-store';

type Candidate = Awaited<ReturnType<typeof readOfflineWriteReconciliationCandidates>>[number];

/** Check committed storage, never the optimistic query cache or an empty outbox alone. */
export async function hasOfflineWriteLocalProof(
  db: OfflineDatabase,
  candidate: Candidate,
  ownerUserId: string,
): Promise<boolean> {
  const { tableName, operation, target } = candidate;
  const exists = async (query: string, parameters: (string | number)[]) =>
    (await db.getFirstAsync<{ found: number }>(query, parameters)) != null;
  const stringField = (name: string) => (typeof target[name] === 'string' ? (target[name] as string) : null);
  const uuid = stringField('uuid');
  if (tableName === 'boardsesh_ticks' && uuid) {
    // Check SQLite after finalization. The outbox-only fallback cannot pass
    // until the canonical pull actually creates its missing logbook row.
    const present = await exists('SELECT 1 AS found FROM boardsesh_ticks WHERE uuid = ? AND user_id = ?', [
      uuid,
      ownerUserId,
    ]);
    if (operation !== 'delete') return present;
    return !(await exists('SELECT 1 AS found FROM boardsesh_ticks WHERE uuid = ?', [uuid]));
  }
  if (tableName === 'board_climbs' && uuid && stringField('boardType')) {
    return exists('SELECT 1 AS found FROM board_climbs WHERE uuid = ? AND board_type = ? AND sync_seq > 0', [
      uuid,
      stringField('boardType')!,
    ]);
  }
  if (tableName === 'user_favorites') {
    const boardName = stringField('boardName');
    const climbUuid = stringField('climbUuid');
    if (!boardName || !climbUuid || typeof target.angle !== 'number') return false;
    const present = await exists(
      'SELECT 1 AS found FROM user_favorites WHERE board_name = ? AND climb_uuid = ? AND angle = ? AND user_id = ?',
      [boardName, climbUuid, target.angle, ownerUserId],
    );
    return operation === 'delete' ? !present : present;
  }
  const follow = {
    user_follows: ['following_id', 'followingId'],
    setter_follows: ['setter_username', 'setterUsername'],
    playlist_follows: ['playlist_uuid', 'playlistUuid'],
  } as const;
  if (tableName in follow) {
    const [column, field] = follow[tableName as keyof typeof follow];
    const identifier = stringField(field);
    if (!identifier) return false;
    const present = await exists(`SELECT 1 AS found FROM ${tableName} WHERE ${column} = ? AND follower_id = ?`, [
      identifier,
      ownerUserId,
    ]);
    return operation === 'delete' ? !present : present;
  }
  if (tableName === 'session_workouts') {
    const sessionId = stringField('sessionId');
    if (!sessionId || typeof target.revision !== 'number') return false;
    // Run storage is asynchronous. Reading persisted preferences, rather than
    // its in-memory store, avoids claiming reconciliation before persistence.
    for (const key of ['boardsesh_workout_run_v1', 'boardsesh_workout_run_v2', 'boardsesh_ended_workouts_v1']) {
      const stored = await getPreference<unknown>(key);
      if (!stored || typeof stored !== 'object') continue;
      const object = stored as Record<string, unknown>;
      const records = Array.isArray(object.records) ? object.records : [object];
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const workout = record as Record<string, unknown>;
        if (
          workout.sessionId === sessionId &&
          typeof workout.revision === 'number' &&
          workout.revision >= target.revision &&
          (!Array.isArray(object.records) || workout.userId === ownerUserId)
        )
          return true;
      }
    }
  }
  // Dormant/legacy handlers without a local proof stay explicitly unknown.
  return false;
}

import type { GetTicksQueryResponse } from '@boardsesh/graphql/operations';
import type { GetTicksInput } from '@boardsesh/shared-schema';
import type { SqlExecutor } from '@boardsesh/offline-sync';
import { readTickRowsLocal } from './get-climb-ticks-local';

/** Local-only knowledge; the pinned GraphQL document does not select this. */
export type LocalTicksQueryResponse = {
  ticks: Array<GetTicksQueryResponse['ticks'][number] & { climbRevision?: number | null }>;
};

/**
 * Offline GET_TICKS, using the same query and twin collapse as the drawer's
 * local display rows. User-data sync is independent of board downloads.
 *
 * The server treats an absent OR empty climbUuids array as no climb filter.
 * Social counts and model grades do not exist in the tick mirror; zero/null
 * are intentional offline defaults. Online reads must keep using the server.
 */
export async function getTicksLocal(
  db: SqlExecutor,
  input: GetTicksInput,
  viewerId: string,
): Promise<LocalTicksQueryResponse | null> {
  const rows = await readTickRowsLocal(
    db,
    input.boardType,
    input.climbUuids?.length ? input.climbUuids : undefined,
    viewerId,
  );
  if (rows === null) return null;
  rows.sort((left, right) => Date.parse(right.climbed_at) - Date.parse(left.climbed_at));
  return {
    ticks: rows.map((row) => ({
      uuid: row.uuid,
      climbUuid: row.climb_uuid,
      angle: row.angle,
      isMirror: row.is_mirror === 1,
      status: row.status,
      attemptCount: row.attempt_count ?? 1,
      quality: row.quality,
      effectiveQuality: row.quality,
      difficulty: row.difficulty,
      boardseshDifficulty: null,
      boardseshConfidence: null,
      isBenchmark: row.is_benchmark === 1,
      comment: row.comment ?? '',
      climbedAt: row.climbed_at,
      ...(row.revision_known ? { climbRevision: row.climb_revision } : {}),
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
    })),
  };
}

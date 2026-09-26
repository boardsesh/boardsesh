// Similar climbs, answered from the downloaded board instead of Postgres.
//
// Mirrors the server's `findSimilarClimbs` (backend climb-similarity.ts):
// Jaccard over DISTINCT hold ids (roles ignored), same board + layout, only
// published, listed, not-hidden, single-frame climbs, the target itself
// excluded, Woods scoped to one wall size, a final threshold filter, and
// `jaccard DESC, ascents DESC, uuid` ordering.
//
// The hold overlap comes from the device-derived holds index
// (`@boardsesh/offline-sync` holds-index): `getHoldSet` for the target and
// `findSimilarClimbCandidates` for the scored candidates. The index knows
// nothing about frames_count, size scope or stats, so one SQL read of the
// candidate rows applies those, and the ordering is finished here in JS.

import {
  findSimilarClimbCandidates,
  getHoldSet,
  type HoldRowParser,
  type OfflineDatabase,
  type SimilarClimbCandidate,
} from '@boardsesh/offline-sync';
import type { SimilarClimb } from '@boardsesh/shared-schema';
import { getGradeLabel } from '../../lib/grade-label';
import { parseCharacteristics, parseCompatibleSizeIds } from './search-climbs-local';

export const DEFAULT_SIMILAR_THRESHOLD = 0.5;
export const DEFAULT_SIMILAR_LIMIT = 12;
/** The server's cap on `limit`. */
const MAX_SIMILAR_LIMIT = 200;
/**
 * Candidates to score before the board_climbs predicates run. The index
 * helper returns up to 4× what it is asked for; asking for at least 100 keeps
 * a strip full on Woods, where the other wall's climbs share hold ids and can
 * take many of the top slots before the size filter drops them.
 */
const MIN_CANDIDATE_REQUEST = 100;
/** Ids per `IN (...)` list, under SQLite's 999 bind floor. */
const IN_LIST_BATCH = 900;

/**
 * Boards whose sizes reuse the same hold ids, so a comparison must stay on one
 * wall. The server's `isSizeScopedSimilarityBoard`: Woods only. Every other
 * board derives `compatible_size_ids` from a bounding box, and a climb that fits
 * several sizes legitimately compares across them.
 */
function isSizeScopedSimilarityBoard(boardType: string): boolean {
  return boardType === 'woods';
}

export type SimilarClimbsLocalInput = {
  boardType: string;
  layoutId: number;
  sizeId?: number | null;
  climbUuid?: string | null;
  /** Hold set for a climb that is not saved yet. Ignored when `climbUuid` is given. */
  frames?: string | null;
  excludeClimbUuid?: string | null;
  angle?: number | null;
  threshold?: number | null;
  limit?: number | null;
};

type CandidateRow = {
  uuid: string;
  name: string | null;
  setter_username: string | null;
  angle: number | null;
  layout_id: number;
  frames: string | null;
  compatible_size_ids: string | null;
  characteristics: string | null;
  quality_average: number | null;
  ascensionist_count: number | null;
  display_difficulty: number | null;
};

async function targetHoldIdsFor(
  db: OfflineDatabase,
  input: SimilarClimbsLocalInput,
  parseHoldRows: HoldRowParser,
): Promise<number[]> {
  if (input.climbUuid) {
    const indexed = await getHoldSet(db, input.climbUuid);
    if (indexed && indexed.length > 0) return indexed.map(({ holdId }) => holdId);
    // Not in the index: a climb viewed from another size of the layout, one the
    // index does not hold (hidden, unlisted), or a build still running. Its
    // frames still say which holds it uses — the server has the same fallback.
    const row = await db.getFirstAsync<{ frames: string | null }>(
      'SELECT frames FROM board_climbs WHERE board_type = ? AND uuid = ?',
      [input.boardType, input.climbUuid],
    );
    return row?.frames ? parseHoldRows(input.boardType, row.frames).map(({ holdId }) => holdId) : [];
  }
  return input.frames ? parseHoldRows(input.boardType, input.frames).map(({ holdId }) => holdId) : [];
}

async function fetchCandidateRows(
  db: OfflineDatabase,
  input: SimilarClimbsLocalInput,
  uuids: string[],
  sizeId: number | null,
): Promise<Map<string, CandidateRow>> {
  const rowsByUuid = new Map<string, CandidateRow>();
  const sizeClause =
    sizeId === null
      ? ''
      : "AND EXISTS (SELECT 1 FROM json_each(COALESCE(c.compatible_size_ids, '[]')) WHERE value = ?)";
  for (let start = 0; start < uuids.length; start += IN_LIST_BATCH) {
    const batch = uuids.slice(start, start + IN_LIST_BATCH);
    const params: (string | number | null)[] = [input.angle ?? null, ...batch, input.boardType, input.layoutId];
    if (sizeId !== null) params.push(sizeId);
    const rows = await db.getAllAsync<CandidateRow>(
      `SELECT c.uuid, c.name, c.setter_username, c.angle, c.layout_id, c.frames,
              c.compatible_size_ids, c.characteristics,
              s.quality_average, s.ascensionist_count, s.display_difficulty
       FROM board_climbs c
       LEFT JOIN board_climb_stats s
         ON s.board_type = c.board_type AND s.climb_uuid = c.uuid AND s.angle = COALESCE(?, c.angle)
       WHERE c.uuid IN (${batch.map(() => '?').join(', ')})
         AND c.board_type = ? AND c.layout_id = ?
         AND c.is_draft = 0 AND c.is_listed = 1 AND COALESCE(c.is_hidden, 0) = 0
         AND c.frames_count = 1
         ${sizeClause}`,
      params,
    );
    for (const row of rows) rowsByUuid.set(row.uuid, row);
  }
  return rowsByUuid;
}

function compareRanked(
  left: { candidate: SimilarClimbCandidate; row: CandidateRow },
  right: { candidate: SimilarClimbCandidate; row: CandidateRow },
): number {
  return (
    right.candidate.jaccard - left.candidate.jaccard ||
    (right.row.ascensionist_count ?? 0) - (left.row.ascensionist_count ?? 0) ||
    (left.row.uuid < right.row.uuid ? -1 : left.row.uuid > right.row.uuid ? 1 : 0)
  );
}

/**
 * Climbs on the same layout that share holds with the target, in the
 * `SimilarClimb` shape the `similarClimbs` resolver returns.
 *
 * The holds index must already be built for the scope (`ensureHoldIndex`); an
 * unbuilt index reads as "no similar climbs", never as wrong ones.
 */
export async function getSimilarClimbsLocal(
  db: OfflineDatabase,
  input: SimilarClimbsLocalInput,
  parseHoldRows: HoldRowParser,
): Promise<SimilarClimb[]> {
  const threshold = Math.max(0, Math.min(1, input.threshold ?? DEFAULT_SIMILAR_THRESHOLD));
  const limit = Math.max(1, Math.min(MAX_SIMILAR_LIMIT, input.limit ?? DEFAULT_SIMILAR_LIMIT));
  const sizeId = isSizeScopedSimilarityBoard(input.boardType) ? (input.sizeId ?? null) : null;
  // Fail closed on Woods without a size, like the server: its two walls number
  // holds from 0, so an unscoped comparison reports unrelated climbs as twins.
  if (isSizeScopedSimilarityBoard(input.boardType) && sizeId === null) return [];

  const targetHoldIds = [...new Set(await targetHoldIdsFor(db, input, parseHoldRows))];
  if (targetHoldIds.length === 0) return [];

  const candidates = await findSimilarClimbCandidates(db, {
    boardType: input.boardType,
    layoutId: input.layoutId,
    targetHoldIds,
    threshold,
    excludeUuid: input.climbUuid ?? input.excludeClimbUuid ?? null,
    limit: Math.max(limit, MIN_CANDIDATE_REQUEST),
  });
  if (candidates.length === 0) return [];

  const rowsByUuid = await fetchCandidateRows(
    db,
    input,
    candidates.map(({ uuid }) => uuid),
    sizeId,
  );
  const excluded = new Set([input.climbUuid, input.excludeClimbUuid].filter((uuid): uuid is string => !!uuid));

  const ranked: { candidate: SimilarClimbCandidate; row: CandidateRow }[] = [];
  for (const candidate of candidates) {
    const row = rowsByUuid.get(candidate.uuid);
    if (!row || excluded.has(candidate.uuid) || candidate.jaccard < threshold) continue;
    ranked.push({ candidate, row });
  }
  ranked.sort(compareRanked);

  return ranked.slice(0, limit).map(({ candidate, row }) => {
    const difficultyName = getGradeLabel(row.display_difficulty === null ? null : Math.round(row.display_difficulty));
    return {
      uuid: row.uuid,
      name: row.name,
      setterUsername: row.setter_username,
      angle: row.angle,
      layoutId: row.layout_id,
      frames: row.frames,
      difficultyName: difficultyName || null,
      qualityAverage: row.quality_average,
      ascensionistCount: row.ascensionist_count,
      compatibleSizeIds: parseCompatibleSizeIds(row.compatible_size_ids) ?? [],
      characteristics: parseCharacteristics(row.characteristics),
      similarity: candidate.jaccard,
      sharedHoldCount: candidate.shared,
      candidateHoldCount: candidate.candidateSize,
      targetHoldCount: targetHoldIds.length,
    };
  });
}

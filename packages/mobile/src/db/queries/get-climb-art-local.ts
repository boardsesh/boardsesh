import type { SqlExecutor } from '@boardsesh/offline-sync';

/** What a climb row needs to draw the climb: its holds, layout and sizes. */
export type LocalClimbArt = {
  boardType: string;
  climbUuid: string;
  frames: string;
  layoutId: number;
  compatibleSizeIds: number[];
};

type ClimbArtRow = {
  board_type: string;
  uuid: string;
  frames: string | null;
  layout_id: number | null;
  compatible_size_ids: string | null;
};

/** `compatible_size_ids` is stored as a JSON array; anything else reads as no sizes. */
function parseSizeIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * The art of a few climbs from the catalogue on this phone, such as the three
 * rows of Home's projects shelf (#7691). A climb whose board is not downloaded,
 * or that has no frames or layout, is left out and its row draws no holds. A
 * draft is served only to the climber who set it, as the climb read does.
 */
export async function readClimbArtLocal(
  db: SqlExecutor,
  refs: ReadonlyArray<{ boardType: string; climbUuid: string }>,
  viewerId: string | null,
): Promise<LocalClimbArt[]> {
  if (refs.length === 0) return [];
  const pairs = refs.map(() => '(c.board_type = ? AND c.uuid = ?)').join(' OR ');
  const rows = await db.getAllAsync<ClimbArtRow>(
    `SELECT c.board_type, c.uuid, c.frames, c.layout_id, c.compatible_size_ids
     FROM board_climbs c
     WHERE (${pairs}) AND (COALESCE(c.is_draft, 0) = 0 OR c.user_id = ?)`,
    [...refs.flatMap((ref) => [ref.boardType, ref.climbUuid]), viewerId],
  );
  const art: LocalClimbArt[] = [];
  for (const row of rows) {
    if (!row.frames || row.layout_id === null) continue;
    art.push({
      boardType: row.board_type,
      climbUuid: row.uuid,
      frames: row.frames,
      layoutId: row.layout_id,
      compatibleSizeIds: parseSizeIds(row.compatible_size_ids),
    });
  }
  return art;
}

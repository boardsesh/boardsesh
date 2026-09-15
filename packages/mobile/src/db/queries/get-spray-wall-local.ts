import { assertLocalUserDataOwner, type OfflineDatabase } from '@boardsesh/offline-sync';

/**
 * The spray wall the device has mirrored for one layout, read from SQLite
 * (issue #5448).
 *
 * This is the no-signal half of the render path. Online, a wall's holds and
 * photo come from `sprayWallRenderData` and land in the in-memory registry
 * (`packages/mobile/src/lib/spray/spray-wall-registry.ts`, SW-07 / #5440); the
 * registry is memory only, so a cold launch in a basement has nothing to draw
 * from. `syncSprayWalls` puts the same payload on disk, and this reads it back.
 *
 * ## The auth-scoping contract (docs/offline-reads.md)
 *
 * A wall photograph is somebody's garage, so this read is gated harder than any
 * other board reference read, all three layers:
 *
 *  1. **Server.** `syncSprayWalls` applies the by-layout visibility rule, so a
 *     wall the climber may not see never lands in the local database at all.
 *     That is the layer that actually decides who has what.
 *  2. **Owner stamp.** Board reference data normally survives sign-out as a
 *     shared cache — correct for a Kilter catalogue, wrong for a private wall —
 *     so `spray_walls` is wiped with the user tables AND this reader refuses to
 *     serve unless the `local_user_id` stamp names the signed-in climber. A
 *     failed wipe (a locked database, a crash mid-sign-out) is exactly the case
 *     the stamp exists for. `unstamped` refuses too: there is no row here that a
 *     device with no known owner should hand out.
 *  3. **No row predicate is possible.** A wall carries no user column — its
 *     visibility is a join through `user_boards` and `gym_members` that only the
 *     server can evaluate — which is why layers 1 and 2 have to be strict. Same
 *     position `playlists` is in, and the same answer.
 *
 * Deliberately NOT gated on `isUserDataComplete`: that marker is about the user
 * tables having reached their tail, and a downloaded wall is board data. Gating
 * on it would refuse a wall that is fully on disk.
 */
export type LocalSprayWall = {
  layoutId: number;
  /** The `user_boards` uuid — the key the network queries take. */
  boardUuid: string;
  name: string | null;
  /** The canonical frame the holds' coordinates live in. Null before the first photo. */
  referenceWidth: number | null;
  referenceHeight: number | null;
  /** `SprayWallVersion.number` of the published version; null when nothing is published. */
  version: number | null;
  /** Private-bucket object key. The photo store names its file after this. */
  photoKey: string | null;
  /** Row-major 3x3 photo→canonical homography; null when the version had none. */
  homography: number[] | null;
  holds: LocalSprayHold[];
};

/** One hold in the wall's canonical frame, as `syncSprayWalls` emits it. */
export type LocalSprayHold = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  /**
   * Flat implicitly-closed ring in units of the hold's own radius — the
   * `@boardsesh/board-art-geometry` contract. Null for an untraced hold, which
   * the renderer draws as a plain ring at `r`.
   */
  outline: number[] | null;
};

type SprayWallRow = {
  layout_id: number;
  board_uuid: string | null;
  name: string | null;
  reference_width: number | null;
  reference_height: number | null;
  current_version_number: number | null;
  photo_key: string | null;
  holds: string | null;
  homography: string | null;
};

/**
 * Parse a JSON-TEXT column, answering `null` on anything that is not the shape
 * asked for.
 *
 * Every array column in the mirror is stored as a JSON string
 * (docs/sync-table-manifest.md), and a truncated or hand-edited row must degrade
 * to "no geometry" rather than throw on the draw path.
 */
function parseJsonArray(value: string | null): unknown[] | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toFiniteNumbers(values: unknown[] | null): number[] | null {
  if (!values) return null;
  const numbers = values.filter((entry): entry is number => typeof entry === 'number' && Number.isFinite(entry));
  return numbers.length === values.length ? numbers : null;
}

/**
 * Holds that survive the trip: a centre, a radius and — only if it is a clean
 * ring — an outline. A malformed entry is dropped rather than drawn, because a
 * hold at NaN is a hold the renderer paints somewhere nobody can tap.
 */
function parseHolds(value: string | null): LocalSprayHold[] {
  const entries = parseJsonArray(value);
  if (!entries) return [];
  const holds: LocalSprayHold[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    const { id, cx, cy, r } = candidate;
    if (
      typeof id !== 'number' ||
      typeof cx !== 'number' ||
      typeof cy !== 'number' ||
      typeof r !== 'number' ||
      !Number.isFinite(cx) ||
      !Number.isFinite(cy) ||
      !Number.isFinite(r)
    ) {
      continue;
    }
    holds.push({ id, cx, cy, r, outline: toFiniteNumbers(Array.isArray(candidate.outline) ? candidate.outline : null) });
  }
  return holds;
}

/**
 * The mirrored wall for `layoutId`, or `null` when there is none on disk, the
 * row is unreadable, or this device's rows belong to a different climber.
 *
 * Never throws: the caller is a render path with no second source, and a wall it
 * cannot read is a board it draws without a photo, not a crash.
 */
export async function getSprayWallLocal(
  db: OfflineDatabase,
  layoutId: number,
  currentUserId: string | null | undefined,
): Promise<LocalSprayWall | null> {
  if (!Number.isFinite(layoutId)) return null;
  if ((await assertLocalUserDataOwner(db, currentUserId)) !== 'ok') return null;

  const row = await db.getFirstAsync<SprayWallRow>(
    `SELECT layout_id, board_uuid, name, reference_width, reference_height,
            current_version_number, photo_key, holds, homography
     FROM spray_walls WHERE layout_id = ?`,
    [layoutId],
  );
  if (!row || !row.board_uuid) return null;

  return {
    layoutId: row.layout_id,
    boardUuid: row.board_uuid,
    name: row.name,
    referenceWidth: row.reference_width,
    referenceHeight: row.reference_height,
    version: row.current_version_number,
    photoKey: row.photo_key,
    homography: toFiniteNumbers(parseJsonArray(row.homography)),
    holds: parseHolds(row.holds),
  };
}

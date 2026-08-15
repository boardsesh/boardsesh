/**
 * Pure, DB-free helpers for the duplicate serial-number board consolidation
 * (issue #3407).
 *
 * The LED supplier reuses serial numbers, and a run of app bugs let a single
 * physical wall accumulate several active `user_boards` rows for the same
 * serial (all with identical board_type/layout/size/set_ids). The sticky
 * per-user serial pointers in `user_board_serials` then scatter across those
 * duplicates, so two climbers on the same wall land on different board pages.
 *
 * These helpers decide, without touching the database:
 *   - how to group active boards into per-serial clusters (and which clusters
 *     to skip because they hold genuinely different configs),
 *   - which board in a same-config cluster is the canonical survivor,
 *   - which loser donates gym/location metadata to the survivor, and
 *   - whether a board's name is a throwaway default we may overwrite.
 *
 * The DB script (`scripts/dedupe-serial-boards.ts`) owns all mutation.
 */

import { formatBoardDisplayName, normaliseSetIds } from '@boardsesh/board-config';

/**
 * The minimal board shape the grouping/selection helpers need. The script
 * hydrates these from the discovery query (counts LEFT JOINed in); tests build
 * them by hand.
 */
export type SerialBoardRow = {
  id: number;
  uuid: string;
  ownerId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  name: string;
  gymId: number | null;
  latitude: number | null;
  longitude: number | null;
  locationName: string | null;
  hideLocation: boolean;
  isUnlisted: boolean;
  isPublic: boolean;
  serialNumber: string;
  // Usage signals that drive canonical selection.
  climbEventCount: number;
  tickCount: number;
  followCount: number;
};

/**
 * A per-serial cluster of active boards. `configKey` is the shared config when
 * every board agrees; when boards disagree it is null and `skipReason` is set
 * so the script leaves the cluster untouched (a human must reconcile genuinely
 * different walls that happen to share a serial).
 */
export type SerialCluster = {
  serial: string;
  boards: SerialBoardRow[];
  configKey: string | null;
  skipReason: 'distinct-configs' | null;
};

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The identity of a board's climbing configuration. Two boards with the same
 * key are the same wall for merge purposes; a differing key means a distinct
 * config and disqualifies the cluster from automatic consolidation.
 *
 * set_ids are normalised via `normaliseSetIds` from `@boardsesh/board-config`
 * (deduped, numerically sorted) so order/whitespace differences don't split an
 * otherwise identical config into two keys.
 */
export function boardConfigKey(row: SerialBoardRow): string {
  return `${row.boardType}|${row.layoutId}|${row.sizeId}|${normaliseSetIds(row.setIds)}`;
}

/**
 * Group active boards into per-serial clusters. Only serials with more than one
 * active board become clusters. A cluster whose boards span more than one
 * distinct config key is flagged `skipReason: 'distinct-configs'` (configKey
 * null) so the caller reports and skips it instead of merging different walls.
 */
export function groupSerialClusters(rows: SerialBoardRow[]): SerialCluster[] {
  const boardsBySerial = new Map<string, SerialBoardRow[]>();
  for (const row of rows) {
    const existing = boardsBySerial.get(row.serialNumber) ?? [];
    existing.push(row);
    boardsBySerial.set(row.serialNumber, existing);
  }

  const clusters: SerialCluster[] = [];
  for (const [serial, boards] of boardsBySerial) {
    if (boards.length < 2) {
      continue;
    }

    const distinctConfigKeys = new Set(boards.map(boardConfigKey));
    const hasDistinctConfigs = distinctConfigKeys.size > 1;

    clusters.push({
      serial,
      boards,
      configKey: hasDistinctConfigs ? null : (distinctConfigKeys.values().next().value ?? null),
      skipReason: hasDistinctConfigs ? 'distinct-configs' : null,
    });
  }

  // Deterministic ordering so dry-run reports and --limit slices are stable.
  return clusters.sort((first, second) => first.serial.localeCompare(second.serial));
}

/**
 * Order boards best-first for canonical selection: most climb events, then most
 * ticks, then most follows, then lowest id. The board that sorts first is the
 * survivor everything else merges into.
 */
export function compareCanonicalBoards(first: SerialBoardRow, second: SerialBoardRow): number {
  if (first.climbEventCount !== second.climbEventCount) {
    return second.climbEventCount - first.climbEventCount;
  }
  if (first.tickCount !== second.tickCount) {
    return second.tickCount - first.tickCount;
  }
  if (first.followCount !== second.followCount) {
    return second.followCount - first.followCount;
  }
  return first.id - second.id;
}

/**
 * Pick the canonical survivor for a same-config cluster. If the cluster has an
 * already-public board, select only among those public rows; otherwise select
 * among the all-private cluster. Within that eligible pool: max
 * climbEventCount, tie→max tickCount, tie→max followCount, tie→lowest id.
 *
 * This keeps a private board private: a duplicate merge must never promote its
 * identity, name, or location merely because a less-used public duplicate
 * exists. Returns null for an empty board list (the caller guards clusters to
 * >1 board).
 */
export function chooseCanonicalBoard(cluster: SerialCluster): SerialBoardRow | null {
  const publicBoards = cluster.boards.filter((board) => board.isPublic);
  const eligibleBoards = publicBoards.length > 0 ? publicBoards : cluster.boards;
  return [...eligibleBoards].sort(compareCanonicalBoards)[0] ?? null;
}

/** Board losers (everything but the canonical), ordered best-first. */
export function loserBoards(cluster: SerialCluster, canonical: SerialBoardRow): SerialBoardRow[] {
  return cluster.boards.filter((board) => board.id !== canonical.id).sort(compareCanonicalBoards);
}

/**
 * True when a board's name is a throwaway default (e.g. "Kilter Board",
 * "Tension Board Original") that we may overwrite with a loser's more specific,
 * gym-branded name during a merge.
 *
 * Deliberately conservative: an exact, case-insensitive match against a short
 * per-board-type allow-list of the default names the app has historically
 * generated. Anything a setter or gym typed ("Movement Boulder — Kilter",
 * "Basecamp Tension 12x12") contains extra text and is treated as specific, so
 * we never clobber a human-chosen name. Real prod generic names are exactly
 * "Kilter Board", "Kilter Board Original", "Tension Board", and bare
 * "MoonBoard". MoonBoard version, Mini MoonBoard, and custom names are
 * deliberately specific.
 */
export function isGenericBoardName(name: string, boardType: string): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (boardType === 'moonboard') {
    return normalizedName === 'moonboard';
  }

  const display = formatBoardDisplayName(boardType);
  const genericNames = new Set([`${display} Board`, `${display} Board Original`].map((value) => value.toLowerCase()));
  return genericNames.has(normalizedName);
}

/**
 * Choose which loser donates gym/location metadata to the survivor: prefer a
 * loser with a gymId (a real gym association is the most valuable metadata),
 * then a system-owned catalog row, then the lowest id for determinism. Returns
 * null when there are no eligible losers.
 *
 * A public survivor may only accept metadata from a public loser. This keeps
 * private gym, coordinate, location-name, and board-name details private.
 */
export function chooseMetadataDonor(losers: SerialBoardRow[], publicOnly = false): SerialBoardRow | null {
  const eligibleLosers = publicOnly ? losers.filter((board) => board.isPublic) : losers;
  const withGym = eligibleLosers.filter((board) => board.gymId !== null);
  const donorPool = withGym.length > 0 ? withGym : eligibleLosers;

  const systemOwned = donorPool.filter((board) => board.ownerId === SYSTEM_USER_ID);
  const preferredPool = systemOwned.length > 0 ? systemOwned : donorPool;

  return [...preferredPool].sort((first, second) => first.id - second.id)[0] ?? null;
}

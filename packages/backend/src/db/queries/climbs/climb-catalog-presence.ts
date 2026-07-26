import { and, eq } from 'drizzle-orm';
import { boardClimbAliases, boardClimbs } from '@boardsesh/db/schema';
import { db } from '../../client';

/**
 * Whether a climb UUID is one the catalog has ever heard of.
 *
 * - `catalog` — a board_climbs row exists. The normal case: every UUID a client
 *   can hold comes from board_climbs (search, queue, playlists, and the offline
 *   snapshot are all projections of it), and saveClimb writes board_climbs in
 *   the same transaction that mints the UUID it returns.
 * - `alias`  — no board_climbs row, but board_climb_aliases knows the UUID. The
 *   Kilter dedup path deliberately folds duplicate catalog UUIDs into an alias
 *   row and writes NO board_climbs row for them (see the FK-asymmetry note on
 *   boardClimbAliases), so a tick can legitimately carry one. getLogbook already
 *   canonicalises these for display. NOT a data-quality problem.
 * - `unknown` — neither table has it. Nothing can render or count a tick here.
 */
export type ClimbCatalogPresence = 'catalog' | 'alias' | 'unknown';

/**
 * Resolve a (boardType, climbUuid) against the climb catalog.
 *
 * Two exact-match lookups on indexes that already exist — board_climbs_pkey
 * (PRIMARY KEY (uuid)) and board_climb_aliases_board_type_alias_uuid_pk
 * (PRIMARY KEY (board_type, alias_uuid)). The alias probe only runs when the
 * board_climbs probe misses, so the hot path is a single PK lookup.
 *
 * board_climbs.uuid alone is the PK, so the board_type predicate does nothing
 * for uniqueness — it is a correctness filter, not an index hint. A tick names
 * a (boardType, climbUuid) PAIR and board_climb_stats is keyed on that pair, so
 * a Kilter UUID arriving under boardType 'tension' has to resolve `unknown`
 * rather than quietly matching the Kilter row. The recompute's seed guard and
 * owner CTE filter on both columns for the same reason.
 *
 * Reads the PRIMARY, not dbRead, and that is the whole point: a climb published
 * seconds before the tick could still be in flight to a replica, and a lagging
 * replica would report a real climb as `unknown`. The tick saves either way, but
 * the false positive lands in the counter — and a counter that drifts off zero
 * for reasons that aren't real is worse than no counter, because #3942's "has it
 * held at zero?" question becomes unanswerable. One PK probe per tick on the
 * primary is a cheap price for a signal you can trust, and the call site overlaps
 * it with writes that already hit the primary anyway.
 */
export async function resolveClimbCatalogPresence(boardType: string, climbUuid: string): Promise<ClimbCatalogPresence> {
  const [climb] = await db
    .select({ uuid: boardClimbs.uuid })
    .from(boardClimbs)
    .where(and(eq(boardClimbs.uuid, climbUuid), eq(boardClimbs.boardType, boardType)))
    .limit(1);

  if (climb) return 'catalog';

  const [alias] = await db
    .select({ canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(and(eq(boardClimbAliases.boardType, boardType), eq(boardClimbAliases.aliasUuid, climbUuid)))
    .limit(1);

  return alias ? 'alias' : 'unknown';
}

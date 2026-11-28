// The redacted row the server sends in place of a catalogue climb its supplier
// withdrew, on a board whose `withdrawnCatalogClimbs` capability is 'hidden'
// (`syncClimbSelectList` in packages/backend/src/graphql/resolvers/sync/queries.ts).
// The uuid stays, so local ticks keep their climb. Everything that describes the
// climb is cleared: name '', holds, supplier route id and size membership NULL,
// is_listed false, is_hidden true. The ownership columns pass through, and a
// supplier row has none: user_id NULL, is_boardsesh_authored false.
//
// This is the device's one definition of that shape. The pull writer and the
// snapshot import read it here; the app reads it through the
// `@boardsesh/offline-sync/withdrawn-climb` entry point. The module has no
// imports, so it works the same under a test that mocks the package root.

/**
 * Mirror of `@boardsesh/board-config`'s `HIDDEN_WITHDRAWN_CLIMB_BOARD_NAMES`,
 * inlined so this zero-runtime-dependency package stays free of board-config, as
 * `isSizeScopedBoard` is in board-scope-sql.ts. The parity test lives in
 * packages/mobile/src/db/queries/__tests__/withdrawn-climb.test.ts.
 */
export const WITHDRAWN_TOMBSTONE_BOARD_TYPES: readonly string[] = ['quantum'];

// SQLite accepts an empty IN list (it is false), so this needs no special case.
const BOARD_TYPE_LIST = WITHDRAWN_TOMBSTONE_BOARD_TYPES.map((boardType) => `'${boardType}'`).join(', ');

/** Whether the server sends this board's withdrawn climbs as tombstones. Exact-case, like the SQL. */
export function boardHidesWithdrawnClimbs(boardType: unknown): boolean {
  return typeof boardType === 'string' && WITHDRAWN_TOMBSTONE_BOARD_TYPES.includes(boardType);
}

/** `board_type IN (...)` over {@link WITHDRAWN_TOMBSTONE_BOARD_TYPES}. */
export function withdrawnTombstoneBoardSql(prefix = ''): string {
  return `${prefix}board_type IN (${BOARD_TYPE_LIST})`;
}

/** A stored `board_climbs` row that is a withdrawal tombstone. */
export function withdrawnClimbTombstoneSql(prefix = ''): string {
  return `(${withdrawnTombstoneBoardSql(prefix)} AND ${prefix}is_listed = 0 AND ${prefix}is_hidden = 1
    AND ${prefix}is_boardsesh_authored = 0 AND ${prefix}user_id IS NULL
    AND ${prefix}controller_route_uuid IS NULL AND ${prefix}frames IS NULL)`;
}

/** A pulled `board_climbs` document that is a withdrawal tombstone. */
export function isWithdrawnClimbTombstone(document: Record<string, unknown>): boolean {
  return (
    boardHidesWithdrawnClimbs(document.board_type) &&
    document.is_listed === false &&
    document.is_hidden === true &&
    document.is_boardsesh_authored === false &&
    document.user_id === null &&
    document.controller_route_uuid === null &&
    document.frames === null
  );
}

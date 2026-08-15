import { describe, it, expect } from 'vite-plus/test';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as dbSchema from '@boardsesh/db/schema';

// #4012 asked whether the all-boards playlistClimbs join — `board_climbs.uuid =
// playlist_climbs.climb_uuid`, with no board_type predicate — can fan one
// playlist row into several page rows and break the `pageSize + 1` paging, and
// whether `playlist_climbs` should therefore start persisting `board_type`.
//
// It cannot, because `board_climbs.uuid` is the table's primary key: a uuid
// names at most one climb across every board, so the uuid-only join is already
// both unique and index-backed. That makes the extra column redundant today —
// but the argument rests entirely on the shape of the key. Should `board_climbs`
// ever move to a composite `(board_type, uuid)` primary key, the uuid-only joins
// in `resolvers/playlists/queries/playlist-climbs.ts` (and the resolvable-ref
// lookup in `reorderPlaylistClimb`) stop being safe — this test is what fails
// loudly at that moment, instead of the paging quietly going wrong.
describe('board_climbs uuid is a global primary key', () => {
  const tableConfig = getTableConfig(dbSchema.boardClimbs);

  it('declares uuid as a single-column primary key', () => {
    const uuidColumn = tableConfig.columns.find((column) => column.name === 'uuid');
    expect(uuidColumn).toBeDefined();
    expect(uuidColumn?.primary).toBe(true);
  });

  it('has no composite primary key that would scope uuid to a board', () => {
    expect(tableConfig.primaryKeys).toEqual([]);
    const otherPrimaryColumns = tableConfig.columns.filter((column) => column.primary && column.name !== 'uuid');
    expect(otherPrimaryColumns).toEqual([]);
  });
});

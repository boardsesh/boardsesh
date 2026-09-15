import { describe, it, expect } from 'vitest';

import { TABLE_CONFIGS, BOARD_DATA_TABLES, USER_DATA_TABLES } from '../table-config';

/**
 * Pins the two halves of the spray-wall sync contract that nothing else can
 * fail on (issue #5448): the `spray_walls` table definition, and the fact that
 * `board_climbs.missing_hold_count` was added WITHOUT a refresh revision.
 *
 * The second is the one worth a test. A `refreshRevision` bump is a one-line
 * change that looks tidy and costs every downloaded Kilter and Tension
 * catalogue a full re-crawl, to backfill a column that is NULL on all of them.
 * The reason it is safe to skip is written in table-config.ts; this is what
 * notices if someone bumps it anyway.
 */
describe('spray_walls sync definition', () => {
  const config = TABLE_CONFIGS.spray_walls;

  it('is per-board, so a wall syncs with the board scope it belongs to', () => {
    expect(config.isPerBoard).toBe(true);
    expect(BOARD_DATA_TABLES).toContain('spray_walls');
    expect(USER_DATA_TABLES).not.toContain('spray_walls');
  });

  it('cursors on (updated_at, sync_seq) and keys on layout_id', () => {
    expect(config.queryName).toBe('syncSprayWalls');
    expect(config.cursorColumn).toBe('updated_at');
    // Single segment, matching migration 0228's tombstone `record_id`
    // (`OLD.layout_id::text`). A composite key here would make every tombstone
    // the trigger already writes unparseable.
    expect(config.primaryKeyColumns).toEqual(['layout_id']);
  });

  it('mirrors exactly the columns the resolver emits', () => {
    expect([...config.localColumns]).toEqual([
      'layout_id',
      'board_uuid',
      'name',
      'reference_width',
      'reference_height',
      'current_version_number',
      'photo_key',
      'holds',
      'homography',
      'updated_at',
      'sync_seq',
    ]);
  });

  it('declares the presigned photo URL transient, and never stores it', () => {
    // The bucket is private and the signature lapses in fifteen minutes, so the
    // device takes the bytes and drops the URL. Declaring it is also what keeps
    // every pulled page from reporting schema drift for a field the resolver
    // sends on purpose.
    expect([...(config.transientColumns ?? [])]).toEqual(['photo_url']);
    expect(config.localColumns).not.toContain('photo_url');
  });
});

describe('captureOnDelete', () => {
  it('only names columns the table actually stores', () => {
    // The list is stringly typed and read straight into a SELECT, so a rename or
    // a typo would capture `undefined` for that field — and the only consumer,
    // the photo delete, would then quietly stop deleting anything. Checked for
    // every table rather than just `spray_walls`, so a second user is covered on
    // the day it is added.
    for (const [tableName, config] of Object.entries(TABLE_CONFIGS)) {
      for (const column of config.captureOnDelete ?? []) {
        expect(config.localColumns, `${tableName}.${column}`).toContain(column);
      }
    }
  });

  it('is declared for spray_walls, whose row is the only thing that names its photo', () => {
    expect([...(TABLE_CONFIGS.spray_walls.captureOnDelete ?? [])]).toEqual(['layout_id', 'photo_key']);
  });
});

describe('board_climbs.missing_hold_count', () => {
  const config = TABLE_CONFIGS.board_climbs;

  it('is synced', () => {
    expect(config.localColumns).toContain('missing_hold_count');
  });

  it('does NOT bump the refresh revision or join the refresh columns', () => {
    // Both assertions are the guard, not one: `refreshColumns` alone would make
    // a completed download's coverage depend on a field that is NULL for every
    // catalogue climb, and a `refreshRevision` bump would re-crawl every
    // downloaded catalogue to fetch it.
    expect(config.refreshRevision).toBe(1);
    expect(config.refreshColumns).toEqual(['is_hidden']);
  });
});

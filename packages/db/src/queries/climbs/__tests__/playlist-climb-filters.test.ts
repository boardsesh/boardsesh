import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS } from '@boardsesh/climb-filters';
import {
  PLAYLIST_FILTER_SCOPE,
  createClimbFilters,
  createPlaylistClimbFilters,
  onPlaylistActiveBoardSql,
  playlistBoardScopeConditions,
  type PlaylistActiveBoard,
  type PlaylistFilterParamKey,
  type PlaylistFilterParams,
} from '../create-climb-filters';

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment).sql;
// Placeholder numbers depend on where a fragment sits in a larger predicate.
const renderShape = (fragment: SQL) => render(fragment).replace(/\$\d+/g, '$?');

const kilterBoard: PlaylistActiveBoard = {
  boardName: 'kilter',
  layoutId: 1,
  sizeId: 10,
  setIds: [1, 20],
  angle: 40,
};

const USER_ID = 'user-1';

/**
 * One value per param that switches its filter on. Typed against every
 * `PlaylistFilterParamKey`, so a new search param fails to compile here until it
 * has a sample, and the loop below then checks its classification.
 */
const SAMPLE_VALUES: { [Key in PlaylistFilterParamKey]: PlaylistFilterParams[Key] } = {
  page: 2,
  pageSize: 50,
  sortBy: 'difficulty',
  sortOrder: 'asc',
  sortSeed: '42',
  gradeAccuracy: 0.1,
  minGrade: 12,
  maxGrade: 16,
  minRating: 2,
  minAscents: 3,
  name: 'crimp',
  settername: ['alex'],
  onlyFollowedAuthors: true,
  setternameSuggestion: 'al',
  onlyBenchmarks: true,
  onlyTallClimbs: true,
  onlyWideClimbs: true,
  onlyWithBetaVideos: true,
  holdsFilter: { hold_12: { ANY: 'include' } },
  hideAttempted: true,
  hideCompleted: true,
  showOnlyAttempted: true,
  showOnlyCompleted: true,
  minUserRating: 3,
  onlyRatedByMe: true,
  useMyGrades: true,
  onlyDrafts: true,
  onlyFavorited: true,
  projectsOnly: true,
  holdIntegrity: 'intact',
  crossAngleStats: true,
  gradeSource: 'boardsesh',
  boulders: true,
  routes: true,
  zoneBox: { edgeLeft: 0, edgeRight: 10, edgeBottom: 0, edgeTop: 10 },
  zoneMode: 'anyHold',
  onlyActiveBoard: true,
};

void describe('PLAYLIST_FILTER_SCOPE', () => {
  void it('has a sample for every classified param and a class for every sample', () => {
    assert.deepEqual(Object.keys(PLAYLIST_FILTER_SCOPE).sort(), Object.keys(SAMPLE_VALUES).sort());
  });

  for (const key of Object.keys(PLAYLIST_FILTER_SCOPE) as PlaylistFilterParamKey[]) {
    const scope = PLAYLIST_FILTER_SCOPE[key];
    void it(`${key} is applied as ${scope}`, () => {
      const filters = createPlaylistClimbFilters(kilterBoard, { [key]: SAMPLE_VALUES[key] }, USER_ID);
      if (scope === 'allRows') {
        assert.ok(filters.allRows.length > 0, `${key} should add an all-rows predicate`);
        assert.equal(filters.activeBoardOnly.length, 0, `${key} must not be held to the active board`);
      } else if (scope === 'activeBoardOnly') {
        assert.equal(filters.allRows.length, 0, `${key} must not apply to every row`);
        assert.equal(filters.activeBoardOnly.length, 1, `${key} should add one wrapped predicate`);
        const rendered = render(filters.activeBoardOnly[0]);
        assert.match(rendered, /"board_climbs"\."board_type" = \$\d+/, `${key} must be gated on the active board`);
      } else {
        assert.equal(filters.allRows.length, 0, `${key} (${scope}) must add nothing on its own`);
        assert.equal(filters.activeBoardOnly.length, 0, `${key} (${scope}) must add nothing on its own`);
        assert.equal(filters.hasFilters, false);
      }
    });
  }
});

void describe('createPlaylistClimbFilters: what a playlist view never applies', () => {
  void it('leaves out the listed / draft / hidden base rules, the size and set filters and the angle restriction', () => {
    const everyFilter: PlaylistFilterParams = { ...SAMPLE_VALUES, onlyDrafts: undefined };
    const filters = createPlaylistClimbFilters(kilterBoard, everyFilter, USER_ID);
    const rendered = [...filters.allRows, ...filters.activeBoardOnly].map(render).join('\n');
    assert.doesNotMatch(rendered, /"is_listed"/);
    assert.doesNotMatch(rendered, /"is_draft"/);
    assert.doesNotMatch(rendered, /"is_hidden"/);
    assert.doesNotMatch(rendered, /"missing_hold_count"/);
    assert.doesNotMatch(rendered, /"retired_by_reset"/);
    // The size and set scope appears ONLY inside the active-board gate.
    assert.doesNotMatch(filters.allRows.map(render).join('\n'), /compatible_size_ids|required_set_ids/);
  });

  void it('builds no predicate for a default view', () => {
    const filters = createPlaylistClimbFilters(kilterBoard, {}, USER_ID);
    assert.deepEqual(filters.allRows, []);
    assert.deepEqual(filters.activeBoardOnly, []);
    assert.equal(filters.needsStats, false);
    assert.equal(filters.personalGradeJoin, null);
    assert.equal(filters.hasFilters, false);
  });

  void it('treats both climb types as no filter', () => {
    const filters = createPlaylistClimbFilters(kilterBoard, { boulders: true, routes: true }, USER_ID);
    assert.equal(filters.hasFilters, false);
  });
});

void describe('createPlaylistClimbFilters: the active board', () => {
  void it('fails closed when an active-board filter is set without a complete active board', () => {
    for (const activeBoard of [null, { ...kilterBoard, layoutId: null }, { ...kilterBoard, angle: null }]) {
      const filters = createPlaylistClimbFilters(activeBoard, { hideCompleted: true, minGrade: 12 }, USER_ID);
      assert.deepEqual(filters.activeBoardOnly.map(render), ['false']);
      // The all-rows grade band still applies.
      assert.equal(filters.allRows.length, 1);
    }
  });

  void it('ignores the climber-only filters when signed out, with or without an active board', () => {
    const climberOnly: PlaylistFilterParams = {
      hideCompleted: true,
      onlyFavorited: true,
      onlyFollowedAuthors: true,
      minUserRating: 3,
      useMyGrades: true,
      minGrade: 12,
    };
    for (const activeBoard of [kilterBoard, null]) {
      const filters = createPlaylistClimbFilters(activeBoard, climberOnly);
      assert.deepEqual(filters.activeBoardOnly, []);
      assert.equal(filters.allRows.length, 1, 'only the grade band is left');
      assert.equal(filters.personalGradeJoin, null);
    }
  });

  void it('turns personal grades off without an active board, and on with one', () => {
    const params: PlaylistFilterParams = { useMyGrades: true, minGrade: 12 };
    assert.equal(createPlaylistClimbFilters(null, params, USER_ID).personalGradeJoin, null);
    assert.notEqual(createPlaylistClimbFilters(kilterBoard, params, USER_ID).personalGradeJoin, null);
  });

  void it('wraps every active-board filter in ONE predicate behind the board gate', () => {
    const filters = createPlaylistClimbFilters(
      kilterBoard,
      { hideCompleted: true, onlyTallClimbs: true, onlyFavorited: true },
      USER_ID,
    );
    assert.equal(filters.activeBoardOnly.length, 1);
    const rendered = render(filters.activeBoardOnly[0]);
    assert.match(rendered, /boardsesh_ticks/);
    assert.match(rendered, /user_favorites/);
    assert.match(rendered, /compatible_size_ids/);
  });

  void it('onlyActiveBoard alone is just the board gate', () => {
    const filters = createPlaylistClimbFilters(kilterBoard, { onlyActiveBoard: true }, USER_ID);
    assert.equal(render(filters.activeBoardOnly[0]), render(onPlaylistActiveBoardSql(kilterBoard)));
  });

  void it('reads the same predicates the Climbs search builds for the same params', () => {
    const params: PlaylistFilterParams = { minGrade: 12, maxGrade: 16, name: 'crimp', hideCompleted: true };
    const playlistFilters = createPlaylistClimbFilters(kilterBoard, params, USER_ID);
    const searchFilters = createClimbFilters(
      { board_name: 'kilter', layout_id: 1, size_id: 10, set_ids: [1, 20], angle: 40 },
      params,
      USER_ID,
    );
    const playlistSql = [...playlistFilters.allRows, ...playlistFilters.activeBoardOnly].map(renderShape).join('\n');
    for (const condition of [
      ...searchFilters.gradeRangeConditions,
      ...searchFilters.nameCondition,
      ...searchFilters.personalProgressConditions,
    ]) {
      assert.ok(playlistSql.includes(renderShape(condition)), `missing ${renderShape(condition)}`);
    }
  });
});

void describe('playlistBoardScopeConditions', () => {
  void it('skips the size scope on MoonBoard (one fixed size, NULL compatible_size_ids)', () => {
    const rendered = playlistBoardScopeConditions({ boardName: 'moonboard', layoutId: 7, sizeId: 1, setIds: [] })
      .map(render)
      .join(' AND ');
    assert.doesNotMatch(rendered, /compatible_size_ids/);
    assert.match(rendered, /"layout_id"/);
  });

  void it('tolerates a NULL required_set_ids and scopes size by containment elsewhere', () => {
    const rendered = playlistBoardScopeConditions({ boardName: 'kilter', layoutId: 1, sizeId: 10, setIds: [1, 20] })
      .map(render)
      .join(' AND ');
    assert.match(rendered, /"compatible_size_ids" @> ARRAY\[\$\d+\]::int\[\]/);
    assert.match(rendered, /"required_set_ids" IS NULL OR/);
  });

  void it('adds nothing for an unscoped board', () => {
    assert.deepEqual(
      playlistBoardScopeConditions({ boardName: 'kilter', layoutId: null, sizeId: null, setIds: [] }),
      [],
    );
  });
});

void describe('the active-board-only filters the app hides without a board', () => {
  void it('match the activeBoardOnly class here, so the app and the query cannot drift', () => {
    const activeBoardOnly = (Object.keys(PLAYLIST_FILTER_SCOPE) as PlaylistFilterParamKey[])
      .filter((key) => PLAYLIST_FILTER_SCOPE[key] === 'activeBoardOnly')
      .sort();
    assert.deepEqual([...PLAYLIST_ACTIVE_BOARD_ONLY_FILTERS].sort(), activeBoardOnly);
  });
});
